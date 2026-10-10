// Tagging members: "@" in a comment or a blog post. The text stores a token,
// @{<user id>}, so a rename shows everywhere at once; pages turn the token into
// a name chip. A token only survives a save when that person is an active
// member of the communities the text lives in (any active member, for an item
// opened to no community), so nobody can tag (or find out the names of)
// people outside them. Each tag is also a row in `mentions`, which
// is what the tagged member sees on their page.
import { db } from './db.js';
import { HttpError, json, cleanText } from './http.js';
import { getEntry } from './entries.js';
import { canComment } from './comments.js';
import { canSee } from './spaces.js';
import { knows } from './communities.js';
import { escapeHtml as e } from './markdown.js';

const TOKEN = /@\{([0-9a-f-]{36})\}/g;
const MAX_TAGS = 20;
const PICK_LIMIT = 8;

const idsIn = (text) => [...new Set([...String(text ?? '').matchAll(TOKEN)].map((m) => m[1]))];

// SQL picking active users who are active members of the communities (a JSON
// list), or every active user when the list is null.
const IN_SCOPE = `u.status = 'active' AND (? IS NULL OR EXISTS (SELECT 1 FROM community_members m
  WHERE m.user_id = u.id AND m.status = 'active' AND m.community_id IN (SELECT value FROM json_each(?))))`;
const scopeArgs = (communities) => {
  const list = communities ? JSON.stringify(communities) : null;
  return [list, list ?? '[]'];
};

async function membersAmong(env, communities, ids) {
  if (!ids.length) return new Set();
  const d = await db(env);
  const { results } = await d
    .prepare(`SELECT u.id FROM users u WHERE ${IN_SCOPE} AND u.id IN (SELECT value FROM json_each(?))`)
    .bind(...scopeArgs(communities), JSON.stringify(ids))
    .all();
  return new Set(results.map((r) => r.id));
}

// Keep the tags that point at members of these communities (null: any member)
// and drop the rest. Returns the cleaned text and who is tagged in it.
export async function cleanMentions(env, communities, text) {
  const wanted = idsIn(text).slice(0, MAX_TAGS);
  const ok = await membersAmong(env, communities, wanted);
  return { text: String(text).replace(TOKEN, (m, id) => (ok.has(id) ? m : '')), ids: [...ok] };
}

// Replace the tag rows of one comment or post. Nobody is told about tagging themselves.
export async function recordMentions(env, source, sourceId, ids, byUser) {
  const d = await db(env);
  const now = new Date().toISOString();
  const keep = ids.filter((id) => id !== byUser);
  await d.batch([
    d.prepare('DELETE FROM mentions WHERE source = ? AND source_id = ?').bind(source, sourceId),
    ...keep.map((id) =>
      d.prepare('INSERT OR IGNORE INTO mentions (source, source_id, user_id, by_user, created_at) VALUES (?, ?, ?, ?, ?)').bind(source, sourceId, id, byUser, now),
    ),
  ]);
}

export async function dropMentions(env, source, sourceIds) {
  if (!sourceIds.length) return;
  const d = await db(env);
  await d.prepare('DELETE FROM mentions WHERE source = ? AND source_id IN (SELECT value FROM json_each(?))').bind(source, JSON.stringify(sourceIds)).run();
}

// Current display names for every tag in these texts: Map(id -> name).
export async function mentionNames(env, texts) {
  const ids = [...new Set(texts.flatMap(idsIn))];
  if (!ids.length) return new Map();
  const d = await db(env);
  const { results } = await d.prepare('SELECT id, display_name FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all();
  return new Map(results.map((r) => [r.id, r.display_name]));
}

// Where a person's name leads this viewer: the owner to that member's page
// in the studio, a member to their own page; anyone else gets a plain name.
export function personHref(v, userId) {
  if (!userId || !v) return null;
  if (v.acc?.owner) return `/studio#person/${userId}`;
  return v.member?.id === userId ? '/community' : null;
}

// dir=auto keeps the @ in front of a Latin name inside Hebrew text.
export const chip = (name, at = '@', href = null) =>
  href ? `<a class="mention" dir="auto" href="${e(href)}">${at}${e(name)}</a>` : `<span class="mention" dir="auto">${at}${e(name)}</span>`;

// Turn tokens in already-escaped HTML into chips (links for the viewer `v`,
// see personHref). Only text between tags is touched, so a token inside an
// attribute (an image's alt text) stays inert, and a token inside a link
// stays a plain chip so links never nest.
export function withMentions(html, names, v = null) {
  let inLink = 0;
  return String(html)
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<a[\s>]/i.test(part)) inLink++;
        else if (/^<\/a>/i.test(part)) inLink = Math.max(0, inLink - 1);
        return part;
      }
      return part.replace(TOKEN, (m, id) => (names.has(id) ? chip(names.get(id), '@', inLink ? null : personHref(v, id)) : ''));
    })
    .join('');
}

// For an edit form: "@Name" in place of each token, plus the names the client
// turns back into tokens on save.
export function forEditing(text, names) {
  const used = {};
  const out = String(text ?? '').replace(TOKEN, (m, id) => {
    if (!names.has(id)) return '';
    used[names.get(id)] = id;
    return `@${names.get(id)}`;
  });
  return { text: out, names: used };
}

// ---------- API: who can be tagged here ----------

// GET /api/people?entry=<id>&q=  or  ?community=<id>&q=. Open to whoever may
// write there (the owner too), and lists only the people who may be tagged there.
export async function people(env, v, url) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const { acc } = v;
  let scope;
  const entryId = url.searchParams.get('entry');
  if (entryId) {
    const entry = await getEntry(env, String(entryId));
    if (!entry || !canSee(acc, entry)) throw new HttpError(404, 'No such item.');
    if (!canComment(v, entry)) throw new HttpError(403, 'Only those who may comment here can tag.');
    scope = entry.communities.length ? entry.communities : null;
  } else {
    const c = acc.commById.get(String(url.searchParams.get('community') ?? ''));
    if (!knows(acc, c)) throw new HttpError(404, 'No such community.');
    if (!acc.owner && !acc.communities.has(c.id)) throw new HttpError(403, 'Only this community can tag its members.');
    scope = [c.id];
  }
  const q = cleanText(url.searchParams.get('q'), 40).replace(/[\\%_]/g, (c) => `\\${c}`);
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT u.id, u.display_name, u.username FROM users u WHERE ${IN_SCOPE} AND u.id != ?
       AND (u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
       ORDER BY u.display_name COLLATE NOCASE LIMIT ?`,
    )
    .bind(...scopeArgs(scope), v.member?.id ?? '', `%${q}%`, `${q}%`, PICK_LIMIT)
    .all();
  return json({ people: results.map((r) => ({ id: r.id, name: r.display_name, username: r.username })) }, 200, { 'Cache-Control': 'private, no-store' });
}
