// Every community has a group chat, like a WhatsApp group: its active members
// and the owner write, everyone in it sees new messages as they arrive.
//
//   /community/<slug>/chat         the chat page (the community only)
//   /api/chat/<id>/messages        GET history (?since= changes, ?before= older), POST a message
//   /api/chat/<id>/socket          WebSocket: new messages, who is here, who is typing
//   /api/chat/messages/<id>        PATCH { body } (the writer) or { pinned } (anyone in it), DELETE
//   /api/chat/messages/<id>/post   POST: the message becomes a post on the community's blog,
//                                  where it gets comments; the owner may open it to everyone
//
// Messages live in D1 (chat_messages), so history survives. The live part is a
// Durable Object per community (src/chat-room.js) that holds the open sockets:
// after a write the worker hands it the message and it passes it on. Without
// the CHAT binding the page polls ?since= instead, so the chat still works.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText, checkOrigin } from './http.js';
import { escapeHtml as e, excerpt } from './markdown.js';
import { render, fmtDate } from './site.js';
import { knows, pathOf } from './communities.js';
import { communityBox } from './wings.js';
import { OWNER_NAME } from './comments.js';
import { cleanMentions } from './mentions.js';
import { addPost } from './blog.js';

export const CHAT = 'chat'; // the chat's address under a community; no post takes it
const MAX_BODY = 4000;
const PER_MINUTE = 40;
const PAGE = 80;

// ---------- who may do what ----------

// Inside the chat: the owner, and the community's active members.
export const inChat = (v, c) => Boolean(c) && (v.acc.owner || (Boolean(v.member) && v.acc.communities.has(c.id)));

function room(v, id) {
  const c = v.acc.commById.get(id);
  if (!knows(v.acc, c)) throw new HttpError(404, 'No such chat.');
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  if (!inChat(v, c)) throw new HttpError(403, 'This chat is open to its community only.');
  return c;
}

// The id a viewer goes by in the chat: a member's id, or "owner".
const meOf = (v) => (v.acc.owner ? 'owner' : v.member.id);
const isMine = (v, m) => (v.acc.owner ? m.userId === null : m.userId === v.member?.id);

// ---------- messages ----------

const SELECT = `SELECT m.*, u.display_name AS author_name,
  p.slug AS post_slug, p.public AS post_public, p.status AS post_status,
  (SELECT COUNT(*) FROM comments k WHERE k.entry_id = m.post_id) AS post_comments,
  r.body AS reply_body, r.deleted AS reply_deleted, r.user_id AS reply_user, COALESCE(ru.display_name, r.author) AS reply_author
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN posts p ON p.id = m.post_id
  LEFT JOIN chat_messages r ON r.id = m.reply_to
  LEFT JOIN users ru ON ru.id = r.user_id`;

function fromRow(r, c) {
  if (!r) return null;
  const deleted = Boolean(r.deleted);
  return {
    id: r.id,
    userId: r.user_id,
    author: r.user_id ? (r.author_name ?? r.author) : OWNER_NAME,
    body: deleted ? '' : r.body,
    deleted,
    pinned: Boolean(r.pinned) && !deleted,
    replyTo: r.reply_to,
    reply: r.reply_to
      ? { author: r.reply_user ? r.reply_author : OWNER_NAME, text: r.reply_deleted ? '' : excerpt(r.reply_body ?? '', 140), deleted: Boolean(r.reply_deleted) || r.reply_body == null }
      : null,
    post: r.post_slug && r.post_status === 'visible'
      ? { path: `${pathOf(c)}/${encodeURIComponent(r.post_slug)}`, public: Boolean(r.post_public), comments: r.post_comments ?? 0 }
      : null,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    changedAt: r.changed_at,
  };
}

async function oneMessage(env, c, id) {
  const d = await db(env);
  return fromRow(await d.prepare(`${SELECT} WHERE m.id = ?`).bind(id).first(), c);
}

