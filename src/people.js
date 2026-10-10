// One member's page in the studio (#person/<id>): who they are, where they
// stand in each community, and what they did on the site (comments, posts,
// items that credit them, where they were tagged), each with its address on
// the site so the owner can jump straight there.
import { db } from './db.js';
import { HttpError, json } from './http.js';
import { access } from './spaces.js';
import { ownerMemberId, syncOwnerMember } from './communities.js';
import { personOut } from './members.js';
import { listCredited } from './entries.js';
import { POST_SELECT, postFromRow, postPath } from './posts.js';
import { mentionNames, forEditing } from './mentions.js';
import { excerpt } from './markdown.js';
import { entryPath } from './site.js';

const LIMIT = 50;

export async function personPage(env, id) {
  await syncOwnerMember(env);
  const d = await db(env);
  const u = await d.prepare('SELECT id, username, display_name, status, request_note, invite_code, created_at, last_login_at FROM users WHERE id = ?').bind(id).first();
  if (!u) throw new HttpError(404, 'That member no longer exists.');
  const acc = await access(env, { role: 'owner' });
  const [ownerId, joined, comments, posts, tagged, credited] = await Promise.all([
    ownerMemberId(env),
    d.prepare(`SELECT community_id, status FROM community_members WHERE user_id = ? AND status IN ('active', 'pending')`).bind(id).all(),
    d
      .prepare(
        `SELECT c.id, c.entry_id, c.body, c.quote, c.status, c.created_at,
         e.title AS entry_title, e.slug AS entry_slug, e.space_id AS entry_space, e.kind AS entry_kind,
         p.title AS post_title, p.slug AS post_slug, p.space_id AS post_space
         FROM comments c LEFT JOIN entries e ON e.id = c.entry_id LEFT JOIN posts p ON p.id = c.entry_id
         WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT ?`,
      )
      .bind(id, LIMIT)
      .all(),
    d.prepare(`${POST_SELECT} WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT ?`).bind(id, LIMIT).all(),
    d
      .prepare(
        `SELECT m.source, m.source_id, m.created_at, c.entry_id AS comment_on,
         COALESCE(e.title, cp.title) AS comment_title, e.slug AS entry_slug, e.space_id AS entry_space,
         cp.slug AS cpost_slug, cp.space_id AS cpost_space,
         p.title AS post_title, p.slug AS post_slug, p.space_id AS post_space
         FROM mentions m
         LEFT JOIN comments c ON m.source = 'comment' AND c.id = m.source_id
         LEFT JOIN entries e ON e.id = c.entry_id
         LEFT JOIN posts cp ON cp.id = c.entry_id
         LEFT JOIN posts p ON m.source = 'post' AND p.id = m.source_id
         WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT ?`,
      )
      .bind(id, LIMIT)
      .all(),
    listCredited(env, acc, id, LIMIT),
  ]);
  const where = Object.fromEntries(joined.results.map((r) => [r.community_id, r.status]));
  const postList = posts.results.map(postFromRow);
  const names = await mentionNames(env, [...postList.map((p) => p.body), ...comments.results.map((c) => c.body)]);
  const plain = (text) => forEditing(text, names).text;
  return json(
    {
      person: personOut(u, where, ownerId),
      comments: comments.results.map((r) => {
        const isPost = Boolean(r.post_slug);
        const path = isPost ? postPath(acc, { slug: r.post_slug, spaceId: r.post_space }) : r.entry_slug != null ? entryPath(acc, { slug: r.entry_slug, spaceId: r.entry_space }) : null;
        return {
          id: r.id,
          body: excerpt(plain(r.body), 240),
          quote: r.quote,
          status: r.status,
          createdAt: r.created_at,
          on: { id: r.entry_id, kind: isPost ? 'post' : r.entry_kind, title: (isPost ? r.post_title : r.entry_title) ?? '', path: path && `${path}#c-${r.id}` },
        };
      }),
      posts: postList.map((p) => ({ id: p.id, title: p.title, spaceId: p.spaceId, status: p.status, public: p.public, comments: p.comments, createdAt: p.createdAt, excerpt: excerpt(plain(p.body), 160), path: postPath(acc, p) })),
      credits: credited.map((x) => ({
        id: x.id,
        kind: x.kind,
        title: x.title,
        roles: (x.meta?.credits ?? []).filter((c) => c.userId === id).map((c) => c.role).filter(Boolean),
        path: entryPath(acc, x),
      })),
      tagged: tagged.results
        .map((r) => {
          if (r.source === 'post') return r.post_slug ? { what: 'post', title: r.post_title, path: postPath(acc, { slug: r.post_slug, spaceId: r.post_space }), at: r.created_at } : null;
          const base = r.cpost_slug ? postPath(acc, { slug: r.cpost_slug, spaceId: r.cpost_space }) : r.entry_slug != null ? entryPath(acc, { slug: r.entry_slug, spaceId: r.entry_space }) : null;
          return r.comment_on ? { what: 'comment', title: r.comment_title ?? '', path: base && `${base}#c-${r.source_id}`, entryId: r.cpost_slug ? null : r.comment_on, at: r.created_at } : null;
        })
        .filter(Boolean),
    },
    200,
    { 'Cache-Control': 'private, no-store' },
  );
}
