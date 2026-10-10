// Every community has a group chat, like a WhatsApp group: its active members
// and the owner write, everyone in it sees new messages as they arrive.
//
//   /community/<slug>/chat         the chat page (the community only)
//   /api/chat/<id>/messages        GET history (?since= changes, ?before= older), POST a message
//   /api/chat/<id>/socket          WebSocket: new messages, who is here, who is typing
//   /api/chat/messages/<id>        PATCH { body } (the writer), { pinned } or { starred } (anyone
//                                  who writes there), DELETE
//   /api/chat/messages/<id>/post   POST: the message becomes a post on the community's blog,
//                                  where it gets comments; the owner may open it to everyone
//   /api/chat/messages/<id>/hall   POST { character }: into that character's hall of fame;
//                                  DELETE .../hall/<characterId> takes it out again
//   /api/chat/<id>/members         GET who is in the chat and who may write;
//                                  PUT .../members/<userId> { role: 'write'|'read' } (the owner)
//   /api/chat/<id>/characters      GET the community's characters; POST { name, about } (the owner)
//   /api/chat/characters/<id>      PATCH { name?, about? }, DELETE (the owner)
//   /api/chat/rooms                GET the chats this viewer can send to (the site's "share" button)
//   /community/<slug>/hall         the halls of fame, one per character
//
// A message can carry a page of the site (share: { path, title, where }): the
// "שיתוף לקהילה" button on any page sends it into a chosen community's chat.
// A star marks a message for everyone; the starred ones are listed in the chat
// and on the community's page.
//
// Members either write or only read (community_members.chat_role). A message
// can be for some of the members only (audience: their ids); the writer and
// the owner see it too, nobody else learns it exists. A reply to such a
// message is for the same people.
//
// Messages live in D1 (chat_messages), so history survives. The live part is a
// Durable Object per community (src/chat-room.js) that holds the open sockets:
// after a write the worker hands it the message and it passes it on. Without
// the CHAT binding the page polls ?since= instead, so the chat still works.
import { db, WINGS } from './db.js';
import { HttpError, json, readJson, cleanText, checkOrigin } from './http.js';
import { escapeHtml as e, excerpt } from './markdown.js';
import { render, fmtDate } from './site.js';
import { knows, pathOf } from './communities.js';
import { communityBox } from './wings.js';
import { OWNER_NAME } from './comments.js';
import { cleanMentions } from './mentions.js';
import { addPost } from './blog.js';
import { onChat } from './push.js';

export const CHAT = 'chat'; // the chat's address under a community; no post takes it
export const HALL = 'hall'; // the halls of fame, likewise
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

// May this viewer see this message? (Messages for some members only.)
const canSee = (v, m) => v.acc.owner || !m.audience.length || isMine(v, m) || m.audience.includes(v.member?.id);

// Read-only members read; everyone else in the chat writes.
async function canWrite(env, v, c) {
  if (v.acc.owner) return true;
  const d = await db(env);
  const row = await d.prepare('SELECT chat_role FROM community_members WHERE community_id = ? AND user_id = ?').bind(c.id, v.member.id).first();
  return row?.chat_role !== 'read';
}

async function mustWrite(env, v, c) {
  if (!(await canWrite(env, v, c))) throw new HttpError(403, 'In this chat you can read but not write.');
}

