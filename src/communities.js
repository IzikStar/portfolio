// Communities: groups of members the owner defines. They are not tied to the
// wings; any item or space can be opened to any set of them ("nonsense humor"
// may get sketches, dubs and songs alike, a book has its beta readers).
//
//   joinMode 'request'  members can ask to join, the owner approves
//            'closed'   by invitation only (an invite link, or the owner adds them)
//   hidden              outsiders never see it: not on /community, no lock on
//                       its items, no "ask to join". Its members see it as usual.
//
// Who belongs where is read once per request in access() (src/spaces.js).
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { slugify } from './entries.js';

export const JOIN_MODES = ['request', 'closed'];

export function communityFromRow(r) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    joinMode: r.join_mode,
    hidden: Boolean(r.hidden),
    meta: JSON.parse(r.meta || '{}'),
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function loadCommunities(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM communities ORDER BY sort, title').all();
  return results.map(communityFromRow);
}

// A list of community ids from the client, kept to ones that exist.
export function cleanCommunityIds(value, known) {
  if (!Array.isArray(value)) throw new HttpError(400, 'communities must be a list.');
  return [...new Set(value.map(String))].filter((id) => known.has(id)).slice(0, 50);
}

export const pathOf = (c) => `/community/${encodeURIComponent(c.slug)}`;

// ---------- what a viewer may know ----------

// May this viewer know that the community exists (see its page, its name)?
export const knows = (acc, c) => Boolean(c) && (acc.owner || !c.hidden || acc.communities.has(c.id) || acc.pending.has(c.id));

// The communities among `ids` this viewer could still ask to join or hear
// about: the ones they are not in, that are not hidden from them.
export const outsideOf = (acc, ids) =>
  (ids ?? []).map((id) => acc.commById.get(id)).filter((c) => c && !acc.communities.has(c.id) && knows(acc, c));

// ---------- members ----------

export async function requestJoin(request, env, v, id) {
  if (!v.member) throw new HttpError(401, 'Sign in first.');
  const c = v.acc.commById.get(id);
  if (!knows(v.acc, c)) throw new HttpError(404, 'No such community.');
  if (c.joinMode === 'closed') throw new HttpError(403, 'This community is by invitation only.');
  const { note } = await readJson(request);
  await addRequest(env, v.member.id, c.id, note);
  const d = await db(env);
  const row = await d.prepare('SELECT status FROM community_members WHERE community_id = ? AND user_id = ?').bind(c.id, v.member.id).first();
  return json({ status: row.status, communityId: c.id }, 201);
}

// Ask for several communities at once (the join page's checkboxes). Only the
// ones this viewer may know that take requests count; the ones they are
// already in, or already asked for, are left as they are.
export async function addRequests(env, acc, userId, ids, note) {
  const wanted = (Array.isArray(ids) ? ids : []).map(String).slice(0, 50);
  const asked = [...new Set(wanted)].map((id) => acc.commById.get(id)).filter((c) => knows(acc, c) && c.joinMode === 'request' && !acc.communities.has(c.id));
  for (const c of asked) await addRequest(env, userId, c.id, note);
  return asked.map((c) => c.id);
}

export async function requestJoinMany(request, env, v) {
  if (!v.member) throw new HttpError(401, 'Sign in first.');
  const { communities, note } = await readJson(request);
  const asked = await addRequests(env, v.acc, v.member.id, communities, note);
  if (!asked.length) throw new HttpError(400, 'Pick at least one community.');
  return json({ status: 'pending', communities: asked }, 201);
}

// Sign-up from a community's page asks for that community too.
export async function addRequest(env, userId, communityId, note) {
  const d = await db(env);
  await d
    .prepare(`INSERT OR IGNORE INTO community_members (community_id, user_id, status, note, created_at) VALUES (?, ?, 'pending', ?, ?)`)
    .bind(communityId, userId, cleanText(note, 600), new Date().toISOString())
    .run();
}

// An invite that names communities puts the new member straight in.
export async function addActive(env, userId, ids) {
  if (!ids.length) return;
  const d = await db(env);
  const now = new Date().toISOString();
  await d.batch(
    ids.map((id) =>
      d
        .prepare(
          `INSERT INTO community_members (community_id, user_id, status, note, created_at, decided_at) VALUES (?, ?, 'active', '', ?, ?)
           ON CONFLICT(community_id, user_id) DO UPDATE SET status = 'active', decided_at = excluded.decided_at`,
        )
        .bind(id, userId, now, now),
    ),
  );
}

