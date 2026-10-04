// Spaces: the wings of the site (music, books, ...) and what lives inside
// them (a book, a sketch series, a genre). Spaces are structure only; who may
// see what comes from visibility and from communities (src/communities.js),
// which stand apart from the wings.
//
// Who may see what is worked out once per request in access(): the spaces the
// viewer may open and the communities they belong to. Entry queries take the
// result as a SQL filter.
import { db, VISIBILITY, WINGS } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { slugify, RESERVED_SLUGS } from './entries.js';
import { loadCommunities, cleanCommunityIds } from './communities.js';

const SPACE_KINDS = ['wing', 'book', 'series', 'genre', 'collection'];

function fromRow(r) {
  return {
    id: r.id,
    wing: r.wing,
    parentId: r.parent_id,
    slug: r.slug,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    visibility: r.visibility,
    communities: JSON.parse(r.communities || '[]'),
    meta: JSON.parse(r.meta || '{}'),
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function loadSpaces(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM spaces ORDER BY sort, created_at').all();
  return results.map(fromRow);
}

// What this viewer may open. v = { role, member } from the worker.
//   communities  ids of the communities they are in (the owner: all of them)
//   pending      ids they asked to join
//   comms, commById  every community (pages decide what to reveal, see knows())
export async function access(env, v) {
  const [spaces, comms] = await Promise.all([loadSpaces(env), loadCommunities(env)]);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const commById = new Map(comms.map((c) => [c.id, c]));
  if (v.role === 'owner') {
    return { owner: true, member: false, spaces, byId, comms, commById, visible: new Set(byId.keys()), communities: new Set(commById.keys()), pending: new Set() };
  }
  const joined = new Set();
  const pending = new Set();
  if (v.member) {
    const d = await db(env);
    const { results } = await d.prepare(`SELECT community_id, status FROM community_members WHERE user_id = ?`).bind(v.member.id).all();
    for (const r of results) {
      if (!commById.has(r.community_id)) continue;
      if (r.status === 'active') joined.add(r.community_id);
      else if (r.status === 'pending') pending.add(r.community_id);
    }
  }
  const acc = { owner: false, member: Boolean(v.member), spaces, byId, comms, commById, communities: joined, pending, visible: new Set() };
  const seen = new Map();
  const isVisible = (s, depth = 0) => {
    if (!s || depth > 20) return false;
    if (seen.has(s.id)) return seen.get(s.id);
    const ok = allows(acc, s.visibility, s.communities) && (!s.parentId || isVisible(byId.get(s.parentId), depth + 1));
    seen.set(s.id, ok);
    return ok;
  };
  for (const s of spaces) if (isVisible(s)) acc.visible.add(s.id);
  return acc;
}

// Is this viewer in any of these communities?
export const inAny = (acc, ids) => acc.owner || (ids ?? []).some((id) => acc.communities.has(id));

// The visibility rule for anything that has a visibility and a list of communities.
export function allows(acc, visibility, communities) {
  if (acc.owner) return true;
  if (visibility === 'public') return true;
  if (visibility === 'members') return acc.member;
  if (visibility === 'community') return inAny(acc, communities);
  return false;
}

// SQL condition on entries for "this viewer may read it in a listing".
// Listings show published items only, to the owner too; drafts live in the studio.
export function entryFilter(acc) {
  if (acc.owner) return { sql: `status = 'published'`, args: [] };
  return {
    sql: `status = 'published'
      AND (space_id IS NULL OR space_id IN (SELECT value FROM json_each(?)))
      AND (visibility = 'public'
        OR (visibility = 'members' AND ? = 1)
        OR (visibility = 'community' AND EXISTS (SELECT 1 FROM json_each(entries.communities) c WHERE c.value IN (SELECT value FROM json_each(?)))))`,
    args: [JSON.stringify([...acc.visible]), acc.member ? 1 : 0, JSON.stringify([...acc.communities])],
  };
}

// The same rule for one entry already in hand.
export function canSee(acc, entry) {
  if (acc.owner) return true;
  if (entry.status !== 'published') return false;
  if (entry.spaceId && !acc.visible.has(entry.spaceId)) return false;
  return allows(acc, entry.visibility, entry.communities);
}

// True when anyone at all may read this entry (so caches may keep it).
export function isPublicEntry(acc, entry) {
  if (entry.status !== 'published' || entry.visibility !== 'public') return false;
  for (let s = acc.byId.get(entry.spaceId), hops = 0; s && hops < 20; s = acc.byId.get(s.parentId), hops++) {
    if (s.visibility !== 'public') return false;
  }
  return true;
}

// ---------- visitors ----------

// The spaces this viewer can open.
export async function listSpaces(env, acc) {
  const spaces = acc.spaces
    .filter((s) => acc.visible.has(s.id))
    .map((s) => ({
      id: s.id,
      wing: s.wing,
      parentId: s.parentId,
      slug: s.slug,
      kind: s.kind,
      title: s.title,
      summary: s.summary,
      ...(acc.owner ? { visibility: s.visibility, communities: s.communities } : {}),
    }));
  return json({ spaces }, 200, { 'Cache-Control': 'private, no-store' });
}

// ---------- owner (studio) ----------

function pick(value, allowed, field) {
  if (!allowed.includes(value)) throw new HttpError(400, `Unknown ${field}.`);
  return value;
}

export async function studioSpaces(env) {
  const d = await db(env);
  const [spaces, counts] = await Promise.all([loadSpaces(env), d.prepare('SELECT space_id, COUNT(*) AS n FROM entries GROUP BY space_id').all()]);
  const entries = new Map(counts.results.map((r) => [r.space_id, r.n]));
  return json({ wings: WINGS, spaces: spaces.map((s) => ({ ...s, entries: entries.get(s.id) ?? 0 })) });
}

function applySpace(space, body, byId, known) {
  if ('kind' in body && space.kind !== 'wing') space.kind = pick(body.kind, SPACE_KINDS.slice(1), 'kind');
  if ('parentId' in body && space.kind !== 'wing') {
    const parent = byId.get(body.parentId);
    if (!parent) throw new HttpError(400, 'Pick where this lives.');
    // No loops: the new parent may not sit inside this space.
    for (let p = parent, hops = 0; p; p = byId.get(p.parentId), hops++) {
      if (p.id === space.id || hops > 20) throw new HttpError(400, 'A space cannot live inside itself.');
    }
    space.parentId = parent.id;
    space.wing = parent.wing;
  }
  if ('title' in body) space.title = cleanText(body.title, 120);
  if ('summary' in body) space.summary = cleanText(body.summary, 1000);
  if ('visibility' in body) space.visibility = pick(body.visibility, VISIBILITY, 'visibility');
  if ('communities' in body) space.communities = cleanCommunityIds(body.communities, known);
  if ('sort' in body) space.sort = Math.round(Number(body.sort) || 0);
  if ('meta' in body) {
    if (typeof body.meta !== 'object' || body.meta === null || Array.isArray(body.meta)) throw new HttpError(400, 'meta must be an object.');
    if (JSON.stringify(body.meta).length > 20_000) throw new HttpError(400, 'meta is too large.');
    space.meta = body.meta;
  }
  if ('slug' in body) space.slug = slugify(body.slug);
  if ('slug' in body && RESERVED_SLUGS.includes(space.slug)) throw new HttpError(400, 'That address is taken by the community blog. Pick another.');
  if (!space.title) throw new HttpError(400, 'Give it a name.');
  if (!space.slug) space.slug = slugify(space.title) || space.id.slice(0, 8);
  if (RESERVED_SLUGS.includes(space.slug)) space.slug += '-2';
  return space;
}

async function writeSpace(env, s, insert) {
  const d = await db(env);
  const row = [s.wing, s.parentId, s.slug, s.kind, s.title, s.summary, s.visibility, JSON.stringify(s.communities), JSON.stringify(s.meta), s.sort, s.updatedAt];
  try {
    if (insert) {
      await d
        .prepare(
          `INSERT INTO spaces (wing, parent_id, slug, kind, title, summary, visibility, communities, meta, sort, updated_at, id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...row, s.id, s.createdAt)
        .run();
    } else {
      await d
        .prepare(
          `UPDATE spaces SET wing = ?, parent_id = ?, slug = ?, kind = ?, title = ?, summary = ?, visibility = ?,
           communities = ?, meta = ?, sort = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(...row, s.id)
        .run();
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'Something else in this wing already uses that address.');
    throw err;
  }
}

export async function createSpace(request, env) {
  const body = await readJson(request);
  const spaces = await loadSpaces(env);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const now = new Date().toISOString();
  const space = {
    id: crypto.randomUUID(),
    wing: null,
    parentId: null,
    slug: '',
    kind: 'collection',
    title: '',
    summary: '',
    visibility: 'private',
    communities: [],
    meta: {},
    sort: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (!byId.has(body.parentId)) throw new HttpError(400, 'Pick where this lives.');
  applySpace(space, { kind: 'collection', ...body }, byId, await knownCommunities(env));
  await writeSpace(env, space, true);
  return json(space, 201);
}

export async function updateSpace(request, env, id) {
  const spaces = await loadSpaces(env);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const space = byId.get(id);
  if (!space) throw new HttpError(404, 'That space no longer exists.');
  applySpace(space, await readJson(request), byId, await knownCommunities(env));
  space.updatedAt = new Date().toISOString();
  await writeSpace(env, space, false);
  return json(space);
}

export async function deleteSpace(env, id) {
  const d = await db(env);
  const space = await d.prepare('SELECT kind FROM spaces WHERE id = ?').bind(id).first();
  if (!space) throw new HttpError(404, 'That space no longer exists.');
  if (space.kind === 'wing') throw new HttpError(400, 'Wings stay. Hide one by making it private.');
  const busy = await d
    .prepare('SELECT (SELECT COUNT(*) FROM entries WHERE space_id = ?) + (SELECT COUNT(*) FROM spaces WHERE parent_id = ?) AS n')
    .bind(id, id)
    .first();
  if (busy.n) throw new HttpError(409, 'Move or delete what is inside first.');
  await d.prepare('DELETE FROM spaces WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

export const knownCommunities = async (env) => new Set((await loadCommunities(env)).map((c) => c.id));
