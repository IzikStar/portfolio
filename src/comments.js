// Comments: the communities an item is opened to talk about it (beta readers
// on a chapter, "nonsense humor" on a sketch). An item opened to no community
// takes comments from any signed-in member who can read it. A comment can
// point at one paragraph; it keeps the opening words of that paragraph so the
// note still makes sense after the text is edited. Only those who may comment
// see comments, and the owner can close or delete any of them.
// Blog posts use the same comments: entry_id then holds the post's id.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { canSee, inAny } from './spaces.js';
import { outsideOf } from './communities.js';
import { getEntry } from './entries.js';
import { getPost, canReadPost, canCommentPost, postPath } from './posts.js';
import { cleanMentions, recordMentions, dropMentions, mentionNames, withMentions, personHref } from './mentions.js';
import { escapeHtml as e } from './markdown.js';
import { fmtDate, entryPath } from './site.js';

const MAX_BODY = 4000;
export const OWNER_NAME = 'יצחק';
const PER_HOUR = 60;

function fromRow(r) {
  return {
    id: r.id,
    entryId: r.entry_id,
    userId: r.user_id,
    author: r.author,
    anchor: r.anchor,
    quote: r.quote,
    body: r.body,
    replyTo: r.reply_to,
    status: r.status,
    createdAt: r.created_at,
  };
}

// May this viewer read and write comments on this entry?
export function canComment(v, entry) {
  const { acc } = v;
  if (!entry || entry.kind === 'idea' || entry.meta?.comments === false) return false;
  if (!canSee(acc, entry)) return false;
  if (acc.owner) return true;
  if (!v.member) return false;
  return !entry.communities?.length || inAny(acc, entry.communities);
}

export async function commentsOf(env, entryId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM comments WHERE entry_id = ? ORDER BY created_at, id').bind(entryId).all();
  const names = await mentionNames(env, results.map((r) => r.body));
  return results.map((r) => ({ ...fromRow(r), names }));
}

// ---------- the block under an item ----------

function one(c, v, replies = []) {
  const mine = v.acc.owner || (v.member && c.userId === v.member.id);
  const actions = [
    c.replyTo ? '' : `<button type="button" class="link" data-reply="${e(c.id)}">תגובה</button>`,
    v.acc.owner ? `<button type="button" class="link" data-resolve="${e(c.id)}" data-to="${c.status === 'open' ? 'resolved' : 'open'}">${c.status === 'open' ? 'טופל' : 'פתיחה מחדש'}</button>` : '',
    mine ? `<button type="button" class="link" data-delete-comment="${e(c.id)}">מחיקה</button>` : '',
  ].join('');
  const href = personHref(v, c.userId);
  const author = href ? `<a class="who" href="${e(href)}">${e(c.author)}</a>` : e(c.author);
  return `<li class="comment${c.userId ? '' : ' by-owner'}${c.status === 'resolved' ? ' resolved' : ''}" id="c-${e(c.id)}"${c.anchor != null ? ` data-anchor="${c.anchor}"` : ''}>
  <div class="meta"><b>${author}</b><time datetime="${e(c.createdAt)}">${e(fmtDate(c.createdAt))}</time>${c.status === 'resolved' ? '<span class="badge">טופל</span>' : ''}</div>
  ${c.quote ? `<a class="quote" href="#p-${c.anchor}" dir="auto">${e(c.quote)}</a>` : ''}
  <p dir="auto">${withMentions(e(c.body), c.names ?? new Map(), v)}</p>
  <div class="actions">${actions}</div>
  ${replies.length ? `<ol class="replies">${replies.map((r) => one(r, v)).join('')}</ol>` : ''}
</li>`;
}