// For the join page: the community a visitor came from, if they may know it.
export async function publicCommunities(env, acc) {
  return json(
    {
      communities: acc.comms
        .filter((c) => knows(acc, c))
        .map((c) => ({
          id: c.id,
          slug: c.slug,
          title: c.title,
          summary: c.summary,
          joinMode: c.joinMode,
          path: pathOf(c),
          membership: acc.owner ? 'owner' : acc.communities.has(c.id) ? 'active' : acc.pending.has(c.id) ? 'pending' : null,
        })),
    },
    200,
    { 'Cache-Control': 'private, no-store' },
  );
}

// ---------- owner (studio) ----------

function apply(c, body) {
  if ('title' in body) c.title = cleanText(body.title, 120);
  if ('summary' in body) c.summary = cleanText(body.summary, 1000);
  if ('joinMode' in body) {
    if (!JOIN_MODES.includes(body.joinMode)) throw new HttpError(400, 'Unknown join mode.');
    c.joinMode = body.joinMode;
  }
  if ('hidden' in body) c.hidden = Boolean(body.hidden);
  if ('sort' in body) c.sort = Math.round(Number(body.sort) || 0);
  if ('meta' in body) {
    if (typeof body.meta !== 'object' || body.meta === null || Array.isArray(body.meta)) throw new HttpError(400, 'meta must be an object.');
    if (JSON.stringify(body.meta).length > 20_000) throw new HttpError(400, 'meta is too large.');
    c.meta = body.meta;
  }
  if ('slug' in body) c.slug = slugify(body.slug);
  if (!c.title) throw new HttpError(400, 'Give it a name.');
  if (!c.slug) c.slug = slugify(c.title) || c.id.slice(0, 8);
  return c;
}