// Who is in the chat (the owner first), with who may write.
async function members(env, c) {
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT u.id, u.display_name, m.chat_role FROM community_members m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.status = 'active' AND u.status = 'active' ORDER BY u.display_name`,
    )
    .bind(c.id)
    .all();
  return [{ id: 'owner', name: OWNER_NAME, role: 'write' }, ...results.map((r) => ({ id: r.id, name: r.display_name, role: r.chat_role === 'read' ? 'read' : 'write' }))];
}

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

const audienceOf = (r) => {
  try {
    const list = JSON.parse(r.audience || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

// ---------- messages ----------

const SELECT = `SELECT m.*, u.display_name AS author_name,
  p.slug AS post_slug, p.public AS post_public, p.status AS post_status,
  (SELECT COUNT(*) FROM comments k WHERE k.entry_id = m.post_id) AS post_comments,
  r.body AS reply_body, r.deleted AS reply_deleted, r.audience AS reply_audience, r.user_id AS reply_user, COALESCE(ru.display_name, r.author) AS reply_author,
  r.share AS reply_share,
  (SELECT json_group_array(json_object('id', ch.id, 'name', ch.name)) FROM hall_of_fame h
    JOIN community_characters ch ON ch.id = h.character_id WHERE h.message_id = m.id) AS hall_json
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN posts p ON p.id = m.post_id
  LEFT JOIN chat_messages r ON r.id = m.reply_to
  LEFT JOIN users ru ON ru.id = r.user_id`;

function fromRow(r, c) {
  if (!r) return null;
  const deleted = Boolean(r.deleted);
  const share = deleted ? null : parse(r.share, null);
  const replyShare = parse(r.reply_share, null);
  return {
    id: r.id,
    userId: r.user_id,
    author: r.user_id ? (r.author_name ?? r.author) : OWNER_NAME,
    body: deleted ? '' : r.body,
    deleted,
    pinned: Boolean(r.pinned) && !deleted,
    starred: Boolean(r.starred) && !deleted,
    share,
    hall: deleted ? [] : parse(r.hall_json, []).filter((x) => x && x.id),
    audience: audienceOf(r),
    replyTo: r.reply_to,
    reply: r.reply_to
      ? {
          author: r.reply_user ? r.reply_author : OWNER_NAME,
          text: r.reply_deleted ? '' : excerpt(r.reply_body || (replyShare ? `🔗 ${replyShare.title}` : ''), 140),
          deleted: Boolean(r.reply_deleted) || r.reply_body == null,
        }
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

async function history(env, v, c, { since, before } = {}) {
  const seen = (list) => list.map((r) => fromRow(r, c)).filter((m) => canSee(v, m));
  const d = await db(env);
  if (since) {
    const { results } = await d
      .prepare(`${SELECT} WHERE m.community_id = ? AND m.changed_at >= ? ORDER BY m.changed_at, m.id LIMIT 300`)
      .bind(c.id, since)
      .all();
    return { messages: seen(results) };
  }
  const { results } = before
    ? await d.prepare(`${SELECT} WHERE m.community_id = ? AND m.created_at < ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).bind(c.id, before, PAGE + 1).all()
    : await d.prepare(`${SELECT} WHERE m.community_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).bind(c.id, PAGE + 1).all();
  const more = results.length > PAGE;
  const messages = seen(results.slice(0, PAGE).reverse());
  if (before) return { messages, more };
  const [{ results: pins }, { results: stars }] = await Promise.all([
    d.prepare(`${SELECT} WHERE m.community_id = ? AND m.pinned = 1 AND m.deleted = 0 ORDER BY m.created_at`).bind(c.id).all(),
    d.prepare(`${SELECT} WHERE m.community_id = ? AND m.starred = 1 AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 200`).bind(c.id).all(),
  ]);
  return { messages, more, pinned: seen(pins), starred: seen(stars) };
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

// A message for some members only goes to them, its writer and the owner.
async function changed(env, c, id) {
  const message = await oneMessage(env, c, id);
  const to = message.audience.length ? [...new Set([...message.audience, message.userId ?? 'owner'])] : null;
  await broadcast(env, c, { type: 'message', message, to });
  return message;
}

// ---------- API ----------

export async function chatApi(request, env, url, v) {
  const path = url.pathname;
  const method = request.method;
  // The socket is a GET, but it is one a page on another site could open with our cookie.
  checkOrigin(request, url);

  if (path === '/api/chat/rooms' && method === 'GET') return json({ rooms: await rooms(env, v) });
  const r = path.match(/^\/api\/chat\/([a-z0-9-]+)\/(messages|socket|members|characters)$/);
  if (r) {
    const c = room(v, r[1]);
    if (r[2] === 'socket' && method === 'GET') return socket(request, env, url, v, c);
    if (r[2] === 'messages' && method === 'GET') {
      const since = url.searchParams.get('since');
      const before = url.searchParams.get('before');
      return json({ ...(await history(env, v, c, { since, before })), now: new Date().toISOString() });
    }
    if (r[2] === 'messages' && method === 'POST') return send(request, env, v, c);
    if (r[2] === 'members' && method === 'GET') return json({ members: await members(env, c) });
    if (r[2] === 'characters' && method === 'GET') return json({ characters: await characters(env, c) });
    if (r[2] === 'characters' && method === 'POST') return addCharacter(request, env, v, c);
  }
  const ch = path.match(/^\/api\/chat\/characters\/([a-z0-9-]+)$/);
  if (ch && (method === 'PATCH' || method === 'DELETE')) return changeCharacter(request, env, v, ch[1]);
  const mr = path.match(/^\/api\/chat\/([a-z0-9-]+)\/members\/([a-z0-9-]+)$/);
  if (mr && method === 'PUT') return setRole(request, env, v, room(v, mr[1]), mr[2]);
  const m = path.match(/^\/api\/chat\/messages\/([a-z0-9-]+)(\/post|\/hall(?:\/([a-z0-9-]+))?)?$/);
  if (m) {
    const msg = await own(env, v, m[1]);
    if (!m[2] && method === 'PATCH') return change(request, env, v, msg);
    if (!m[2] && method === 'DELETE') return remove(env, v, msg);
    if (m[2] === '/post' && method === 'POST') return toPost(request, env, v, msg);
    if (m[2] === '/hall' && method === 'POST') return toHall(request, env, v, msg);
    if (m[3] && method === 'DELETE') return outOfHall(env, v, msg, m[3]);
  }
  throw new HttpError(404, 'Not found.');
}

async function send(request, env, v, c) {
  const body = await readJson(request);
  const text = cleanText(body.body, MAX_BODY);
  const share = body.share ? cleanShare(body.share) : null;
  if (!text && !share) throw new HttpError(400, 'Write something first.');
  await mustWrite(env, v, c);
  const d = await db(env);
  if (!v.acc.owner) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { n } = await d.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND created_at > ?').bind(v.member.id, since).first();
    if (n >= PER_MINUTE) throw new HttpError(429, 'That is a lot of messages for one minute. Take a breath.');
  }
  // For some members only: ids of people in the chat ("owner" too, so a member
  // can write to the owner alone), never the writer.
  const self = meOf(v);
  const inside = new Set((await members(env, c)).map((m) => m.id));
  let audience = Array.isArray(body.audience)
    ? [...new Set(body.audience.map(String))].filter((id) => id !== self && inside.has(id)).slice(0, 100)
    : [];
  if (Array.isArray(body.audience) && body.audience.length && !audience.length) throw new HttpError(400, 'Pick who the message is for.');
  let replyTo = null;
  if (body.replyTo) {
    const row = await d.prepare(`${SELECT} WHERE m.id = ? AND m.community_id = ?`).bind(String(body.replyTo), c.id).first();
    const target = fromRow(row, c);
    if (target && canSee(v, target)) {
      replyTo = target.id;
      // A reply to a message for some members is for those same people.
      if (target.audience.length) {
        audience = [...new Set([...target.audience, target.userId ?? 'owner'].filter((id) => id !== self))];
        if (!audience.length) audience = [target.userId ?? 'owner'];
      }
    }
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await d
    .prepare(
      `INSERT INTO chat_messages (id, community_id, user_id, author, body, reply_to, audience, share, pinned, deleted, created_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    .bind(id, c.id, v.acc.owner ? null : v.member.id, v.acc.owner ? OWNER_NAME : v.member.displayName, text, replyTo, JSON.stringify(audience), share ? JSON.stringify(share) : null, now, now)
    .run();
  const message = await changed(env, c, id);
  await onChat(env, c, { ...message, body: textOf(message) }, chatPath(c));
  return json(message, 201);
}

// The message, if this viewer is in its chat.
async function own(env, v, id) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const d = await db(env);
  const row = await d.prepare('SELECT id, community_id FROM chat_messages WHERE id = ?').bind(id).first();
  const c = row && v.acc.commById.get(row.community_id);
  if (!row || !inChat(v, c)) throw new HttpError(404, 'That message no longer exists.');
  const m = await oneMessage(env, c, id);
  if (!canSee(v, m)) throw new HttpError(404, 'That message no longer exists.');
  return { c, m };
}