async function history(env, c, { since, before } = {}) {
  const d = await db(env);
  if (since) {
    const { results } = await d
      .prepare(`${SELECT} WHERE m.community_id = ? AND m.changed_at >= ? ORDER BY m.changed_at, m.id LIMIT 300`)
      .bind(c.id, since)
      .all();
    return { messages: results.map((r) => fromRow(r, c)) };
  }
  const { results } = before
    ? await d.prepare(`${SELECT} WHERE m.community_id = ? AND m.created_at < ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).bind(c.id, before, PAGE + 1).all()
    : await d.prepare(`${SELECT} WHERE m.community_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).bind(c.id, PAGE + 1).all();
  const more = results.length > PAGE;
  const messages = results.slice(0, PAGE).reverse().map((r) => fromRow(r, c));
  if (before) return { messages, more };
  const { results: pins } = await d
    .prepare(`${SELECT} WHERE m.community_id = ? AND m.pinned = 1 AND m.deleted = 0 ORDER BY m.created_at`)
    .bind(c.id)
    .all();
  return { messages, more, pinned: pins.map((r) => fromRow(r, c)) };
}

// Pass a new or changed message (or anything else) to everyone connected.
async function broadcast(env, c, payload) {
  if (!env.CHAT) return;
  try {
    const stub = env.CHAT.get(env.CHAT.idFromName(c.id));
    await stub.fetch('https://chat.internal/broadcast', { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    console.error('chat broadcast', err);
  }
}

async function changed(env, c, id) {
  const message = await oneMessage(env, c, id);
  await broadcast(env, c, { type: 'message', message });
  return message;
}

// ---------- API ----------

export async function chatApi(request, env, url, v) {
  const path = url.pathname;
  const method = request.method;
  // The socket is a GET, but it is one a page on another site could open with our cookie.
  checkOrigin(request, url);

  const r = path.match(/^\/api\/chat\/([a-z0-9-]+)\/(messages|socket)$/);
  if (r) {
    const c = room(v, r[1]);
    if (r[2] === 'socket' && method === 'GET') return socket(request, env, url, v, c);
    if (r[2] === 'messages' && method === 'GET') {
      const since = url.searchParams.get('since');
      const before = url.searchParams.get('before');
      return json({ ...(await history(env, c, { since, before })), now: new Date().toISOString() });
    }
    if (r[2] === 'messages' && method === 'POST') return send(request, env, v, c);
  }
  const m = path.match(/^\/api\/chat\/messages\/([a-z0-9-]+)(\/post)?$/);
  if (m) {
    const msg = await own(env, v, m[1]);
    if (!m[2] && method === 'PATCH') return change(request, env, v, msg);
    if (!m[2] && method === 'DELETE') return remove(env, v, msg);
    if (m[2] && method === 'POST') return toPost(request, env, v, msg);
  }
  throw new HttpError(404, 'Not found.');
}

async function send(request, env, v, c) {
  const body = await readJson(request);
  const text = cleanText(body.body, MAX_BODY);
  if (!text) throw new HttpError(400, 'Write something first.');
  const d = await db(env);
  if (!v.acc.owner) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { n } = await d.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND created_at > ?').bind(v.member.id, since).first();
    if (n >= PER_MINUTE) throw new HttpError(429, 'That is a lot of messages for one minute. Take a breath.');
  }
  let replyTo = null;
  if (body.replyTo) {
    const target = await d.prepare('SELECT id FROM chat_messages WHERE id = ? AND community_id = ?').bind(String(body.replyTo), c.id).first();
    replyTo = target?.id ?? null;
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await d
    .prepare(
      `INSERT INTO chat_messages (id, community_id, user_id, author, body, reply_to, pinned, deleted, created_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    .bind(id, c.id, v.acc.owner ? null : v.member.id, v.acc.owner ? OWNER_NAME : v.member.displayName, text, replyTo, now, now)
    .run();
  return json(await changed(env, c, id), 201);
}

// The message, if this viewer is in its chat.
async function own(env, v, id) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const d = await db(env);
  const row = await d.prepare('SELECT id, community_id FROM chat_messages WHERE id = ?').bind(id).first();
  const c = row && v.acc.commById.get(row.community_id);
  if (!row || !inChat(v, c)) throw new HttpError(404, 'That message no longer exists.');
  return { c, m: await oneMessage(env, c, id) };
}

async function change(request, env, v, { c, m }) {
  const body = await readJson(request);
  if (m.deleted) throw new HttpError(404, 'That message was deleted.');
  const d = await db(env);
  const now = new Date().toISOString();
  if ('body' in body) {
    if (!isMine(v, m)) throw new HttpError(403, 'Only the writer can edit this message.');
    const text = cleanText(body.body, MAX_BODY);
    if (!text) throw new HttpError(400, 'Write something first.');
    await d.prepare('UPDATE chat_messages SET body = ?, edited_at = ?, changed_at = ? WHERE id = ?').bind(text, now, now, m.id).run();
  }
  if ('pinned' in body) {
    await d.prepare('UPDATE chat_messages SET pinned = ?, changed_at = ? WHERE id = ?').bind(body.pinned ? 1 : 0, now, m.id).run();
  }
  return json(await changed(env, c, m.id));
}

async function remove(env, v, { c, m }) {
  if (!v.acc.owner && !isMine(v, m)) throw new HttpError(403, 'Only the writer can delete this message.');
  const d = await db(env);
  const now = new Date().toISOString();
  await d.prepare(`UPDATE chat_messages SET deleted = 1, body = '', pinned = 0, changed_at = ? WHERE id = ?`).bind(now, m.id).run();
  return json(await changed(env, c, m.id));
}

// A message becomes a blog post, credited to whoever wrote it, so it can be
// read on its own and commented on. Members do it with their own messages; the
// owner with any, and only the owner opens a post to everyone.
async function toPost(request, env, v, { c, m }) {
  const body = await readJson(request);
  if (m.deleted) throw new HttpError(404, 'That message was deleted.');
  if (!v.acc.owner && !isMine(v, m)) throw new HttpError(403, 'Only the writer can make this message a post.');
  const d = await db(env);
  const open = v.acc.owner && Boolean(body.public);
  if (m.post) {
    // Already a post: the owner may still open it to everyone.
    if (open && !m.post.public) {
      await d.prepare('UPDATE posts SET public = 1 WHERE id = (SELECT post_id FROM chat_messages WHERE id = ?)').bind(m.id).run();
      await d.prepare('UPDATE chat_messages SET changed_at = ? WHERE id = ?').bind(new Date().toISOString(), m.id).run();
    }
    return json(await changed(env, c, m.id));
  }
  const firstLine = m.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const title = cleanText(body.title, 160) || (firstLine.length > 60 ? `${firstLine.slice(0, 57).trim()}…` : firstLine);
  const { text } = await cleanMentions(env, [c.id], m.body);
  const by = { userId: m.userId, author: m.author };
  const post = await addPost(env, v, c, title || 'מהצ׳אט', text, { open, by });
  await d.prepare('UPDATE chat_messages SET post_id = ?, changed_at = ? WHERE id = ?').bind(post.id, new Date().toISOString(), m.id).run();
  return json(await changed(env, c, m.id), 201);
}

// GET /api/chat/<id>/socket: hand the connection to the community's room.
async function socket(request, env, url, v, c) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'Expected a WebSocket.');
  if (!env.CHAT) throw new HttpError(503, 'Live chat is not available; polling.', { poll: true });
  const headers = new Headers(request.headers);
  headers.set('X-Chat-Room', c.id);
  headers.set('X-Chat-User', meOf(v));
  headers.set('X-Chat-Name', encodeURIComponent(v.acc.owner ? OWNER_NAME : v.member.displayName));
  const stub = env.CHAT.get(env.CHAT.idFromName(c.id));
  return stub.fetch(new Request(url.toString(), { headers }));
}

// ---------- pages ----------

const chatPath = (c) => `${pathOf(c)}/${CHAT}`;

// The way into the chat from the community's page, with its latest message.
export async function chatLink(env, c) {
  const d = await db(env);
  const last = await d
    .prepare(`SELECT m.body, m.user_id, m.created_at, COALESCE(u.display_name, m.author) AS name FROM chat_messages m
      LEFT JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1`)
    .bind(c.id)
    .first();
  const line = last
    ? `<span class="chat-last" dir="auto"><b>${e(last.user_id ? last.name : OWNER_NAME)}:</b> ${e(excerpt(last.body, 90))}</span>`
    : '<span class="chat-last">עוד אין הודעות. מי שכותב ראשון פותח את השיחה.</span>';
  return `<a class="chat-door" href="${chatPath(c)}">
  <span class="chat-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg></span>
  <span class="chat-what"><span class="chat-title">הצ׳אט של הקהילה</span>${line}</span>
  ${last ? `<time datetime="${e(last.created_at)}">${e(fmtDate(last.created_at))}</time>` : ''}
</a>`;
}

// JSON for a <script type="application/json"> block.
const safeJson = (data) => JSON.stringify(data).replace(/[<\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

export async function chatPage(env, v, c) {
  const path = chatPath(c);
  if (!inChat(v, c)) {
    const body = `<section class="band"><div class="wrap narrow">
  <div class="crumbs"><a href="/community">הקהילות</a> · <a href="${pathOf(c)}">${e(c.title)}</a></div>
  <h1 dir="auto">הצ׳אט של ${e(c.title)}</h1>
  <p class="lede">הצ׳אט פתוח רק למי שבקהילה.</p>
</div></section>
<div class="wrap narrow block">${communityBox(v, [c.id], path, { intro: 'הצ׳אט פתוח ל' }) || ''}${v.role === 'public' ? `<p class="actions"><a class="btn" href="/login?next=${encodeURIComponent(path)}">כניסה</a></p>` : ''}</div>`;
    return render(env, v, { title: `הצ׳אט של ${c.title}`, path, body, noindex: true, script: true });
  }
  const start = await history(env, c);
  const data = { room: c.id, me: meOf(v), owner: v.acc.owner, blog: pathOf(c), ...start, now: new Date().toISOString() };
  const body = `<div class="chat" data-chat>
  <header class="chat-head">
    <div class="wrap">
      <a class="chat-back" href="${pathOf(c)}" aria-label="חזרה לקהילה">→</a>
      <div class="chat-name">
        <h1 dir="auto">${e(c.title)}</h1>
        <p class="chat-status" data-status aria-live="polite">מתחבר…</p>
      </div>
    </div>
  </header>
  <section class="chat-pins" data-pins hidden aria-label="הודעות נעוצות"></section>
  <div class="chat-scroll" data-scroll>
    <div class="wrap">
      <p class="chat-more" data-more-wrap hidden><button class="btn small" type="button" data-more>הודעות קודמות</button></p>
      <ol class="chat-log" data-log aria-label="ההודעות"></ol>
      <p class="chat-empty" data-empty hidden>עוד אין כאן הודעות. בדיחה ראשונה?</p>
    </div>
  </div>
  <form class="chat-compose" data-compose>
    <div class="wrap">
      <div class="chat-replying" data-replying hidden><span dir="auto"></span><button type="button" class="link" data-cancel-reply aria-label="ביטול התגובה">✕</button></div>
      <div class="chat-row">
        <label class="sr-only" for="chat-text">הודעה</label>
        <textarea id="chat-text" name="body" rows="1" maxlength="${MAX_BODY}" dir="auto" placeholder="הודעה" enterkeyhint="send" required></textarea>
        <button class="chat-send" type="submit" aria-label="שליחה"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20l18-8L3 4l3 8-3 8z"/><path d="M6 12h15"/></svg></button>
      </div>
      <p class="msg" role="status" data-msg></p>
    </div>
  </form>
  <noscript><p class="wrap">הצ׳אט צריך JavaScript.</p></noscript>
</div>
<script type="application/json" id="chat-data">${safeJson(data)}</script>`;
  return render(env, v, { title: `הצ׳אט של ${c.title}`, path, body, noindex: true, script: true, scripts: ['/chat.js'], page: 'chat' });
}
