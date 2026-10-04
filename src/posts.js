// Blog posts: the data and who may do what. Every community has a blog, on
// its page (/community/<slug>). Its active members write posts; a post is seen
// by that community and the owner, or by everyone who may know the community
// when the owner opens it to all. The owner can pin, hide or delete any post.
// Pages and routes are in blog.js. A post's spaceId is its community's id (the
// column is older than communities).
import { db } from './db.js';
import { knows, pathOf } from './communities.js';

export const BLOG = 'blog'; // reserved: no space or item may take it as a slug

export function postFromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    spaceId: r.space_id,
    slug: r.slug,
    userId: r.user_id,
    author: r.author_name ?? r.author,
    title: r.title,
    body: r.body,
    status: r.status,
    public: Boolean(r.public),
    pinned: Boolean(r.pinned),
    comments: r.comment_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// The author's current name follows renames; the stored one is a fallback.
export const POST_SELECT = `SELECT p.*, u.display_name AS author_name,
  (SELECT COUNT(*) FROM comments c WHERE c.entry_id = p.id) AS comment_count
  FROM posts p LEFT JOIN users u ON u.id = p.user_id`;

export async function getPost(env, id) {
  const d = await db(env);
  return postFromRow(await d.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(id).first());
}

export const blogPath = (acc, c) => pathOf(c);
export function postPath(acc, post) {
  const c = acc.commById.get(post.spaceId);
  return c ? `${pathOf(c)}/${encodeURIComponent(post.slug)}` : null;
}

// May this viewer write a new post in this community's blog?
export function canPost(v, c) {
  const { acc } = v;
  if (!c) return false;
  if (acc.owner) return true;
  return Boolean(v.member) && acc.communities.has(c.id);
}

// May this viewer read this post?
export function canReadPost(v, post) {
  const { acc } = v;
  if (acc.owner) return true;
  if (!post || !knows(acc, acc.commById.get(post.spaceId))) return false;
  if (v.member && post.userId === v.member.id) return true; // the writer still sees it when hidden
  if (post.status !== 'visible') return false;
  if (post.public) return true;
  return Boolean(v.member) && acc.communities.has(post.spaceId);
}

// Comments on a post: the community (and the owner), on posts that are up.
export function canCommentPost(v, post) {
  if (!canReadPost(v, post)) return false;
  if (v.acc.owner) return true;
  return post.status === 'visible' && Boolean(v.member) && v.acc.communities.has(post.spaceId);
}

// The writer edits and deletes their own post; the owner may delete any.
export const isWriter = (v, post) => (v.acc.owner ? post.userId === null : Boolean(v.member) && post.userId === v.member.id);
