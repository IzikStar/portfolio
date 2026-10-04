// Moving items: to another space, another wing, another kind (a "dvar Torah"
// that is really a comic article). The slug stays unique where the item lands,
// and a published item remembers the address it left (meta.oldPaths) so that
// links to it keep working: the old address answers 301 to the new one.
import { db } from './db.js';
import { HttpError, json, readJson } from './http.js';
import { getEntry, saveEntry } from './entries.js';
import { loadSpaces, canSee } from './spaces.js';

// The kinds that belong in each wing; the first one is what an item becomes
// when it moves in with a kind that does not fit. (The studio has the same list.)
export const WING_KINDS = {
  music: ['song', 'video'],
  books: ['chapter'],
  sketches: ['sketch', 'video'],
  humor: ['dub', 'humor', 'video'],
  torah: ['torah'],
  articles: ['article'],
  software: ['project', 'work'],
  videos: ['video', 'work'],
};

const MAX_OLD_PATHS = 20;

function wingIdOf(byId, spaceId) {
  let s = byId.get(spaceId);
  for (let hops = 0; s?.parentId && hops < 20; hops++) s = byId.get(s.parentId);
  return s?.id ?? null;
}

// An item's address as the router sees it (decoded), or null if it has none.
function rawPath(byId, spaceId, slug) {
  const s = byId.get(spaceId);
  if (!s || !slug) return null;
  return s.parentId ? `/${s.wing}/${s.slug}/${slug}` : `/${s.id}/${slug}`;
}

// Nothing else of the same kind, and nothing else in the same space, may use
// the slug (the first is the database's rule, the second the router's).
async function freeSlug(d, entry) {
  if (!entry.slug) return;
  const base = entry.slug;
  for (let n = 2; n < 100; n++) {
    const taken = await d
      .prepare('SELECT 1 FROM entries WHERE id != ? AND slug = ? AND (kind = ? OR space_id = ?) LIMIT 1')
      .bind(entry.id, entry.slug, entry.kind, entry.spaceId ?? '')
      .first();
    if (!taken) return;
    entry.slug = `${base}-${n}`;
  }
  throw new HttpError(409, 'Could not find a free address (slug) for this item.');
}

// Call after an entry's space or kind changed; `before` is how it was.
export async function settle(env, entry, before, byId) {
  if (entry.spaceId === before.spaceId && entry.kind === before.kind) return;
  const d = await db(env);
  byId ??= new Map((await loadSpaces(env)).map((s) => [s.id, s]));
  await freeSlug(d, entry);
  const now = rawPath(byId, entry.spaceId, entry.slug);
  const old = before.status === 'published' ? rawPath(byId, before.spaceId, before.slug) : null;
  const kept = (Array.isArray(entry.meta?.oldPaths) ? entry.meta.oldPaths : []).filter((p) => p !== now && p !== old);
  const oldPaths = old && old !== now ? [old, ...kept] : kept;
  const { oldPaths: _prev, ...meta } = entry.meta ?? {};
  entry.meta = oldPaths.length ? { ...meta, oldPaths: oldPaths.slice(0, MAX_OLD_PATHS) } : meta;
}

// POST /api/studio/entries/move { ids, spaceId, kind? }
// Without a kind, each item keeps its own when it fits the wing.
export async function moveEntries(request, env) {
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))].slice(0, 200) : [];
  if (!ids.length) throw new HttpError(400, 'Pick at least one item to move.');
  const byId = new Map((await loadSpaces(env)).map((s) => [s.id, s]));
  const target = byId.get(String(body.spaceId ?? ''));
  if (!target) throw new HttpError(400, 'That wing or space does not exist.');
  const fits = WING_KINDS[wingIdOf(byId, target.id)] ?? [];
  const kind = body.kind ? String(body.kind) : null;
  if (kind && !fits.includes(kind)) throw new HttpError(400, 'That kind does not belong in this wing.');

  const entries = await Promise.all(ids.map((id) => getEntry(env, id)));
  if (entries.some((x) => !x)) throw new HttpError(404, 'One of the items no longer exists.');
  const moved = [];
  // One at a time, so items moving together see each other's slugs.
  for (const entry of entries) {
    const before = { spaceId: entry.spaceId, kind: entry.kind, slug: entry.slug, status: entry.status };
    entry.spaceId = target.id;
    entry.kind = kind ?? (fits.includes(entry.kind) ? entry.kind : fits[0]);
    await settle(env, entry, before, byId);
    moved.push(await saveEntry(env, entry));
  }
  return json({ entries: moved });
}

// The item that used to live at `path` (decoded), if this viewer may see it.
export async function movedTo(env, acc, path) {
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT id FROM entries WHERE status = 'published'
       AND EXISTS (SELECT 1 FROM json_each(entries.meta, '$.oldPaths') WHERE value = ?) ORDER BY updated_at DESC LIMIT 5`,
    )
    .bind(path)
    .all();
  for (const r of results) {
    const entry = await getEntry(env, r.id);
    if (entry && canSee(acc, entry)) return entry;
  }
  return null;
}