// The comments section for an item page (or a blog post, passed as
// { id, communities, kind: 'post' } with its own `can`). Visitors who could
// get in get a line saying how; hidden communities are never named.
export function commentsBlock(v, entry, comments, can = canComment(v, entry)) {
  const { acc } = v;
  if (entry.kind === 'idea' || entry.meta?.comments === false) return '';
  if (!can) {
    const list = entry.communities ?? [];
    if (!list.length) {
      return v.role === 'public' ? '<section class="comments closed"><p>התגובות פתוחות למי שנרשם. <a href="/join">הרשמה</a> · <a href="/login">כניסה</a></p></section>' : '';
    }
    const outside = outsideOf(acc, list);
    if (!outside.length) return '';
    const names = outside.map((c) => e(c.title)).join(', ');
    if (outside.every((c) => acc.pending.has(c.id))) return `<section class="comments closed"><p>הבקשה שלכם להצטרף ל${names} מחכה לאישור. אחרי שאאשר אותה, אפשר להגיב כאן.</p></section>`;
    const open = outside.find((c) => c.joinMode === 'request' && !acc.pending.has(c.id));
    if (!open) return '';
    if (v.role === 'public') {
      return `<section class="comments closed"><p>התגובות כאן פתוחות ל${names}. <a href="/join?community=${encodeURIComponent(open.id)}">בקשת הצטרפות</a> · <a href="/login">כניסה</a></p></section>`;
    }
    return `<section class="comments closed"><p>התגובות כאן פתוחות ל${names}.</p><button class="btn small" type="button" data-join="${e(open.id)}">בקשת הצטרפות ל${e(open.title)}</button><p class="msg" role="status"></p></section>`;
  }
  const people = entry.kind === 'post' ? `community=${entry.communities[0]}` : `entry=${entry.id}`;
  const top = comments.filter((c) => !c.replyTo);
  const kids = new Map();
  for (const c of comments) if (c.replyTo) kids.set(c.replyTo, [...(kids.get(c.replyTo) ?? []), c]);
  return `<section class="comments" id="comments" data-comments="${e(entry.id)}"${entry.kind === 'post' ? ' data-on="post"' : ''}>
  <h2>תגובות${comments.length ? ` <small>${comments.length}</small>` : ''}</h2>
  ${top.length ? `<ol class="comment-list">${top.map((c) => one(c, v, kids.get(c.id))).join('')}</ol>` : '<p class="hint">עוד אין תגובות. אפשר להגיב על כל הטקסט, או לסמן מילים בטקסט וללחוץ "הגב".</p>'}
  <form class="comment-form" data-comment-form>
    <div class="target" hidden><span></span><button type="button" class="link" data-clear-target>ביטול</button></div>
    <label class="field"><span class="sr-only">תגובה</span><textarea name="body" rows="4" maxlength="${MAX_BODY}" dir="auto" placeholder="מה חשבתם? @ ושם מתייג מישהו מהקהילה" data-people="${e(people)}" required></textarea></label>
    <div class="actions"><button class="btn accent small" type="submit">שליחה</button><p class="msg" role="status"></p></div>
  </form>
</section>`;
}

// ---------- API ----------

