// Files attached to entries: images in articles, a project's picture, audio,
// video or PDFs. Bytes live in KV (src/blobs.js, in pieces past 20 MB); the
// files table says which entry owns each one, and a file is visible to
// exactly the people who may see its entry.
import { db } from './db.js';
import { HttpError, json } from './http.js';
import { getEntry } from './entries.js';
import { canSee, isPublicEntry } from './spaces.js';
import { MAX_FILE_BYTES, fileKind, downloadKind, DOWNLOAD_TYPE } from './limits.js';
import { putBlob, deleteBlob, serveBlob } from './blobs.js';
import { projectList, mayDownload } from './project-files.js';

// What the studio calls a file: a media kind, or 'download' for project files.
const kindOf = (type) => (type === DOWNLOAD_TYPE ? 'download' : fileKind(type));

export async function uploadFile(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  const entryId = String(form.get('entryId') ?? '');
  if (!(file instanceof File)) throw new HttpError(400, 'Choose a file.');
  checkFile(file);
  if (!(await getEntry(env, entryId))) throw new HttpError(400, 'Save the item before adding files to it.');
  return json(await attachFile(env, entryId, file), 201);
}

// The studio's upload: the file itself is the request body (no form), so a
// big video streams into KV a piece at a time instead of sitting in memory.
// PUT /api/studio/files?entryId=...&name=..., Content-Type: the file's type.
export async function putFile(request, env, url) {
  const entryId = url.searchParams.get('entryId') ?? '';
  const name = String(url.searchParams.get('name') || 'file').slice(0, 200);
  const size = Number(request.headers.get('Content-Length') ?? NaN);
  const { type, download } = checkFile({ name, type: request.headers.get('Content-Type') ?? '', size: Number.isFinite(size) ? size : 1 });
  if (!(await getEntry(env, entryId))) throw new HttpError(400, 'Save the item before adding files to it.');
  if (!request.body) throw new HttpError(400, 'Choose a file.');
  const id = crypto.randomUUID();
  let stored;
  try {
    stored = await putBlob(env, id, request.body, type, MAX_FILE_BYTES);
  } catch (err) {
    if (err instanceof RangeError) throw new HttpError(413, TOO_BIG);
    throw err;
  }
  if (!stored) throw new HttpError(400, 'Choose a file.');
  return json(await addRow(env, { id, entryId, name, type, size: stored, download }), 201);
}

const TOO_BIG = `The file is over ${MAX_FILE_BYTES / 1024 / 1024} MB. Upload it to Drive or YouTube and paste the link instead.`;

// Throws unless `file` ({ name, type, size }) is something we can store and
// serve; says how we store it.
export function checkFile(file) {
  if (!file || !(file.size > 0)) throw new HttpError(400, 'Choose a file.');
  // A recorder's type can carry a codec ("audio/webm;codecs=opus"); keep the plain type.
  const plain = String(file.type ?? '').split(';')[0].trim().toLowerCase();
  // Cubase projects and archives are kept by name as opaque bytes, whatever
  // type the browser guessed; everything else must be a type we show safely.
  const download = !fileKind(plain) && downloadKind(file.name);
  const type = download ? DOWNLOAD_TYPE : plain;
  if (!fileKind(type) && !download) throw new HttpError(400, 'Unsupported file type. Use an image (PNG, JPG, WebP, GIF), audio, video, PDF, or a Cubase project (.cpr, .bak, .zip).');
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, TOO_BIG);
  return { type, download };
}

// Store the bytes and the row for an entry that exists.
export async function attachFile(env, entryId, file) {
  const { type, download } = checkFile(file);
  const id = crypto.randomUUID();
  const name = String(file.name || 'file').slice(0, 200);
  await putBlob(env, id, await file.arrayBuffer(), type);
  return addRow(env, { id, entryId, name, type, size: file.size, download });
}

async function addRow(env, { id, entryId, name, type, size, download }) {
  const d = await db(env);
  await d
    .prepare('INSERT INTO files (id, entry_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, entryId, name, type, size, new Date().toISOString())
    .run();
  return { ...fileInfo({ id, name, type, size }), ...(download ? { project: download } : {}) };
}

export const fileInfo = (f) => ({ id: f.id, url: `/files/${f.id}`, name: f.name, type: f.type, kind: kindOf(f.type), size: f.size });

export async function listFiles(env, entryId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM files WHERE entry_id = ? ORDER BY created_at').bind(entryId).all();
  return json({ files: results.map(fileInfo) });
}

export async function deleteFile(env, id) {
  const d = await db(env);
  const { meta } = await d.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  if (!meta.changes) throw new HttpError(404, 'That file no longer exists.');
  await deleteBlob(env, id);
  return json({ ok: true });
}

export async function serveFile(request, env, acc, id) {
  const d = await db(env);
  const row = await d.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  if (!row) return null;
  const entry = await getEntry(env, row.entry_id);
  if (!entry) return null;
  if (!canSee(acc, entry)) return null;
  const download = row.type === DOWNLOAD_TYPE;
  // A project file is only for whoever its entry in meta.projects lets in;
  // one that no list mentions stays with the owner.
  if (download && !acc.owner) {
    const p = projectList(entry).find((x) => x.url === `/files/${id}`);
    if (!p || !mayDownload(acc, entry, p)) return null;
  }
  const isPublic = isPublicEntry(acc, entry);
  // Public files can sit in any cache; the rest stay private to the viewer.
  const cache = isPublic ? 'public, max-age=86400' : 'private, max-age=300';
  const res = await serveBlob(request, env, id, download ? DOWNLOAD_TYPE : row.type, download ? 'private, max-age=300' : cache);
  if (!res) return null;
  res.headers.set('Vary', 'Cookie');
  if (download) res.headers.set('Content-Disposition', `attachment; filename="${asciiName(row.name)}"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  return res;
}

// The plain-ASCII fallback for Content-Disposition (Hebrew names go in filename*).
function asciiName(name) {
  return String(name).replace(/[^\x20-\x7e]|["\\]/g, '_') || 'file';
}
