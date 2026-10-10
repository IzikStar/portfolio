// A community's own page and its blog. Addresses:
//   /community/<slug>          the community: what is open to it, and its blog
//   /community/<slug>/<post>   one post
// A hidden community's page is a plain 404 to anyone outside it. Who may read
// and write is in posts.js; comments on a post are the regular comments
// (src/comments.js) and tags are in src/mentions.js.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { escapeHtml as e, renderMarkdown, excerpt } from './markdown.js';
import { slugify, listFeed } from './entries.js';
import { render, fmtDate, entryPath, wingOf } from './site.js';
import { communityBox } from './wings.js';
import { knows, pathOf } from './communities.js';
import { commentsBlock, commentsOf, deleteCommentsOf, OWNER_NAME } from './comments.js';
import { cleanMentions, recordMentions, dropMentions, mentionNames, withMentions, forEditing, chip } from './mentions.js';
import { chatPage, CHAT, chatLink } from './chat.js';
import { POST_SELECT, postFromRow, getPost, postPath, canPost, canReadPost, canCommentPost, isWriter } from './posts.js';

const MAX_TITLE = 160;
const MAX_BODY = 40_000;
const PER_HOUR = 6;

// ---------- pages ----------

// /community/<slug>[/<post>]: the page, or null for "not found".
export async function communityRoute(env, v, slug, postSlug) {
  const c = v.acc.comms.find((x) => x.slug === slug);
  if (!knows(v.acc, c)) return null;
  if (postSlug === CHAT) return chatPage(env, v, c);
  return postSlug === undefined ? blogPage(env, v, c) : postPage(env, v, c, postSlug);
}

function head(c, lede) {
  return `<section class="band"><div class="wrap">
  <div class="crumbs"><a href="/community">הקהילות</a></div>
  <h1 dir="auto">${e(c.title)}</h1>
  ${lede ? `<p class="lede" dir="auto">${lede}</p>` : ''}
  <div class="spacer"></div>
</div></section>`;
}

function badges(v, post) {
  return [
    post.pinned ? '<span class="badge">נעוץ</span>' : '',
    post.public && (v.acc.owner || v.member) ? '<span class="badge vis-public">פתוח לכולם</span>' : '',
    post.status === 'hidden' ? '<span class="badge draft">מוסתר</span>' : '',
  ].join('');
}

const byline = (post) => chip(post.userId ? post.author : OWNER_NAME, '');

function postForm(c, post = null, names = new Map()) {
  const edit = post ? forEditing(post.body, names) : { text: '', names: {} };
  return `<form class="post-form" data-post-form data-space="${e(c.id)}"${post ? ` data-post="${e(post.id)}"` : ''}>
  <label class="field">כותרת<input type="text" name="title" maxlength="${MAX_TITLE}" dir="auto" required value="${e(post?.title ?? '')}"></label>
  <label class="field">${post ? 'הפוסט' : 'מה רציתם לספר?'} <small>Markdown עובד: ## כותרת, **מודגש**, [קישור](https://...). @ ושם מתייג מישהו מהקהילה.</small>
    <textarea name="body" rows="12" maxlength="${MAX_BODY}" dir="auto" required data-people="community=${e(c.id)}" data-names="${e(JSON.stringify(edit.names))}">${e(edit.text)}</textarea>
  </label>
  <div class="actions"><button class="btn accent" type="submit">${post ? 'שמירה' : 'פרסום'}</button><p class="msg" role="status"></p></div>
</form>`;
}

