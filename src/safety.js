// Keeping the owner's work safe: earlier versions of every item, a trash that
// holds deleted items for 30 days, and a download of everything as a ZIP.
//
//   revisions  Saving an item puts the text it had before aside, at most once
//              every 10 minutes of editing (the studio saves every second or
//              so), and always before a big cut, a restore or an overwrite of
//              another window's save. The last 100 per item are kept.
//   trash      Deleting an item moves it here with its comments and files
//              (the bytes stay in KV). The daily cron empties what is older
//              than 30 days.
//   export     One ZIP: every item as a Markdown file in a folder per wing and
//              space, data.json with all the tables, and the uploaded files.
import { db, WINGS } from './db.js';
import { HttpError, json } from './http.js';
import { fromRow } from './entries.js';
import { dropMentions } from './mentions.js';
import { getBlob, deleteBlob } from './blobs.js';

export const REVISION_GAP_MS = 10 * 60_000;
export const MAX_REVISIONS = 100;
export const TRASH_DAYS = 30;
// What the ZIP carries of the uploaded files, at most (the rest are listed).
// A worker has 128 MB of memory, and the ZIP holds each file twice while it is built.
const EXPORT_FILE_BYTES = 40 * 1024 * 1024;

// ---------- revisions ----------

// A save that drops this much of the text is kept apart whatever the clock says.
const bigCut = (before, after) => before.length - after.length >= 200 && after.length < before.length * 0.7;

// Called just before an entry is written over: keeps what it held until now
// when that is worth keeping. `force` keeps it whenever the content changes.
export async function keepRevision(d, entry, { reason = 'edit', force = false } = {}) {
  const cur = await d.prepare('SELECT title, summary, body, meta, updated_at FROM entries WHERE id = ?').bind(entry.id).first();
  if (!cur) return false;
  const meta = JSON.stringify(entry.meta ?? {});
  if (cur.title === entry.title && cur.summary === entry.summary && cur.body === entry.body && cur.meta === meta) return false;
  const now = new Date();
  if (!force && !bigCut(cur.body, entry.body ?? '')) {
    const last = await d.prepare('SELECT kept_at FROM revisions WHERE entry_id = ? ORDER BY kept_at DESC LIMIT 1').bind(entry.id).first();
    if (last && now - new Date(last.kept_at) < REVISION_GAP_MS) return false;
  }
  await d.batch([
    d
      .prepare('INSERT INTO revisions (id, entry_id, title, summary, body, meta, saved_at, kept_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), entry.id, cur.title, cur.summary, cur.body, cur.meta, cur.updated_at, now.toISOString(), reason),
    d
      .prepare(
        `DELETE FROM revisions WHERE entry_id = ? AND id NOT IN (SELECT id FROM revisions WHERE entry_id = ? ORDER BY kept_at DESC LIMIT ${MAX_REVISIONS})`,
      )
      .bind(entry.id, entry.id),
  ]);
  return true;
}

const revisionInfo = (r) => ({
  id: r.id,
  title: r.title,
  savedAt: r.saved_at,
  keptAt: r.kept_at,
  reason: r.reason,
  chars: r.chars ?? r.body?.length ?? 0,
});

export async function listRevisions(env, entryId) {
  const d = await db(env);
  const { results } = await d
    .prepare('SELECT id, title, saved_at, kept_at, reason, LENGTH(body) AS chars FROM revisions WHERE entry_id = ? ORDER BY kept_at DESC')
    .bind(entryId)
    .all();
  return json({ revisions: results.map(revisionInfo) });
}

async function revisionRow(d, entryId, id) {
  const r = await d.prepare('SELECT * FROM revisions WHERE id = ? AND entry_id = ?').bind(id, entryId).first();
  if (!r) throw new HttpError(404, 'That version no longer exists.');
  return r;
}

export async function getRevision(env, entryId, id) {
  const d = await db(env);
  const r = await revisionRow(d, entryId, id);
  return json({ ...revisionInfo(r), summary: r.summary, body: r.body, meta: JSON.parse(r.meta || '{}') });
}

// The item takes the version's text back (title, summary, body and meta).
// What it held a moment ago becomes a version itself, so a restore can be undone.
// Where it lives, who sees it and whether it is published stay as they are.
export async function restoreRevision(env, entryId, id, save) {
  const d = await db(env);
  const r = await revisionRow(d, entryId, id);
  const entry = fromRow(await d.prepare('SELECT * FROM entries WHERE id = ?').bind(entryId).first());
  if (!entry) throw new HttpError(404, 'That item no longer exists.');
  const meta = JSON.parse(r.meta || '{}');
  // Written by the server only: they follow the item, not the version.
  for (const k of ['synced', 'oldPaths']) {
    if (entry.meta[k]) meta[k] = entry.meta[k];
    else delete meta[k];
  }
  Object.assign(entry, { title: r.title, summary: r.summary, body: r.body, meta, updatedAt: new Date().toISOString() });
  await save(env, entry, false, { reason: 'restore', force: true });
  return json(entry);
}

// ---------- trash ----------

// Moves an entry, its comments and its files' rows to the trash.
export async function trashEntry(env, id) {
  const d = await db(env);
  const row = await d.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'That item no longer exists.');
  const { results: comments } = await d.prepare('SELECT * FROM comments WHERE entry_id = ?').bind(id).all();
  const { results: files } = await d.prepare('SELECT * FROM files WHERE entry_id = ?').bind(id).all();
  await d.batch([
    d
      .prepare('INSERT OR REPLACE INTO trash (id, kind, title, space_id, data, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, row.kind, row.title, row.space_id ?? null, JSON.stringify({ entry: row, comments, files }), new Date().toISOString()),
    d.prepare('DELETE FROM entries WHERE id = ?').bind(id),
    d.prepare('DELETE FROM comments WHERE entry_id = ?').bind(id),
    d.prepare('DELETE FROM files WHERE entry_id = ?').bind(id),
  ]);
  await dropMentions(env, 'comment', comments.map((c) => c.id));
  return json({ ok: true, trashed: true });
}

export async function listTrash(env) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT id, kind, title, space_id, deleted_at, LENGTH(data) AS size FROM trash ORDER BY deleted_at DESC').all();
  return json({
    days: TRASH_DAYS,
    items: results.map((r) => ({ id: r.id, kind: r.kind, title: r.title, spaceId: r.space_id, deletedAt: r.deleted_at, size: r.size })),
  });
}