async function change(request, env, v, { c, m }) {
  const body = await readJson(request);
  if (m.deleted) throw new HttpError(404, 'That message was deleted.');
  await mustWrite(env, v, c);
  const d = await db(env);
  const now = new Date().toISOString();
  if ('body' in body) {
    if (!isMine(v, m)) throw new HttpError(403, 'Only the writer can edit this message.');
    const text = cleanText(body.body, MAX_BODY);
    if (!text && !m.share) throw new HttpError(400, 'Write something first.');
    await d.prepare('UPDATE chat_messages SET body = ?, edited_at = ?, changed_at = ? WHERE id = ?').bind(text, now, now, m.id).run();
  }
  if ('pinned' in body) {
    await d.prepare('UPDATE chat_messages SET pinned = ?, changed_at = ? WHERE id = ?').bind(body.pinned ? 1 : 0, now, m.id).run();
  }
  if ('starred' in body) {
    await d.prepare('UPDATE chat_messages SET starred = ?, changed_at = ? WHERE id = ?').bind(body.starred ? 1 : 0, now, m.id).run();
  }
  return json(await changed(env, c, m.id));
}

async function remove(env, v, { c, m }) {
  if (!v.acc.owner && !isMine(v, m)) throw new HttpError(403, 'Only the writer can delete this message.');
  const d = await db(env);
  const now = new Date().toISOString();
  await d.batch([
    d.prepare(`UPDATE chat_messages SET deleted = 1, body = '', share = NULL, pinned = 0, starred = 0, changed_at = ? WHERE id = ?`).bind(now, m.id),
    d.prepare('DELETE FROM hall_of_fame WHERE message_id = ?').bind(m.id),
  ]);
  return json(await changed(env, c, m.id));
}

