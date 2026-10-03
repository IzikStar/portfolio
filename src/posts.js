// Blog posts: the data and who may do what. Every community (a wing, or a
// space with its own community) has a blog. Its active members write posts;
// a post is seen by that community and the owner, or by everyone who can open
// the space when the owner makes it public. The owner can pin, hide or delete
// any post. Pages and routes are in blog.js.
import { db } from './db.js';
import { spacePath } from './site.js';

export const BLOG = 'blog'; // the address segment; no space or item may take it as a slug

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

// Only community spaces have a blog.
export const hasBlog = (space) => Boolean(space) && (!space.parentId || space.ownCommunity);

export const blogPath = (acc, space) => `${spacePath(acc, space)}/${BLOG}`;
export function postPath(acc, post) {
  const space = acc.byId.get(post.spaceId);
  return space ? `${blogPath(acc, space)}/${encodeURIComponent(post.slug)}` : null;
}

// May this viewer write a new post in this community's blog?
export function canPost(v, space) {
  const { acc } = v;
  if (!hasBlog(space)) return false;
  if (acc.owner) return true;
  return Boolean(v.member) && acc.visible.has(space.id) && acc.communities.has(space.id);
}

// May this viewer read this post?
export function canReadPost(v, post) {
  const { acc } = v;
  if (acc.owner) return true;
  if (!post || !acc.visible.has(post.spaceId)) return false;
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

// How many posts of this community are up and open to everyone.
export async function openPostCount(env, spaceId) {
  if (!spaceId) return 0;
  const d = await db(env);
  const row = await d.prepare(`SELECT COUNT(*) AS n FROM posts WHERE space_id = ? AND public = 1 AND status = 'visible'`).bind(spaceId).first();
  return row?.n ?? 0;
}

// The writer edits and deletes their own post; the owner may delete any.
export const isWriter = (v, post) => (v.acc.owner ? post.userId === null : Boolean(v.member) && post.userId === v.member.id);