async function write(env, c, insert) {
  const d = await db(env);
  const row = [c.slug, c.title, c.summary, c.joinMode, c.hidden ? 1 : 0, JSON.stringify(c.meta), c.sort, c.updatedAt];
  try {
    if (insert) {
      await d
        .prepare(`INSERT INTO communities (slug, title, summary, join_mode, hidden, meta, sort, updated_at, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(...row, c.id, c.createdAt)
        .run();
    } else {
      await d
        .prepare(`UPDATE communities SET slug = ?, title = ?, summary = ?, join_mode = ?, hidden = ?, meta = ?, sort = ?, updated_at = ? WHERE id = ?`)
        .bind(...row, c.id)
        .run();
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'Another community already uses that address.');
    throw err;
  }
}

export async function studioCommunities(env) {
  const d = await db(env);
  const [list, members, entries, spaces] = await Promise.all([
    loadCommunities(env),
    d.prepare('SELECT community_id, status, COUNT(*) AS n FROM community_members GROUP BY community_id, status').all(),
    d.prepare('SELECT j.value AS id, COUNT(*) AS n FROM entries, json_each(entries.communities) j GROUP BY j.value').all(),
    d.prepare('SELECT j.value AS id, COUNT(*) AS n FROM spaces, json_each(spaces.communities) j GROUP BY j.value').all(),
  ]);
  const tally = new Map();
  for (const r of members.results) tally.set(r.community_id, { ...(tally.get(r.community_id) ?? {}), [r.status]: r.n });
  const items = new Map(entries.results.map((r) => [r.id, r.n]));
  const places = new Map(spaces.results.map((r) => [r.id, r.n]));
  return json({
    communities: list.map((c) => ({
      ...c,
      path: pathOf(c),
      members: tally.get(c.id)?.active ?? 0,
      requests: tally.get(c.id)?.pending ?? 0,
      entries: items.get(c.id) ?? 0,
      spaces: places.get(c.id) ?? 0,
    })),
  });
}

export async function createCommunity(request, env) {
  const now = new Date().toISOString();
  const c = { id: crypto.randomUUID(), slug: '', title: '', summary: '', joinMode: 'request', hidden: false, meta: {}, sort: 0, createdAt: now, updatedAt: now };
  apply(c, await readJson(request));
  await write(env, c, true);
  return json({ ...c, path: pathOf(c) }, 201);
}

async function getCommunity(env, id) {
  const d = await db(env);
  const row = await d.prepare('SELECT * FROM communities WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'That community no longer exists.');
  return communityFromRow(row);
}

export async function updateCommunity(request, env, id) {
  const c = await getCommunity(env, id);
  apply(c, await readJson(request));
  c.updatedAt = new Date().toISOString();
  await write(env, c, false);
  return json({ ...c, path: pathOf(c) });
}

// Deleting a community takes it off every item and space; items that were
// open to it alone fall back to the owner only. Its blog goes with it.
export async function deleteCommunity(env, id) {
  await getCommunity(env, id);
  const d = await db(env);
  const drop = (table) =>
    d
      .prepare(
        `UPDATE ${table} SET communities = (SELECT json_group_array(value) FROM json_each(${table}.communities) WHERE value != ?)
         WHERE EXISTS (SELECT 1 FROM json_each(${table}.communities) WHERE value = ?)`,
      )
      .bind(id, id);
  await d.batch([
    drop('entries'),
    drop('spaces'),
    d.prepare('DELETE FROM community_members WHERE community_id = ?').bind(id),
    d.prepare('DELETE FROM communities WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// Requests and members of one community.
export async function communityMembers(env, id) {
  await getCommunity(env, id);
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT m.user_id, m.status, m.note, m.created_at, m.decided_at, u.username, u.display_name, u.status AS user_status
       FROM community_members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? ORDER BY m.status = 'pending' DESC, m.created_at DESC`,
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

// Approve, refuse, add or remove. Approving someone whose account still
// waits for approval activates the account too: saying yes is enough.
export async function decideMember(request, env, id) {
  const { userId, status } = await readJson(request);
  await getCommunity(env, id);
  const d = await db(env);
  const user = await d.prepare('SELECT id, status FROM users WHERE id = ?').bind(String(userId ?? '')).first();
  if (!user) throw new HttpError(404, 'That member no longer exists.');
  if (status === 'removed') {
    await d.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').bind(id, user.id).run();
    return json({ ok: true });
  }
  if (!['active', 'refused'].includes(status)) throw new HttpError(400, 'Unknown status.');
  const now = new Date().toISOString();
  await d
    .prepare(
      `INSERT INTO community_members (community_id, user_id, status, note, created_at, decided_at) VALUES (?, ?, ?, '', ?, ?)
       ON CONFLICT(community_id, user_id) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at`,
    )
    .bind(id, user.id, status, now, now)
    .run();
  if (status === 'active' && user.status === 'pending') await d.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(user.id).run();
  return json({ ok: true });
}

// One person, many communities: the owner ticks the communities a member
// should be in and saves. Ticked ones become active (approving any request),
// unticked memberships end and unticked requests are refused. Saying yes to
// someone whose account still waits activates the account too.
export async function setMemberships(request, env, userId) {
  const { communities } = await readJson(request);
  const known = new Set((await loadCommunities(env)).map((c) => c.id));
  const want = new Set(cleanCommunityIds(communities, known));
  const d = await db(env);
  const user = await d.prepare('SELECT id, status FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new HttpError(404, 'That member no longer exists.');
  const { results } = await d.prepare('SELECT community_id, status FROM community_members WHERE user_id = ?').bind(userId).all();
  const had = new Map(results.map((r) => [r.community_id, r.status]));
  const now = new Date().toISOString();
  const out = [];
  for (const id of want) {
    if (had.get(id) === 'active') continue;
    out.push(
      d
        .prepare(
          `INSERT INTO community_members (community_id, user_id, status, note, created_at, decided_at) VALUES (?, ?, 'active', '', ?, ?)
           ON CONFLICT(community_id, user_id) DO UPDATE SET status = 'active', decided_at = excluded.decided_at`,
        )
        .bind(id, userId, now, now),
    );
  }
  for (const [id, status] of had) {
    if (want.has(id)) continue;
    if (status === 'active') out.push(d.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').bind(id, userId));
    else if (status === 'pending') out.push(d.prepare(`UPDATE community_members SET status = 'refused', decided_at = ? WHERE community_id = ? AND user_id = ?`).bind(now, id, userId));
  }
  if (want.size && user.status === 'pending') out.push(d.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(userId));
  if (out.length) await d.batch(out);
  return json({ ok: true, communities: [...want] });
}