// A message becomes a blog post, credited to whoever wrote it, so it can be
// read on its own and commented on. Members do it with their own messages; the
// owner with any, and only the owner opens a post to everyone.
async function toPost(request, env, v, { c, m }) {
  const body = await readJson(request);
  if (m.deleted) throw new HttpError(404, 'That message was deleted.');
  if (!v.acc.owner && !isMine(v, m)) throw new HttpError(403, 'Only the writer can make this message a post.');
  if (m.audience.length) throw new HttpError(400, 'This message is for some members only; it stays in the chat.');
  await mustWrite(env, v, c);
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
  const firstLine = m.body.split('\n').map((l) => l.trim()).find(Boolean) ?? m.share?.title ?? '';
  const title = cleanText(body.title, 160) || (firstLine.length > 60 ? `${firstLine.slice(0, 57).trim()}…` : firstLine);
  const { text: said } = await cleanMentions(env, [c.id], m.body);
  // A shared page stays a link in the post.
  const text = m.share ? `${said}${said ? '\n\n' : ''}[${m.share.title.replace(/[[\]]/g, '')}](${m.share.path})` : said;
  const by = { userId: m.userId, author: m.author };
  const post = await addPost(env, v, c, title || 'מהצ׳אט', text, { open, by });
  await d.prepare('UPDATE chat_messages SET post_id = ?, changed_at = ? WHERE id = ?').bind(post.id, new Date().toISOString(), m.id).run();
  return json(await changed(env, c, m.id), 201);
}

// ---------- pages shared into the chat ----------

// What a message says, in one line: its text, or the page it carries.
const textOf = (m) => m.body || (m.share ? `🔗 ${m.share.title}` : '');