async function blogPage(env, v, c) {
  const { acc } = v;
  const path = pathOf(c);
  const d = await db(env);
  const [{ results }, feed] = await Promise.all([
    d.prepare(`${POST_SELECT} WHERE p.space_id = ? ORDER BY p.pinned DESC, p.created_at DESC LIMIT 200`).bind(c.id).all(),
    listFeed(env, acc, 300),
  ]);
  const posts = results.map(postFromRow).filter((p) => canReadPost(v, p));
  const names = await mentionNames(env, posts.map((p) => p.body));
  const inside = acc.owner || (v.member && acc.communities.has(c.id));
  // What is opened to this community (and that this viewer may open).
  const items = feed.filter((x) => x.communities.includes(c.id) && entryPath(acc, x)).slice(0, 60);
  const shelf = items.length
    ? `<section class="block"><div class="section-head"><h2>פתוח לקהילה</h2></div><div class="feed">${items
        .map((x) => {
          const w = wingOf(acc, x.spaceId);
          return `<a href="${entryPath(acc, x)}" data-wing="${e(w?.id ?? '')}"><span class="w">${e(w?.title ?? '')}</span><span class="t" dir="auto">${e(x.title)}</span><span class="d">${e(fmtDate(x.publishedAt))}</span></a>`;
        })
        .join('')}</div></section>`
    : '';
  const list = posts.length
    ? `<ol class="posts">${posts
        .map(
          (p) => `<li class="post-card${p.pinned ? ' pinned' : ''}">
  <a class="title" href="${postPath(acc, p)}" dir="auto">${e(p.title)}</a>
  <p dir="auto">${e(excerpt(forEditing(p.body, names).text, 220))}</p>
  <div class="meta">${byline(p)}<time datetime="${e(p.createdAt)}">${e(fmtDate(p.createdAt))}</time>${p.comments ? `<span>${p.comments === 1 ? 'תגובה אחת' : `${p.comments} תגובות`}</span>` : ''}${badges(v, p)}</div>
</li>`,
        )
        .join('')}</ol>`
    : `<p class="empty">${inside ? 'עוד אין כאן פוסטים. מי שכותב ראשון קובע את הטון.' : 'מה שנכתב כאן פתוח רק לקהילה.'}</p>`;
  const write = canPost(v, c) ? `<details class="panel post-new"><summary>פוסט חדש</summary>${postForm(c)}</details>` : '';
  const manage = acc.owner ? `<p class="actions"><a class="btn small" href="/studio#group/${e(c.id)}">ניהול הקהילה</a>${c.hidden ? '<span class="badge">נסתרת</span>' : ''}</p>` : '';
  const body = `${head(c, c.summary ? e(c.summary) : '')}
<div class="wrap narrow block blog">
  ${manage}
  ${inside ? await chatLink(env, c) : communityBox(v, [c.id], path, { intro: 'הדברים כאן פתוחים ל' })}
  ${shelf}
  <section class="block"><div class="section-head"><h2>הבלוג</h2></div>
  ${write}
  ${list}
  </section>
</div>`;
  const open = !c.hidden;
  return render(env, v, { title: c.title, description: c.summary || `הקהילה ${c.title}`, path, body, noindex: !open, script: true });
}

