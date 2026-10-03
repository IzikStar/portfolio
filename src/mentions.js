// Tagging members: "@" in a comment or a blog post. The text stores a token,
// @{<user id>}, so a rename shows everywhere at once; pages turn the token into
// a name chip. A token only survives a save when that person is an active
// member of the community the text lives in, so nobody can tag (or find out
// the names of) people outside it. Each tag is also a row in `mentions`, which
// is what the tagged member sees on their page.
import { db } from './db.js';
import { HttpError, json, cleanText } from './http.js';
import { communityOf } from './spaces.js';
import { escapeHtml as e } from './markdown.js';

const TOKEN = /@\{([0-9a-f-]{36})\}/g;
const MAX_TAGS = 20;
const PICK_LIMIT = 8;

const idsIn = (text) => [...new Set([...String(text ?? '').matchAll(TOKEN)].map((m) => m[1]))];

// Active members of one community (a wing, or a space with its own community).
async function membersAmong(env, communityId, ids) {
  if (!ids.length) return new Set();
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT u.id FROM space_members m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = ? AND m.status = 'active' AND u.status = 'active' AND u.id IN (SELECT value FROM json_each(?))`,
    )
    .bind(communityId, JSON.stringify(ids))
    .all();
  return new Set(results.map((r) => r.id));
}

// Keep the tags that point at members of this community and drop the rest.
// Returns the cleaned text and who is tagged in it.
export async function cleanMentions(env, communityId, text) {
  const wanted = idsIn(text).slice(0, MAX_TAGS);
  const ok = await membersAmong(env, communityId, wanted);
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

// dir=auto keeps the @ in front of a Latin name inside Hebrew text.
export const chip = (name, at = '@') => `<span class="mention" dir="auto">${at}${e(name)}</span>`;

// Turn tokens in already-escaped HTML into chips. Only text between tags is
// touched, so a token inside an attribute (an image's alt text) stays inert.
export function withMentions(html, names) {
  return String(html)
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : part.replace(TOKEN, (m, id) => (names.has(id) ? chip(names.get(id)) : ''))))
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

// GET /api/people?space=<id>&q=<start of a name>. Open to the owner and to
// members of that space's community, and lists only that community.
export async function people(env, v, url) {
  if (v.role === 'public') throw new HttpError(401, 'Sign in first.');
  const { acc } = v;
  const spaceId = String(url.searchParams.get('space') ?? '');
  const target = communityOf(acc.byId, spaceId);
  if (!target || !acc.visible.has(spaceId)) throw new HttpError(404, 'No such space.');
  if (!acc.owner && !acc.communities.has(target)) throw new HttpError(403, 'Only this community can tag its members.');
  const q = cleanText(url.searchParams.get('q'), 40).replace(/[\\%_]/g, (c) => `\\${c}`);
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT u.id, u.display_name, u.username FROM space_members m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = ? AND m.status = 'active' AND u.status = 'active' AND u.id != ?
       AND (u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
       ORDER BY u.display_name COLLATE NOCASE LIMIT ?`,
    )
    .bind(target, v.member?.id ?? '', `%${q}%`, `${q}%`, PICK_LIMIT)
    .all();
  return json({ people: results.map((r) => ({ id: r.id, name: r.display_name, username: r.username })) }, 200, { 'Cache-Control': 'private, no-store' });
}
