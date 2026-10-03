// Spaces: the wings of the site (music, books, ...) and what lives inside
// them (a book, a sketch series, a genre). Every wing has a community, and so
// does any space marked own_community (a book's beta readers); other spaces
// share the community of the nearest ancestor that has one.
//
// Who may see what is worked out once per request in access(): the spaces the
// viewer may open and the communities they belong to. Entry queries take the
// result as a SQL filter.
import { db, VISIBILITY, WINGS } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { slugify } from './entries.js';

const SPACE_KINDS = ['wing', 'book', 'series', 'genre', 'collection'];
const JOIN_MODES = ['request', 'closed'];

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
    joinMode: r.join_mode,
    ownCommunity: Boolean(r.own_community),
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

// The space whose community decides access to `id`: itself or its nearest
// ancestor with its own community. Wings always have one.
export function communityOf(byId, id) {
  for (let s = byId.get(id), hops = 0; s && hops < 20; s = byId.get(s.parentId), hops++) {
    if (s.ownCommunity || !s.parentId) return s.id;
  }
  return null;
}

// What this viewer may open. v = { role, member } from the worker.
export async function access(env, v) {
  const spaces = await loadSpaces(env);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  if (v.role === 'owner') {
    return { owner: true, member: false, spaces, byId, visible: new Set(byId.keys()), communities: new Set(byId.keys()), pending: new Set() };
  }
  const joined = new Set();
  const pending = new Set();
  if (v.member) {
    const d = await db(env);
    const { results } = await d.prepare(`SELECT space_id, status FROM space_members WHERE user_id = ?`).bind(v.member.id).all();
    for (const r of results) (r.status === 'active' ? joined : r.status === 'pending' ? pending : new Set()).add(r.space_id);
  }
  const inCommunity = (id) => joined.has(communityOf(byId, id));
  const allows = (vis, id) => vis === 'public' || (vis === 'members' && Boolean(v.member)) || (vis === 'community' && inCommunity(id));
  const visible = new Set();
  const seen = new Map();
  const isVisible = (s, depth = 0) => {
    if (!s || depth > 20) return false;
    if (seen.has(s.id)) return seen.get(s.id);
    const ok = allows(s.visibility, s.id) && (!s.parentId || isVisible(byId.get(s.parentId), depth + 1));
    seen.set(s.id, ok);
    return ok;
  };
  for (const s of spaces) if (isVisible(s)) visible.add(s.id);
  const communities = new Set(spaces.filter((s) => inCommunity(s.id)).map((s) => s.id));
  return { owner: false, member: Boolean(v.member), spaces, byId, visible, communities, pending };
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
        OR (visibility = 'community' AND (space_id IN (SELECT value FROM json_each(?)) OR (space_id IS NULL AND ? = 1))))`,
    args: [JSON.stringify([...acc.visible]), acc.member ? 1 : 0, JSON.stringify([...acc.communities]), acc.member ? 1 : 0],
  };
}

// The same rule for one entry already in hand.
export function canSee(acc, entry) {
  if (acc.owner) return true;
  if (entry.status !== 'published') return false;
  if (entry.spaceId && !acc.visible.has(entry.spaceId)) return false;
  if (entry.visibility === 'public') return true;
  if (entry.visibility === 'members') return acc.member;
  if (entry.visibility === 'community') return entry.spaceId ? acc.communities.has(entry.spaceId) : acc.member;
  return false;
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

// The spaces this viewer can open, with where they stand in each community.
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
      joinMode: s.joinMode,
      ownCommunity: s.ownCommunity || !s.parentId,
      ...(acc.owner ? { visibility: s.visibility } : {}),
      membership: acc.owner ? 'owner' : acc.communities.has(s.id) ? 'active' : acc.pending.has(communityOf(acc.byId, s.id)) ? 'pending' : null,
    }));
  return json({ spaces }, 200, { 'Cache-Control': 'private, no-store' });
}

// A signed-in member asks to join a space's community.
export async function requestJoin(request, env, v, id) {
  if (!v.member) throw new HttpError(401, 'Sign in first.');
  const acc = await access(env, v);
  const target = communityOf(acc.byId, id);
  const space = acc.byId.get(target);
  if (!space || !acc.visible.has(id)) throw new HttpError(404, 'No such space.');
  if (space.joinMode === 'closed') throw new HttpError(403, 'This community is by invitation only.');
  const { note } = await readJson(request);
  await addRequest(env, v.member.id, target, note);
  const d = await db(env);
  const row = await d.prepare('SELECT status FROM space_members WHERE space_id = ? AND user_id = ?').bind(target, v.member.id).first();
  return json({ status: row.status, spaceId: target }, 201);
}

// Used by sign-up too: someone who signs up from a book page asks for that book.
export async function addRequest(env, userId, spaceId, note) {
  const d = await db(env);
  await d
    .prepare(`INSERT OR IGNORE INTO space_members (space_id, user_id, status, note, created_at) VALUES (?, ?, 'pending', ?, ?)`)
    .bind(spaceId, userId, cleanText(note, 600), new Date().toISOString())
    .run();
}

// ---------- owner (studio) ----------

function pick(value, allowed, field) {
  if (!allowed.includes(value)) throw new HttpError(400, `Unknown ${field}.`);
  return value;
}

export async function studioSpaces(env) {
  const d = await db(env);
  const [spaces, counts, members] = await Promise.all([
    loadSpaces(env),
    d.prepare('SELECT space_id, COUNT(*) AS n FROM entries GROUP BY space_id').all(),
    d.prepare('SELECT space_id, status, COUNT(*) AS n FROM space_members GROUP BY space_id, status').all(),
  ]);
  const entries = new Map(counts.results.map((r) => [r.space_id, r.n]));
  const tally = new Map();
  for (const r of members.results) tally.set(r.space_id, { ...(tally.get(r.space_id) ?? {}), [r.status]: r.n });
  return json({
    wings: WINGS,
    spaces: spaces.map((s) => ({ ...s, entries: entries.get(s.id) ?? 0, members: tally.get(s.id)?.active ?? 0, requests: tally.get(s.id)?.pending ?? 0 })),
  });
}

function applySpace(space, body, byId) {
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
  if ('joinMode' in body) space.joinMode = pick(body.joinMode, JOIN_MODES, 'join mode');
  if ('ownCommunity' in body && space.parentId) space.ownCommunity = Boolean(body.ownCommunity);
  if ('sort' in body) space.sort = Math.round(Number(body.sort) || 0);
  if ('meta' in body) {
    if (typeof body.meta !== 'object' || body.meta === null || Array.isArray(body.meta)) throw new HttpError(400, 'meta must be an object.');
    if (JSON.stringify(body.meta).length > 20_000) throw new HttpError(400, 'meta is too large.');
    space.meta = body.meta;
  }
  if ('slug' in body) space.slug = slugify(body.slug);
  if (!space.title) throw new HttpError(400, 'Give it a name.');
  if (!space.slug) space.slug = slugify(space.title) || space.id.slice(0, 8);
  return space;
}

async function writeSpace(env, s, insert) {
  const d = await db(env);
  const row = [s.wing, s.parentId, s.slug, s.kind, s.title, s.summary, s.visibility, s.joinMode, s.ownCommunity ? 1 : 0, JSON.stringify(s.meta), s.sort, s.updatedAt];
  try {
    if (insert) {
      await d
        .prepare(
          `INSERT INTO spaces (wing, parent_id, slug, kind, title, summary, visibility, join_mode, own_community, meta, sort, updated_at, id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...row, s.id, s.createdAt)
        .run();
    } else {
      await d
        .prepare(
          `UPDATE spaces SET wing = ?, parent_id = ?, slug = ?, kind = ?, title = ?, summary = ?, visibility = ?, join_mode = ?,
           own_community = ?, meta = ?, sort = ?, updated_at = ? WHERE id = ?`,
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
    joinMode: 'request',
    ownCommunity: body.kind === 'book',
    meta: {},
    sort: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (!byId.has(body.parentId)) throw new HttpError(400, 'Pick where this lives.');
  applySpace(space, { kind: 'collection', ...body }, byId);
  await writeSpace(env, space, true);
  return json(space, 201);
}

export async function updateSpace(request, env, id) {
  const spaces = await loadSpaces(env);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const space = byId.get(id);
  if (!space) throw new HttpError(404, 'That space no longer exists.');
  applySpace(space, await readJson(request), byId);
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
  await d.batch([d.prepare('DELETE FROM space_members WHERE space_id = ?').bind(id), d.prepare('DELETE FROM spaces WHERE id = ?').bind(id)]);
  return json({ ok: true });
}

// Requests and members of one community.
export async function spaceMembers(env, id) {
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT m.user_id, m.status, m.note, m.created_at, m.decided_at, u.username, u.display_name, u.status AS user_status
       FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.status = 'pending' DESC, m.created_at DESC`,
    )
    .bind(id)
    .all();
  return json({
    members: results.map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      status: r.status,
      note: r.note,
      accountPending: r.user_status === 'pending',
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    })),
  });
}

// Approve, refuse or remove. Approving someone whose account still waits
// for approval activates the account too: saying yes to a beta reader is enough.
export async function decideMember(request, env, spaceId) {
  const { userId, status } = await readJson(request);
  const d = await db(env);
  if (!(await d.prepare('SELECT id FROM spaces WHERE id = ?').bind(spaceId).first())) throw new HttpError(404, 'That space no longer exists.');
  const user = await d.prepare('SELECT id, status FROM users WHERE id = ?').bind(String(userId ?? '')).first();
  if (!user) throw new HttpError(404, 'That member no longer exists.');
  const now = new Date().toISOString();
  if (status === 'removed') {
    await d.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').bind(spaceId, user.id).run();
    return json({ ok: true });
  }
  pick(status, ['active', 'refused'], 'status');
  await d
    .prepare(
      `INSERT INTO space_members (space_id, user_id, status, note, created_at, decided_at) VALUES (?, ?, ?, '', ?, ?)
       ON CONFLICT(space_id, user_id) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at`,
    )
    .bind(spaceId, user.id, status, now, now)
    .run();
  if (status === 'active' && user.status === 'pending') await d.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(user.id).run();
  return json({ ok: true });
}