async function postPage(env, v, c, slug) {
  const { acc } = v;
  const d = await db(env);
  const post = postFromRow(await d.prepare(`${POST_SELECT} WHERE p.space_id = ? AND p.slug = ?`).bind(c.id, slug).first());
  if (!post || !canReadPost(v, post)) return null;
  const path = postPath(acc, post);
  const names = await mentionNames(env, [post.body]);
  const can = canCommentPost(v, post);
  const mine = isWriter(v, post) && canPost(v, c);
  const tools = [
    mine ? '<button class="btn small" type="button" data-post-edit aria-expanded="false">עריכה</button>' : '',
    acc.owner
      ? `<button class="btn small" type="button" data-post-mod="pinned" data-to="${!post.pinned}">${post.pinned ? 'ביטול נעיצה' : 'נעיצה'}</button>
         <button class="btn small" type="button" data-post-mod="public" data-to="${!post.public}">${post.public ? 'רק לקהילה' : 'פתיחה לכולם'}</button>
         <button class="btn small" type="button" data-post-mod="hidden" data-to="${post.status !== 'hidden'}">${post.status === 'hidden' ? 'החזרה' : 'הסתרה'}</button>`
      : '',
    mine || acc.owner ? `<button class="btn small danger" type="button" data-post-delete data-back="${e(pathOf(c))}">מחיקה</button>` : '',
  ].join('');
  const comments = post.status === 'visible' || acc.owner
    ? commentsBlock(v, { id: post.id, communities: [c.id], kind: 'post', meta: {} }, can ? await commentsOf(env, post.id) : [], can)
    : '';
  const body = `<article class="wrap article post" data-post-id="${e(post.id)}">
  <header>
    <div class="meta"><a href="${pathOf(c)}">הבלוג של ${e(c.title)}</a><time datetime="${e(post.createdAt)}">${e(fmtDate(post.createdAt))}</time>${badges(v, post)}</div>
    <h1 dir="auto">${e(post.title)}</h1>
    <div class="meta">${byline(post)}</div>
    ${tools ? `<div class="post-tools">${tools}<p class="msg" role="status"></p></div>` : ''}
    ${mine ? `<div class="post-edit" hidden>${postForm(c, post, names)}</div>` : ''}
  </header>
  <div class="prose" dir="auto"${can ? ' data-anchors' : ''}>${withMentions(renderMarkdown(post.body), names)}</div>
  ${comments}
  <p class="back"><a href="${pathOf(c)}">לכל הפוסטים</a></p>
</article>`;
  const open = post.public && post.status === 'visible' && !c.hidden;
  return render(env, v, { title: post.title, description: excerpt(forEditing(post.body, names).text, 160), path, body, noindex: !open, script: true });
}

// ---------- API (members and the owner) ----------

export async function writeAllowed(env, v) {
  if (v.acc.owner) return;
  const d = await db(env);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { n } = await d.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at > ?').bind(v.member.id, since).first();
  if (n >= PER_HOUR) throw new HttpError(429, 'That is a lot of posts for one hour. Try again a bit later.');
}

async function readPost(request) {
  const body = await readJson(request);
  const title = cleanText(body.title, MAX_TITLE);
  if (!title) throw new HttpError(400, 'Give the post a title.');
  return { title, raw: cleanText(body.body, MAX_BODY) };
}

// A new post in a community's blog, by the viewer (also used by the chat,
// when a message becomes a post). "chat" is never a post's slug: that
// address is the community's chat (src/chat.js).
// `by` credits someone else ({ userId, author }): the writer of a chat message.
export async function addPost(env, v, space, title, text, { open = false, by = null } = {}) {
  const { acc } = v;
  const now = new Date().toISOString();
  const post = {
    id: crypto.randomUUID(),
    spaceId: space.id,
    userId: by ? by.userId : acc.owner ? null : v.member.id,
    author: by ? by.author : acc.owner ? OWNER_NAME : v.member.displayName,
    title,
    body: text,
    public: open,
    createdAt: now,
  };
  const base = slugify(title) || post.id.slice(0, 8);
  const d = await db(env);
  for (let n = base === CHAT ? 2 : 1; ; n++) {
    post.slug = n === 1 ? base : `${base}-${n}`;
    try {
      await d
        .prepare(
          `INSERT INTO posts (id, space_id, slug, user_id, author, title, body, status, public, pinned, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'visible', ?, 0, ?, ?)`,
        )
        .bind(post.id, post.spaceId, post.slug, post.userId, post.author, post.title, post.body, open ? 1 : 0, now, now)
        .run();
      break;
    } catch (err) {
      if (!/UNIQUE/i.test(String(err?.message)) || n > 50) throw err;
    }
  }
  return post;
}

