// Entries: every piece of content on the platform (ideas, articles, projects,
// works). The owner manages them from the studio; visitors only ever get what
// their role may see. The same shape is what the future connector API serves.
import { db, KINDS, VISIBILITY, STATUS } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { renderMarkdown, excerpt } from './markdown.js';

const MAX_BODY = 200_000;

// Which visibilities a viewer may read. Members come with the community slice.
export function visibleTo(role) {
  if (role === 'owner') return VISIBILITY;
  if (role === 'member') return ['members', 'public'];
  return ['public'];
}

function fromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
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
    const text = JSON.stringify(body.meta);
    if (text.length > 4000) throw new HttpError(400, 'meta is too large.');
    entry.meta = body.meta;
  }
  if ('slug' in body) entry.slug = slugify(body.slug) || null;

  if (entry.status === 'published') {
    if (!entry.title) throw new HttpError(400, 'Give it a title before publishing.');
    if (!entry.slug) {
      entry.slug = slugify(entry.title) || entry.id.slice(0, 8);
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
  const row = [
    entry.kind, entry.slug, entry.title, entry.summary, entry.body, entry.visibility, entry.status,
    JSON.stringify(entry.tags), JSON.stringify(entry.meta), entry.pinned ? 1 : 0, entry.updatedAt, entry.publishedAt,
  ];
  try {
    if (insert) {
      await d
        .prepare(
          `INSERT INTO entries (kind, slug, title, summary, body, visibility, status, tags, meta, pinned, updated_at, published_at, id, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...row, entry.id, entry.source, entry.createdAt)
        .run();
    } else {
      await d
        .prepare(
          `UPDATE entries SET kind = ?, slug = ?, title = ?, summary = ?, body = ?, visibility = ?, status = ?, tags = ?, meta = ?,
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

export async function getEntry(env, id) {
  const d = await db(env);
  return fromRow(await d.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first());
}

// ---------- owner (studio) ----------

export async function studioList(env, url) {
  const d = await db(env);
  const kind = url.searchParams.get('kind');
  const q = cleanText(url.searchParams.get('q'), 100);
  const where = [];
  const args = [];
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
  const body = await readJson(request);
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    kind: 'idea',
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
  if (!entry.title && !entry.body.trim()) throw new HttpError(400, 'Write something first.');
  await write(env, entry, true);
  return json(entry, 201);
}

export async function studioUpdate(request, env, id) {
  const entry = await getEntry(env, id);
  if (!entry) throw new HttpError(404, 'That item no longer exists.');
  const body = await readJson(request);
  // Optimistic check: refuse to overwrite a newer save from another tab.
  if (body.baseUpdatedAt && body.baseUpdatedAt !== entry.updatedAt) {
    throw new HttpError(409, 'This item changed in another window. Reload it before saving.');
  }
  applyFields(entry, body);
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
  const { body } = await readJson(request);
  return json({ html: renderMarkdown(String(body ?? '').slice(0, MAX_BODY)) });
}

// ---------- visitors ----------

export async function listVisible(env, role, kind, limit = 100) {
  const d = await db(env);
  const vis = visibleTo(role);
  const { results } = await d
    .prepare(
      `SELECT * FROM entries WHERE kind = ? AND status = 'published' AND visibility IN (${vis.map(() => '?').join(', ')})
       ORDER BY pinned DESC, published_at DESC LIMIT ?`,
    )
    .bind(kind, ...vis, limit)
    .all();
  return results.map(fromRow);
}

export async function findVisible(env, role, kind, slug) {
  const d = await db(env);
  const row = await d.prepare(`SELECT * FROM entries WHERE kind = ? AND slug = ?`).bind(kind, slug).first();
  const entry = fromRow(row);
  if (!entry) return null;
  if (role === 'owner') return entry;
  if (entry.status !== 'published' || !visibleTo(role).includes(entry.visibility)) return null;
  return entry;
}

export function card(entry) {
  const { id, kind, slug, title, visibility, tags, publishedAt, updatedAt } = entry;
  return { id, kind, slug, title, visibility, tags, publishedAt, updatedAt, summary: entry.summary || excerpt(entry.body) };
}

export async function publicList(env, role, url) {
  const kind = url.searchParams.get('kind') || 'article';
  if (!KINDS.includes(kind) || kind === 'idea') throw new HttpError(400, 'Unknown kind.');
  const entries = await listVisible(env, role, kind);
  return json({ entries: entries.map(card) }, 200, { 'Cache-Control': role === 'public' ? 'public, max-age=60' : 'private, no-store' });
}