export async function postComment(request, env, v) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const body = await readJson(request);
  // What is being commented on, and which communities may be tagged in it
  // (null: an item open to no community, where any member may be tagged).
  let targetId;
  let community;
  if (body.postId) {
    const post = await getPost(env, String(body.postId));
    if (!post || !canReadPost(v, post)) throw new HttpError(404, 'That post no longer exists.');
    if (!canCommentPost(v, post)) throw new HttpError(403, 'Comments here are open to this community only.');
    targetId = post.id;
    community = [post.spaceId];
  } else {
    const entry = await getEntry(env, String(body.entryId ?? ''));
    if (!entry || !canSee(v.acc, entry)) throw new HttpError(404, 'That item no longer exists.');
    if (!canComment(v, entry)) throw new HttpError(403, 'Comments here are open to this community only.');
    targetId = entry.id;
    community = entry.communities.length ? entry.communities : null;
  }
  const { text, ids: tagged } = await cleanMentions(env, community, cleanText(body.body, MAX_BODY));
  if (!text.trim()) throw new HttpError(400, 'Write something first.');
  const d = await db(env);
  let replyTo = null;
  if (body.replyTo) {
    const parent = await d.prepare('SELECT id, reply_to FROM comments WHERE id = ? AND entry_id = ?').bind(String(body.replyTo), targetId).first();
    if (!parent) throw new HttpError(400, 'The comment you replied to is gone.');
    replyTo = parent.reply_to ?? parent.id;
  }
  const anchor = Number.isInteger(body.anchor) && body.anchor >= 0 && body.anchor < 10_000 && !replyTo ? body.anchor : null;
  const now = new Date();
  if (!v.acc.owner) {
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const { n } = await d.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?').bind(v.member.id, since).first();
    if (n >= PER_HOUR) throw new HttpError(429, 'That is a lot of comments for one hour. Try again a bit later.');
  }
  const c = {
    id: crypto.randomUUID(),
    entryId: targetId,
    userId: v.acc.owner ? null : v.member.id,
    author: v.acc.owner ? OWNER_NAME : v.member.displayName,
    anchor,
    quote: anchor === null ? '' : cleanText(body.quote, 160),
    body: text,
    replyTo,
    status: 'open',
    createdAt: now.toISOString(),
  };
  await d
    .prepare(
      `INSERT INTO comments (id, entry_id, user_id, author, anchor, quote, body, reply_to, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, c.entryId, c.userId, c.author, c.anchor, c.quote, c.body, c.replyTo, c.status, c.createdAt)
    .run();
  await recordMentions(env, 'comment', c.id, tagged, c.userId);
  return json(c, 201);
}

// The writer of a comment, or the owner, may delete it (with its replies).
export async function deleteComment(env, v, id) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const d = await db(env);
  const row = await d.prepare('SELECT * FROM comments WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'That comment is already gone.');
  if (!v.acc.owner && row.user_id !== v.member.id) throw new HttpError(403, 'Only the writer can delete this comment.');
  const { results } = await d.prepare('SELECT id FROM comments WHERE id = ? OR reply_to = ?').bind(id, id).all();
  await d.prepare('DELETE FROM comments WHERE id = ? OR reply_to = ?').bind(id, id).run();
  await dropMentions(env, 'comment', results.map((r) => r.id));
  return json({ ok: true });
}

// ---------- studio ----------

// Comments across the site, newest first, with the item they belong to.
export async function studioComments(env, url, acc) {
  const d = await db(env);
  const status = url.searchParams.get('status');
  // The owner's own answers never wait in the open list.
  const where = status === 'open' ? `WHERE c.status = ? AND c.user_id IS NOT NULL` : status === 'resolved' ? 'WHERE c.status = ?' : '';
  const { results } = await d
    .prepare(
      `SELECT c.*, e.title AS entry_title, e.slug AS entry_slug, e.space_id AS entry_space, e.kind AS entry_kind,
       p.id AS post_id, p.title AS post_title, p.slug AS post_slug, p.space_id AS post_space
       FROM comments c LEFT JOIN entries e ON e.id = c.entry_id LEFT JOIN posts p ON p.id = c.entry_id
       ${where} ORDER BY c.created_at DESC LIMIT 300`,
    )
    .bind(...(where ? [status] : []))
    .all();
  const { open } = await d.prepare(`SELECT COUNT(*) AS open FROM comments WHERE status = 'open' AND user_id IS NOT NULL`).first();
  return json({
    open,
    comments: results.map((r) => ({
      ...fromRow(r),
      entry: r.post_id
        ? { id: r.entry_id, title: r.post_title, kind: 'post', spaceId: r.post_space, path: postPath(acc, { slug: r.post_slug, spaceId: r.post_space }) }
        : { id: r.entry_id, title: r.entry_title ?? '', kind: r.entry_kind, spaceId: r.entry_space, path: entryPath(acc, { slug: r.entry_slug, spaceId: r.entry_space }) },
    })),
  });
}

export async function setCommentStatus(request, env, id) {
  const { status } = await readJson(request);
  if (status !== 'open' && status !== 'resolved') throw new HttpError(400, 'Unknown status.');
  const d = await db(env);
  const res = await d.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(status, id).run();
  if (!res.meta?.changes) throw new HttpError(404, 'That comment is already gone.');
  return json({ ok: true, status });
}

// When an item (or a post) goes, so do its comments and the tags in them.
export async function deleteCommentsOf(env, entryId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT id FROM comments WHERE entry_id = ?').bind(entryId).all();
  await d.prepare('DELETE FROM comments WHERE entry_id = ?').bind(entryId).run();
  await dropMentions(env, 'comment', results.map((r) => r.id));
}