// POST /api/blog/<spaceId>/posts
export async function createPost(request, env, v, spaceId) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const { acc } = v;
  const space = acc.commById.get(spaceId);
  if (!knows(acc, space)) throw new HttpError(404, 'No such blog.');
  if (!canPost(v, space)) throw new HttpError(403, 'This blog is open to its community only.');
  await writeAllowed(env, v);
  const { title, raw } = await readPost(request);
  const { text, ids } = await cleanMentions(env, [space.id], raw);
  if (!text.trim()) throw new HttpError(400, 'Write something first.');
  const post = await addPost(env, v, space, title, text);
  await recordMentions(env, 'post', post.id, ids, post.userId);
  return json({ ...post, path: postPath(acc, post) }, 201);
}

async function ownPost(env, v, id) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const post = await getPost(env, id);
  if (!post || !canReadPost(v, post)) throw new HttpError(404, 'That post no longer exists.');
  return post;
}

// PATCH /api/blog/posts/<id>: the writer edits the title and the text.
export async function editPost(request, env, v, id) {
  const post = await ownPost(env, v, id);
  if (!isWriter(v, post) || !canPost(v, v.acc.commById.get(post.spaceId))) throw new HttpError(403, 'Only the writer can edit this post.');
  const { title, raw } = await readPost(request);
  const { text, ids } = await cleanMentions(env, [post.spaceId], raw);
  if (!text.trim()) throw new HttpError(400, 'Write something first.');
  const d = await db(env);
  await d.prepare('UPDATE posts SET title = ?, body = ?, updated_at = ? WHERE id = ?').bind(title, text, new Date().toISOString(), post.id).run();
  await recordMentions(env, 'post', post.id, ids, post.userId);
  return json({ ok: true, path: postPath(v.acc, post) });
}

// DELETE /api/blog/posts/<id>: the writer or the owner.
export async function deletePost(env, v, id) {
  const post = await ownPost(env, v, id);
  if (!v.acc.owner && !isWriter(v, post)) throw new HttpError(403, 'Only the writer can delete this post.');
  const d = await db(env);
  await d.prepare('DELETE FROM posts WHERE id = ?').bind(post.id).run();
  await deleteCommentsOf(env, post.id);
  await dropMentions(env, 'post', [post.id]);
  return json({ ok: true });
}

// ---------- studio ----------

// GET /api/studio/posts?space=<id>&status=visible|hidden|pinned|public
export async function studioPosts(env, url, acc) {
  const d = await db(env);
  const where = [];
  const args = [];
  const space = url.searchParams.get('space');
  if (space) {
    where.push('p.space_id = ?');
    args.push(space);
  }
  const status = url.searchParams.get('status');
  if (status === 'visible' || status === 'hidden') {
    where.push('p.status = ?');
    args.push(status);
  } else if (status === 'pinned' || status === 'public') {
    where.push(`p.${status} = 1`);
  }
  const { results } = await d
    .prepare(`${POST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT 300`)
    .bind(...args)
    .all();
  const names = await mentionNames(env, results.map((r) => r.body));
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { n } = await d.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at > ? AND user_id IS NOT NULL').bind(week).first();
  return json({
    week: n,
    posts: results.map((r) => {
      const p = postFromRow(r);
      return { ...p, author: p.userId ? p.author : OWNER_NAME, excerpt: excerpt(forEditing(p.body, names).text, 160), path: postPath(acc, p) };
    }),
  });
}

// PATCH /api/studio/posts/<id> { pinned?, public?, hidden? }
export async function moderatePost(request, env, id) {
  const body = await readJson(request);
  const d = await db(env);
  const row = await d.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'That post no longer exists.');
  const pinned = 'pinned' in body ? (body.pinned ? 1 : 0) : row.pinned;
  const open = 'public' in body ? (body.public ? 1 : 0) : row.public;
  const status = 'hidden' in body ? (body.hidden ? 'hidden' : 'visible') : row.status;
  await d.prepare('UPDATE posts SET pinned = ?, public = ?, status = ? WHERE id = ?').bind(pinned, open, status, id).run();
  return json({ ok: true, pinned: Boolean(pinned), public: Boolean(open), status });
}