const COLS = (row) => Object.keys(row).filter((k) => /^[a-z_]+$/.test(k));
const insertRow = (d, table, row, verb = 'INSERT') => {
  const cols = COLS(row);
  return d.prepare(`${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => row[c] ?? null));
};

// Puts an item back where it was, with its comments and files. If its space
// is gone it goes to its wing; if its address was taken meanwhile it gets a new one.
export async function restoreTrash(env, id) {
  const d = await db(env);
  const t = await d.prepare('SELECT * FROM trash WHERE id = ?').bind(id).first();
  if (!t) throw new HttpError(404, 'That item is no longer in the trash.');
  const { entry, comments = [], files = [] } = JSON.parse(t.data);
  if (await d.prepare('SELECT id FROM entries WHERE id = ?').bind(id).first()) throw new HttpError(409, 'An item with this id already exists.');
  if (entry.space_id && !(await d.prepare('SELECT id FROM spaces WHERE id = ?').bind(entry.space_id).first())) {
    entry.space_id = WINGS.find((w) => w.kind === entry.kind)?.id ?? null;
  }
  if (entry.slug && (await d.prepare('SELECT id FROM entries WHERE kind = ? AND slug = ?').bind(entry.kind, entry.slug).first())) {
    entry.slug = `${entry.slug}-${id.slice(0, 4)}`.slice(0, 90);
  }
  await d.batch([
    insertRow(d, 'entries', entry),
    ...comments.map((c) => insertRow(d, 'comments', c, 'INSERT OR IGNORE')),
    ...files.map((f) => insertRow(d, 'files', f, 'INSERT OR IGNORE')),
    d.prepare('DELETE FROM trash WHERE id = ?').bind(id),
  ]);
  return json(fromRow(entry));
}

// Deletes for good: the row, the item's versions and its files' bytes.
async function purge(env, d, rows) {
  for (const t of rows) {
    const { files = [] } = JSON.parse(t.data);
    await Promise.all(files.map((f) => deleteBlob(env, f.id)));
    await d.batch([d.prepare('DELETE FROM trash WHERE id = ?').bind(t.id), d.prepare('DELETE FROM revisions WHERE entry_id = ?').bind(t.id)]);
  }
  return rows.length;
}

export async function purgeTrashItem(env, id) {
  const d = await db(env);
  const t = await d.prepare('SELECT * FROM trash WHERE id = ?').bind(id).first();
  if (!t) throw new HttpError(404, 'That item is no longer in the trash.');
  await purge(env, d, [t]);
  return json({ ok: true });
}

// Daily: what has been in the trash for more than 30 days goes for good.
export async function emptyOldTrash(env) {
  const d = await db(env);
  const before = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
  const { results } = await d.prepare('SELECT * FROM trash WHERE deleted_at < ?').bind(before).all();
  return purge(env, d, results);
}

// ---------- export ----------

// A name that every file system takes, Hebrew included.
export function safeName(text, fallback = 'item') {
  const name = String(text ?? '')
    .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return name || fallback;
}

// YAML front matter values as JSON strings: valid YAML, and nothing to escape by hand.
function frontMatter(e) {
  const lines = {
    title: e.title,
    id: e.id,
    kind: e.kind,
    status: e.status,
    visibility: e.visibility,
    slug: e.slug,
    tags: e.tags,
    summary: e.summary,
    created: e.createdAt,
    updated: e.updatedAt,
    published: e.publishedAt,
  };
  const out = Object.entries(lines)
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  for (const key of ['versions', 'projects']) {
    const list = Array.isArray(e.meta?.[key]) ? e.meta[key] : [];
    if (list.length) out.push(`${key}:`, ...list.map((v) => `  - ${JSON.stringify({ label: v.label, url: v.url })}`));
  }
  return `---\n${out.join('\n')}\n---\n\n`;
}

export async function exportAll(env) {
  const d = await db(env);
  const all = async (sql) => (await d.prepare(sql).all()).results;
  const entries = await all('SELECT * FROM entries ORDER BY created_at');
  const spaces = await all('SELECT * FROM spaces');
  const files = await all('SELECT * FROM files ORDER BY created_at');
  const data = {
    exportedAt: new Date().toISOString(),
    entries: entries.map(fromRow),
    spaces,
    communities: await all('SELECT * FROM communities'),
    communityMembers: await all('SELECT * FROM community_members'),
    // Never the password hashes.
    users: await all('SELECT id, username, display_name, status, created_at, last_login_at FROM users'),
    comments: await all('SELECT * FROM comments ORDER BY created_at'),
    posts: await all('SELECT * FROM posts ORDER BY created_at'),
    files,
    settings: await all('SELECT * FROM settings'),
    trash: (await all('SELECT * FROM trash')).map((t) => ({ ...t, data: JSON.parse(t.data) })),
  };

  const zip = new Zip();
  const byId = new Map(spaces.map((s) => [s.id, s]));
  // wing/space/sub-space, by title.
  const folderOf = (spaceId) => {
    const names = [];
    for (let s = byId.get(spaceId), hops = 0; s && hops < 20; s = byId.get(s.parent_id), hops++) names.unshift(safeName(s.title, s.slug));
    return names.length ? names.join('/') : 'בלי מקום';
  };
  const used = new Set();
  const unique = (path, ext) => {
    let p = `${path}${ext}`;
    for (let n = 2; used.has(p.toLowerCase()); n++) p = `${path} (${n})${ext}`;
    used.add(p.toLowerCase());
    return p;
  };
  for (const e of data.entries) {
    const folder = e.kind === 'idea' ? 'רעיונות' : folderOf(e.spaceId);
    const order = e.meta?.order != null ? `${String(e.meta.order).padStart(2, '0')} ` : '';
    zip.add(unique(`${folder}/${order}${safeName(e.title, e.slug || e.id.slice(0, 8))}`, '.md'), frontMatter(e) + (e.body ?? ''));
  }

  let bytes = 0;
  const skipped = [];
  for (const f of files) {
    if (bytes + f.size > EXPORT_FILE_BYTES) {
      skipped.push(f);
      continue;
    }
    const value = env.MEDIA ? await getBlob(env, f.id) : null;
    if (!value) {
      skipped.push(f);
      continue;
    }
    bytes += value.byteLength;
    zip.add(unique(`קבצים/${f.id.slice(0, 8)} ${safeName(f.name, 'file')}`, ''), new Uint8Array(value));
  }

  zip.add('data.json', JSON.stringify(data, null, 2));
  zip.add(
    'קרא אותי.txt',
    [
      `גיבוי של האתר מ־${data.exportedAt.slice(0, 10)}.`,
      '',
      `${data.entries.length} פריטים: כל פריט הוא קובץ Markdown בתיקייה של האגף והמקום שלו. רעיונות בתיקייה "רעיונות".`,
      'בראש כל קובץ: הכותרת, הסוג, מי רואה, תגיות וקישורים לגרסאות ולפרויקטים.',
      `קבצים שהועלו לאתר: בתיקייה "קבצים" (${files.length - skipped.length} מתוך ${files.length}).`,
      ...(skipped.length ? ['לא נכנסו (גדולים מדי לגיבוי אחד, או חסרים):', ...skipped.map((f) => `  ${f.name} (${f.id})`)] : []),
      'הקלטות וסרטונים שמקושרים מדרייב או מיוטיוב נשארים שם; כאן יש רק הקישור.',
      '',
      'data.json: כל הטבלאות (פריטים, מקומות, קהילות, חברים בלי סיסמאות, תגובות, פוסטים, הגדרות וסל המחזור).',
    ].join('\n'),
  );

  const day = data.exportedAt.slice(0, 10);
  return new Response(zip.finish(), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="izikstar-backup-${day}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ---------- a small ZIP writer (stored, no compression) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class Zip {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    const now = new Date();
    this.time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    this.date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  }

  add(name, content) {
    const enc = new TextEncoder();
    const nameBytes = enc.encode(name);
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    // Version 2.0, flag bit 11: the name is UTF-8.
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, this.time, true);
    local.setUint16(12, this.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, this.time, true);
    cen.setUint16(14, this.date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(cen.buffer), nameBytes);
    this.offset += 30 + nameBytes.length + data.length;
    this.count = (this.count ?? 0) + 1;
  }

  finish() {
    const size = this.central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count ?? 0, true);
    end.setUint16(10, this.count ?? 0, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    const all = [...this.parts, ...this.central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}