// Which part of the site a path is in, for the label on the shared card.
function whereOf(path) {
  const first = decodeURIComponent(path.split(/[/?#]/)[1] ?? '');
  const wing = WINGS.find((w) => w.id === first);
  if (wing) return wing.title;
  return { community: 'קהילה', work: 'פרויקט', cv: 'קורות חיים', '': 'האתר' }[first] ?? 'האתר';
}

// { path, title } from the client: a page of this site, never another one.
function cleanShare(value) {
  const path = String(value?.path ?? '').trim();
  if (!/^\/(?![/\\])[A-Za-z0-9\-._~%!$&*+,;=:@/?#]{0,600}$/.test(path)) throw new HttpError(400, 'Only pages of this site can be shared.');
  const title = cleanText(String(value.title ?? '').replace(/\s+/g, ' '), 160) || 'עמוד באתר';
  return { path, title, where: whereOf(path) };
}

// GET /api/chat/rooms: the chats this viewer is in, for the share button.
async function rooms(env, v) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const list = v.acc.comms.filter((c) => inChat(v, c));
  const out = [];
  for (const c of list) out.push({ id: c.id, title: c.title, path: chatPath(c), canWrite: await canWrite(env, v, c) });
  return out;
}

// ---------- characters and their halls of fame ----------

// A community's characters: the people of its running jokes (its building
// blocks). Messages that capture one of them go in that character's hall of
// fame. The owner keeps the list of characters; anyone who writes in the chat
// may put a message in a hall, and take out what they put in.

const MAX_NAME = 60;
const MAX_ABOUT = 400;

async function characters(env, c) {
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT ch.*, (SELECT COUNT(*) FROM hall_of_fame h WHERE h.character_id = ch.id) AS n
       FROM community_characters ch WHERE ch.community_id = ? ORDER BY ch.sort, ch.created_at`,
    )
    .bind(c.id)
    .all();
  return results.map((r) => ({ id: r.id, name: r.name, about: r.about, count: r.n }));
}

async function charactersChanged(env, c) {
  const list = await characters(env, c);
  await broadcast(env, c, { type: 'characters', characters: list, to: null });
  return list;
}

// POST /api/chat/<id>/characters { name, about }
async function addCharacter(request, env, v, c) {
  if (!v.acc.owner) throw new HttpError(403, 'Only the owner adds characters.');
  const body = await readJson(request);
  const name = cleanText(body.name, MAX_NAME);
  if (!name) throw new HttpError(400, 'Give the character a name.');
  const d = await db(env);
  const same = await d.prepare('SELECT id FROM community_characters WHERE community_id = ? AND name = ?').bind(c.id, name).first();
  if (same) throw new HttpError(409, 'There is already a character by that name.');
  const { n } = await d.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM community_characters WHERE community_id = ?').bind(c.id).first();
  const id = crypto.randomUUID();
  await d
    .prepare('INSERT INTO community_characters (id, community_id, name, about, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, c.id, name, cleanText(body.about, MAX_ABOUT), n + 1, new Date().toISOString())
    .run();
  const list = await charactersChanged(env, c);
  return json({ character: list.find((x) => x.id === id), characters: list }, 201);
}

// PATCH / DELETE /api/chat/characters/<id>
async function changeCharacter(request, env, v, id) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const d = await db(env);
  const row = await d.prepare('SELECT * FROM community_characters WHERE id = ?').bind(id).first();
  const c = row && v.acc.commById.get(row.community_id);
  if (!row || !inChat(v, c)) throw new HttpError(404, 'No such character.');
  if (!v.acc.owner) throw new HttpError(403, 'Only the owner changes the characters.');
  if (request.method === 'DELETE') {
    // The messages stay in the chat; only their place in this hall goes.
    const { results } = await d.prepare('SELECT message_id FROM hall_of_fame WHERE character_id = ?').bind(id).all();
    await d.batch([
      d.prepare('DELETE FROM hall_of_fame WHERE character_id = ?').bind(id),
      d.prepare('DELETE FROM community_characters WHERE id = ?').bind(id),
    ]);
    for (const r of results) await touch(env, c, r.message_id);
    return json({ ok: true, characters: await charactersChanged(env, c) });
  }
  const body = await readJson(request);
  const name = 'name' in body ? cleanText(body.name, MAX_NAME) : row.name;
  if (!name) throw new HttpError(400, 'Give the character a name.');
  const about = 'about' in body ? cleanText(body.about, MAX_ABOUT) : row.about;
  await d.prepare('UPDATE community_characters SET name = ?, about = ? WHERE id = ?').bind(name, about, id).run();
  if (name !== row.name) {
    const { results } = await d.prepare('SELECT message_id FROM hall_of_fame WHERE character_id = ?').bind(id).all();
    for (const r of results) await touch(env, c, r.message_id);
  }
  return json({ ok: true, characters: await charactersChanged(env, c) });
}

// A message whose hall changed: a poll "since" and the live room see it again.
async function touch(env, c, messageId) {
  const d = await db(env);
  await d.prepare('UPDATE chat_messages SET changed_at = ? WHERE id = ?').bind(new Date().toISOString(), messageId).run();
  await changed(env, c, messageId);
}

// POST /api/chat/messages/<id>/hall { character }
async function toHall(request, env, v, { c, m }) {
  const body = await readJson(request);
  if (m.deleted) throw new HttpError(404, 'That message was deleted.');
  if (m.audience.length) throw new HttpError(400, 'This message is for some members only; it stays in the chat.');
  await mustWrite(env, v, c);
  const d = await db(env);
  const ch = await d.prepare('SELECT id FROM community_characters WHERE id = ? AND community_id = ?').bind(String(body.character ?? ''), c.id).first();
  if (!ch) throw new HttpError(404, 'No such character.');
  await d
    .prepare('INSERT OR IGNORE INTO hall_of_fame (character_id, message_id, community_id, added_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ch.id, m.id, c.id, meOf(v), new Date().toISOString())
    .run();
  await touch(env, c, m.id);
  await charactersChanged(env, c);
  return json(await oneMessage(env, c, m.id), 201);
}

// DELETE /api/chat/messages/<id>/hall/<characterId>: the owner, or whoever put it there.
async function outOfHall(env, v, { c, m }, characterId) {
  const d = await db(env);
  const row = await d.prepare('SELECT added_by FROM hall_of_fame WHERE character_id = ? AND message_id = ?').bind(characterId, m.id).first();
  if (!row) throw new HttpError(404, 'That message is not in this hall of fame.');
  if (!v.acc.owner && row.added_by !== meOf(v)) throw new HttpError(403, 'Only the owner, or whoever put it there, takes it out.');
  await d.prepare('DELETE FROM hall_of_fame WHERE character_id = ? AND message_id = ?').bind(characterId, m.id).run();
  await touch(env, c, m.id);
  await charactersChanged(env, c);
  return json(await oneMessage(env, c, m.id));
}

// PUT /api/chat/<id>/members/<userId> { role }: the owner decides who writes.
async function setRole(request, env, v, c, userId) {
  if (!v.acc.owner) throw new HttpError(403, 'Only the owner decides who writes here.');
  const { role } = await readJson(request);
  if (role !== 'write' && role !== 'read') throw new HttpError(400, 'role is write or read.');
  const d = await db(env);
  const r = await d.prepare(`UPDATE community_members SET chat_role = ? WHERE community_id = ? AND user_id = ? AND status = 'active'`).bind(role, c.id, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Not a member of this community.');
  await broadcast(env, c, { type: 'members', members: await members(env, c), to: null });
  return json({ ok: true, role });
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
    .prepare(`SELECT m.body, m.share, m.user_id, m.created_at, COALESCE(u.display_name, m.author) AS name FROM chat_messages m
      LEFT JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND m.deleted = 0 AND m.audience = '[]' ORDER BY m.created_at DESC LIMIT 1`)
    .bind(c.id)
    .first();
  const line = last
    ? `<span class="chat-last" dir="auto"><b>${e(last.user_id ? last.name : OWNER_NAME)}:</b> ${e(excerpt(textOf({ body: last.body, share: parse(last.share, null) }), 90))}</span>`
    : '<span class="chat-last">עוד אין הודעות. מי שכותב ראשון פותח את השיחה.</span>';
  return `<a class="chat-door" href="${chatPath(c)}">
  <span class="chat-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg></span>
  <span class="chat-what"><span class="chat-title">הצ׳אט של הקהילה</span>${line}</span>
  ${last ? `<time datetime="${e(last.created_at)}">${e(fmtDate(last.created_at))}</time>` : ''}
</a>`;
}

const STAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>';
const TROPHY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>';
const hallPath = (c) => `${pathOf(c)}/${HALL}`;

// On the community's page, under the chat: the latest starred messages and
// the way into the halls of fame.
export async function chatSide(env, c) {
  const d = await db(env);
  const [{ results: stars }, { n }] = await Promise.all([
    d
      .prepare(`SELECT m.id, m.body, m.share, m.user_id, COALESCE(u.display_name, m.author) AS name FROM chat_messages m
        LEFT JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND m.starred = 1 AND m.deleted = 0 AND m.audience = '[]'
        ORDER BY m.created_at DESC LIMIT 5`)
      .bind(c.id)
      .all(),
    d.prepare('SELECT COUNT(*) AS n FROM community_characters WHERE community_id = ?').bind(c.id).first(),
  ]);
  const starBox = stars.length
    ? `<section class="side-box stars"><h2>${STAR}מסומנות בכוכב</h2><ol>${stars
        .map((m) => `<li><a href="${chatPath(c)}#m-${e(m.id)}" dir="auto"><b>${e(m.user_id ? m.name : OWNER_NAME)}:</b> ${e(excerpt(textOf({ body: m.body, share: parse(m.share, null) }), 120))}</a></li>`)
        .join('')}</ol></section>`
    : '';
  const hall = `<a class="hall-door" href="${hallPath(c)}">${TROPHY}<span><b>היכל התהילה</b><small>${n ? (n === 1 ? 'דמות אחת' : `${n} דמויות`) : 'הדמויות של הקהילה'}</small></span></a>`;
  return `${hall}${starBox}`;
}

const lines = (text) => e(text).replace(/\n/g, '<br>');

// /community/<slug>/hall: every character, and the messages in its hall of fame.
export async function hallPage(env, v, c) {
  const path = hallPath(c);
  const crumbs = `<div class="crumbs"><a href="/community">הקהילות</a> · <a href="${pathOf(c)}">${e(c.title)}</a></div>`;
  if (!inChat(v, c)) {
    const body = `<section class="band"><div class="wrap narrow">
  ${crumbs}
  <h1>היכל התהילה</h1>
  <p class="lede">היכל התהילה פתוח רק למי שבקהילה.</p>
</div></section>
<div class="wrap narrow block">${communityBox(v, [c.id], path, { intro: 'פתוח ל' }) || ''}${v.role === 'public' ? `<p class="actions"><a class="btn" href="/login?next=${encodeURIComponent(path)}">כניסה</a></p>` : ''}</div>`;
    return render(env, v, { title: `היכל התהילה · ${c.title}`, path, body, noindex: true, script: true });
  }
  const d = await db(env);
  const [list, { results }] = await Promise.all([
    characters(env, c),
    d
      .prepare(
        `SELECT h.character_id, h.added_by, m.id, m.body, m.share, m.user_id, m.created_at, COALESCE(u.display_name, m.author) AS name
         FROM hall_of_fame h JOIN chat_messages m ON m.id = h.message_id LEFT JOIN users u ON u.id = m.user_id
         WHERE h.community_id = ? AND m.deleted = 0 ORDER BY h.created_at DESC`,
      )
      .bind(c.id)
      .all(),
  ]);
  const me = meOf(v);
  const owner = v.acc.owner;
  const quote = (r) => {
    const share = parse(r.share, null);
    const out = r.added_by === me || owner
      ? `<button class="link" type="button" data-hall-out="${e(r.id)}" data-character="${e(r.character_id)}">הוצאה מההיכל</button>`
      : '';
    return `<li class="hall-quote">
    <blockquote dir="auto">${r.body ? `<p>${lines(r.body)}</p>` : ''}${share ? `<a class="chat-share" href="${e(share.path)}"><span class="w">${e(share.where)}</span><span class="t" dir="auto">${e(share.title)}</span></a>` : ''}</blockquote>
    <div class="meta"><span class="by">${e(r.user_id ? r.name : OWNER_NAME)}</span><time datetime="${e(r.created_at)}">${e(fmtDate(r.created_at))}</time><a href="${chatPath(c)}#m-${e(r.id)}">בצ׳אט</a>${out}</div>
  </li>`;
  };
  const sections = list
    .map((ch) => {
      const mine = results.filter((r) => r.character_id === ch.id);
      const tools = owner
        ? `<div class="hall-tools"><button class="btn small" type="button" data-char-edit="${e(ch.id)}" aria-expanded="false">עריכה</button><button class="btn small danger" type="button" data-char-delete="${e(ch.id)}" data-name="${e(ch.name)}">מחיקה</button></div>
  <form class="hall-form" data-char-form="${e(ch.id)}" hidden>
    <label class="field">שם<input type="text" name="name" maxlength="${MAX_NAME}" dir="auto" required value="${e(ch.name)}"></label>
    <label class="field">מי זה/זו <small>בכמה מילים</small><textarea name="about" rows="2" maxlength="${MAX_ABOUT}" dir="auto">${e(ch.about)}</textarea></label>
    <div class="actions"><button class="btn accent" type="submit">שמירה</button></div>
  </form>`
        : '';
      return `<section class="hall" id="ch-${e(ch.id)}">
  <header class="hall-head">
    <h2 dir="auto">${TROPHY}${e(ch.name)}<span class="count">${mine.length || ''}</span></h2>
    ${tools}
  </header>
  ${ch.about ? `<p class="hall-about" dir="auto">${e(ch.about)}</p>` : ''}
  ${mine.length ? `<ol class="hall-list">${mine.map(quote).join('')}</ol>` : '<p class="empty">עוד אין כאן הודעות. בצ׳אט, בתפריט ⋯ של הודעה: ״להיכל התהילה״.</p>'}
</section>`;
    })
    .join('');
  const nav = list.length > 1 ? `<nav class="hall-nav" aria-label="הדמויות">${list.map((ch) => `<a href="#ch-${e(ch.id)}" dir="auto">${e(ch.name)}</a>`).join('')}</nav>` : '';
  const add = owner
    ? `<details class="post-new hall-new"${list.length ? '' : ' open'}><summary><span class="open-it">דמות חדשה</span><span class="close-it">סגירה</span></summary>
  <form class="hall-form" data-char-new="${e(c.id)}">
    <label class="field">שם<input type="text" name="name" maxlength="${MAX_NAME}" dir="auto" required placeholder="למשל: החזאית"></label>
    <label class="field">מי זה/זו <small>בכמה מילים</small><textarea name="about" rows="2" maxlength="${MAX_ABOUT}" dir="auto"></textarea></label>
    <div class="actions"><button class="btn accent" type="submit">הוספה</button></div>
  </form></details>`
    : '';
  const body = `<section class="band comm-band"><div class="wrap">
  ${crumbs}
  <h1>היכל התהילה</h1>
  <p class="lede">הדמויות של ${e(c.title)}, והרגעים הכי טובים שלהן מהצ׳אט.</p>
  <div class="spacer"></div>
</div></section>
<div class="wrap block hall-page" data-hall>
  <div class="hall-top">${nav}${add}</div>
  <p class="msg" role="status" data-hall-msg></p>
  ${sections || (owner ? '' : '<p class="empty">עוד אין כאן דמויות.</p>')}
  <p class="back"><a href="${chatPath(c)}">לצ׳אט</a> · <a href="${pathOf(c)}">לקהילה</a></p>
</div>`;
  return render(env, v, { title: `היכל התהילה · ${c.title}`, path, body, noindex: true, script: true, scripts: ['/hall.js'], studio: `group/${c.id}` });
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
  const [start, people, writes, cast] = await Promise.all([history(env, v, c), members(env, c), canWrite(env, v, c), characters(env, c)]);
  const data = {
    room: c.id, me: meOf(v), owner: v.acc.owner, canWrite: writes, members: people, characters: cast,
    blog: pathOf(c), hall: hallPath(c), ...start, now: new Date().toISOString(),
  };
  const body = `<div class="chat" data-chat>
  <header class="chat-head">
    <div class="wrap">
      <a class="chat-back" href="${pathOf(c)}" aria-label="חזרה לקהילה">→</a>
      <div class="chat-name">
        <h1 dir="auto">${e(c.title)}</h1>
        <p class="chat-status" data-status aria-live="polite">מתחבר…</p>
      </div>
      <button class="chat-stars-btn" type="button" data-stars-btn aria-expanded="false" aria-controls="chat-stars" title="מסומנות בכוכב והיכל התהילה"><span class="sr-only">מסומנות בכוכב</span>${STAR}</button>
      <button class="chat-people-btn" type="button" data-people-btn aria-expanded="false" aria-controls="chat-people">משתתפים</button>
    </div>
  </header>
  <section class="chat-people" id="chat-people" data-people hidden aria-label="משתתפים"></section>
  <section class="chat-stars" id="chat-stars" data-stars hidden aria-label="מסומנות בכוכב"></section>
  <section class="chat-pins" data-pins hidden aria-label="הודעות נעוצות"></section>
  <div class="chat-scroll" data-scroll>
    <div class="wrap">
      <p class="chat-more" data-more-wrap hidden><button class="btn small" type="button" data-more>הודעות קודמות</button></p>
      <ol class="chat-log" data-log aria-label="ההודעות"></ol>
      <p class="chat-empty" data-empty hidden>עוד אין כאן הודעות. בדיחה ראשונה?</p>
    </div>
  </div>
  <p class="chat-readonly" data-readonly${writes ? ' hidden' : ''}><span class="wrap">בצ׳אט הזה יש לך קריאה בלבד.</span></p>
  <form class="chat-compose" data-compose${writes ? '' : ' hidden'}>
    <div class="wrap">
      <div class="chat-to" data-to-picker hidden>
        <p>למי ההודעה? <small>מי שלא מסומן לא יראה אותה.</small></p>
        <div class="chat-to-list" data-to-list></div>
      </div>
      <div class="chat-replying" data-replying hidden><span dir="auto"></span><button type="button" class="link" data-cancel-reply aria-label="ביטול התגובה">✕</button></div>
      <div class="chat-row">
        <button class="chat-to-btn" type="button" data-to-btn aria-expanded="false" title="למי ההודעה">לכולם</button>
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
  return render(env, v, { title: `הצ׳אט של ${c.title}`, path, body, noindex: true, script: true, scripts: ['/chat.js'], page: 'chat', studio: `group/${c.id}` });
}
