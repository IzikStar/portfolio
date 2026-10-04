// Entries: every piece of content on the platform (ideas, articles, projects,
// works). The owner manages them from the studio; visitors only ever get what
// their role may see. The same shape is what the future connector API serves.
import { db, KINDS, VISIBILITY, STATUS, WINGS } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { renderMarkdown, excerpt } from './markdown.js';
import { renderChords } from './chords.js';
import { entryFilter, canSee } from './spaces.js';
import { settle } from './moves.js';

const MAX_BODY = 200_000;
// Addresses taken by the site itself under every wing and space (/music/blog).
export const RESERVED_SLUGS = ['blog'];

// Where a new item goes when the studio does not say: the wing for its kind.
const HOME = { ...Object.fromEntries(WINGS.map((w) => [w.kind, w.id])), work: 'videos', humor: 'humor' };

export function fromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    spaceId: r.space_id ?? null,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    body: r.body,
    visibility: r.visibility,
    status: r.status,
    tags: JSON.parse(r.tags || '[]'),
    meta: JSON.parse(r.meta || '{}'),
    pinned: Boolean(r.pinned),
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  };
}

// Letters and digits in any script (Hebrew slugs are fine), dashes between words.
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  for (const t of list) {
    const tag = cleanText(t, 40).replace(/^#/, '');
    if (tag) seen.add(tag);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

// A project's source: a GitHub repo or a web page.
function cleanSource(src) {
  if (src == null || src === '') return null;
  if (src.type === 'github' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(src.repo ?? '') && !src.repo.includes('..')) return { type: 'github', repo: src.repo };
  if (src.type === 'url') {
    try {
      const u = new URL(src.url);
      if (u.protocol === 'https:' || u.protocol === 'http:') return { type: 'url', url: u.href };
    } catch {
      // fall through
    }
  }
  throw new HttpError(400, 'The source must be owner/repo, a GitHub link or a web address.');
}

// Credits on an item ("שירה: דנה"): who, by user id, and in what role.
function cleanCredits(list) {
  if (!Array.isArray(list)) return undefined;
  const out = list
    .filter((c) => c && /^[0-9a-f-]{36}$/.test(String(c.userId ?? '')))
    .map((c) => ({ role: cleanText(c.role, 40), userId: String(c.userId) }))
    .slice(0, 30);
  return out.length ? out : undefined;
}

function pick(value, allowed, field) {
  if (!allowed.includes(value)) throw new HttpError(400, `Unknown ${field}.`);
  return value;
}

// Apply a partial update from the client onto an entry (or a new one).
function applyFields(entry, body) {
  if ('kind' in body) entry.kind = pick(body.kind, KINDS, 'kind');
  if ('title' in body) entry.title = cleanText(body.title, 200);
  if ('summary' in body) entry.summary = cleanText(body.summary, 600);
  if ('body' in body) entry.body = String(body.body ?? '').slice(0, MAX_BODY);
  if ('visibility' in body) entry.visibility = pick(body.visibility, VISIBILITY, 'visibility');
  if ('status' in body) entry.status = pick(body.status, STATUS, 'status');
  if ('tags' in body) entry.tags = cleanTags(body.tags);
  if ('pinned' in body) entry.pinned = Boolean(body.pinned);
  if ('meta' in body) {
    if (typeof body.meta !== 'object' || body.meta === null || Array.isArray(body.meta)) throw new HttpError(400, 'meta must be an object.');
    // "synced" is written only by source sync, "oldPaths" only by moves; never by the client.
    const { synced: _ignored, oldPaths: _moved, ...rest } = body.meta;
    rest.source = cleanSource(rest.source);
    rest.credits = cleanCredits(rest.credits);
    if (!rest.credits) delete rest.credits;
    if (JSON.stringify(rest).length > 20_000) throw new HttpError(400, 'meta is too large.');
    const kept = { synced: entry.meta?.synced, oldPaths: entry.meta?.oldPaths };
    entry.meta = rest;
    for (const [k, v] of Object.entries(kept)) if (v) entry.meta[k] = v;
  }
  if ('slug' in body) entry.slug = slugify(body.slug) || null;
  if ('slug' in body && RESERVED_SLUGS.includes(entry.slug)) throw new HttpError(400, 'That address is taken by the community blog. Pick another.');
  if ('spaceId' in body) entry.spaceId = body.spaceId ? String(body.spaceId) : null;

  if (entry.status === 'published') {
    if (!entry.title) throw new HttpError(400, 'Give it a title before publishing.');
    if (!entry.slug) {
      entry.slug = slugify(entry.title) || entry.id.slice(0, 8);
      if (RESERVED_SLUGS.includes(entry.slug)) entry.slug += '-2';
      autoSlug.add(entry);
    }
    if (!entry.publishedAt) entry.publishedAt = new Date().toISOString();
  }
  return entry;
}

// Entries whose slug was made from the title: on a clash they get -2, -3, ...
// A slug the owner typed is kept as typed and a clash is an error instead.
const autoSlug = new WeakSet();

async function write(env, entry, insert) {
  const base = entry.slug;
  for (let n = 2; ; n++) {
    try {
      return await writeOnce(env, entry, insert);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 409 || !autoSlug.has(entry) || n > 50) throw err;
      entry.slug = `${base}-${n}`;
    }
  }
}

async function writeOnce(env, entry, insert) {
  const d = await db(env);
  if (entry.spaceId && !(await d.prepare('SELECT id FROM spaces WHERE id = ?').bind(entry.spaceId).first())) {
    throw new HttpError(400, 'That wing or space does not exist.');
  }
  const row = [
    entry.kind, entry.spaceId ?? null, entry.slug, entry.title, entry.summary, entry.body, entry.visibility, entry.status,
    JSON.stringify(entry.tags), JSON.stringify(entry.meta), entry.pinned ? 1 : 0, entry.updatedAt, entry.publishedAt,
  ];
  try {
    if (insert) {
      await d
        .prepare(
          `INSERT INTO entries (kind, space_id, slug, title, summary, body, visibility, status, tags, meta, pinned, updated_at, published_at, id, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...row, entry.id, entry.source, entry.createdAt)
        .run();
    } else {
      await d
        .prepare(
          `UPDATE entries SET kind = ?, space_id = ?, slug = ?, title = ?, summary = ?, body = ?, visibility = ?, status = ?, tags = ?, meta = ?,
           pinned = ?, updated_at = ?, published_at = ? WHERE id = ?`,
        )
        .bind(...row, entry.id)
        .run();
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'Another item of this type already uses that address (slug).');
    throw err;
  }
}

// Save an entry the server changed itself (source sync, imports).
export async function saveEntry(env, entry, insert = false) {
  entry.updatedAt = new Date().toISOString();
  await write(env, entry, insert);
  return entry;
}

export async function getEntry(env, id) {
  const d = await db(env);
  return fromRow(await d.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first());
}

// ---------- owner (studio) ----------

export async function studioList(env, url) {
  const d = await db(env);
  const kind = url.searchParams.get('kind');
  const space = url.searchParams.get('space');
  const q = cleanText(url.searchParams.get('q'), 100);
  const where = [];
  const args = [];
  if (space) {
    where.push('space_id = ?');
    args.push(space);
  }
  if (kind) {
    where.push('kind = ?');
    args.push(pick(kind, KINDS, 'kind'));
  }
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like);
  }
  const sql = `SELECT * FROM entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC LIMIT 500`;
  const { results } = await d.prepare(sql).bind(...args).all();
  return json({ entries: results.map(fromRow) });
}

export async function studioCreate(request, env, source = 'studio') {
  return json(await createEntry(env, await readJson(request), source), 201);
}

// A new entry from client fields. allowEmpty: an idea that is only a recording
// or a photo has no text yet.
export async function createEntry(env, body, source = 'studio', { allowEmpty = false } = {}) {
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    kind: 'idea',
    spaceId: null,
    slug: null,
    title: '',
    summary: '',
    body: '',
    visibility: 'private',
    status: 'draft',
    tags: [],
    meta: {},
    pinned: false,
    source,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
  };
  if (!('kind' in body)) throw new HttpError(400, 'Say what kind of item this is.');
  applyFields(entry, body);
  if (!('spaceId' in body)) entry.spaceId = HOME[entry.kind] ?? null;
  if (!entry.title && !entry.body.trim() && !entry.meta.source && !allowEmpty) throw new HttpError(400, 'Write something first.');
  await write(env, entry, true);
  return entry;
}

export async function studioUpdate(request, env, id) {
  const entry = await getEntry(env, id);
  if (!entry) throw new HttpError(404, 'That item no longer exists.');
  const body = await readJson(request);
  // Optimistic check: refuse to overwrite a newer save from another tab.
  if (body.baseUpdatedAt && body.baseUpdatedAt !== entry.updatedAt) {
    throw new HttpError(409, 'This item changed in another window. Reload it before saving.');
  }
  const before = { spaceId: entry.spaceId, kind: entry.kind, slug: entry.slug, status: entry.status };
  applyFields(entry, body);
  // Changing the space or the kind here is a move like any other.
  await settle(env, entry, before);
  if (entry.status === 'draft' && 'status' in body) entry.publishedAt = null;
  entry.updatedAt = new Date().toISOString();
  await write(env, entry, false);
  return json(entry);
}

export async function studioDelete(env, id) {
  const d = await db(env);
  const { meta } = await d.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  if (!meta.changes) throw new HttpError(404, 'That item no longer exists.');
  return json({ ok: true });
}

export async function preview(request) {
  const { body, mode } = await readJson(request);
  const text = String(body ?? '').slice(0, MAX_BODY);
  return json({ html: mode === 'chords' ? renderChords(text) : renderMarkdown(text) });
}

// ---------- visitors ----------
// acc is what access() in spaces.js worked out for this viewer.

export async function listVisible(env, acc, kind, limit = 100) {
  const d = await db(env);
  const f = entryFilter(acc);
  const { results } = await d
    .prepare(`SELECT * FROM entries WHERE kind = ? AND ${f.sql} ORDER BY pinned DESC, published_at DESC LIMIT ?`)
    .bind(kind, ...f.args, limit)
    .all();
  return results.map(fromRow);
}

// What one space shows: its own items and, for a wing, everything below it.
export async function listInSpace(env, acc, spaceIds, limit = 300) {
  const d = await db(env);
  const f = entryFilter(acc);
  const { results } = await d
    .prepare(
      `SELECT * FROM entries WHERE kind != 'idea' AND space_id IN (SELECT value FROM json_each(?)) AND ${f.sql}
       ORDER BY pinned DESC, COALESCE(json_extract(meta, '$.order'), 1e9), published_at DESC LIMIT ?`,
    )
    .bind(JSON.stringify(spaceIds), ...f.args, limit)
    .all();
  return results.map(fromRow);
}

// Everything published that this viewer may see, newest first (ideas never).
export async function listFeed(env, acc, limit = 100) {
  const d = await db(env);
  const f = entryFilter(acc);
  const { results } = await d
    .prepare(`SELECT * FROM entries WHERE kind != 'idea' AND ${f.sql} ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ?`)
    .bind(...f.args, limit)
    .all();
  return results.map(fromRow);
}

// Published items that credit this member and that the viewer may see.
export async function listCredited(env, acc, userId, limit = 50) {
  const d = await db(env);
  const f = entryFilter(acc);
  const { results } = await d
    .prepare(
      `SELECT * FROM entries WHERE kind != 'idea'
       AND EXISTS (SELECT 1 FROM json_each(entries.meta, '$.credits') c WHERE json_extract(c.value, '$.userId') = ?)
       AND ${f.sql} ORDER BY published_at DESC LIMIT ?`,
    )
    .bind(userId, ...f.args, limit)
    .all();
  return results.map(fromRow);
}

export async function findVisible(env, acc, kind, slug) {
  const d = await db(env);
  const entry = fromRow(await d.prepare(`SELECT * FROM entries WHERE kind = ? AND slug = ?`).bind(kind, slug).first());
  return entry && canSee(acc, entry) ? entry : null;
}

export function card(entry) {
  const { id, kind, spaceId, slug, title, visibility, tags, publishedAt, updatedAt } = entry;
  return { id, kind, spaceId, slug, title, visibility, tags, publishedAt, updatedAt, summary: entry.summary || excerpt(entry.body) };
}

export async function publicList(env, acc, isPublic, url) {
  const kind = url.searchParams.get('kind') || 'article';
  if (!KINDS.includes(kind) || kind === 'idea') throw new HttpError(400, 'Unknown kind.');
  const entries = await listVisible(env, acc, kind);
  return json({ entries: entries.map(card) }, 200, { 'Cache-Control': isPublic ? 'public, max-age=60' : 'private, no-store' });
}
