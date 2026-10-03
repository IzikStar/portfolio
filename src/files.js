// Files attached to entries: images in articles, a project's picture, audio,
// video or PDFs. Bytes live in KV ("blob:<id>", 25 MB per value); the files
// table says which entry owns each one, and a file is visible to exactly the
// people who may see its entry.
import { db } from './db.js';
import { HttpError, json } from './http.js';
import { getEntry } from './entries.js';
import { canSee, isPublicEntry } from './spaces.js';
import { MAX_FILE_BYTES, fileKind, downloadKind, DOWNLOAD_TYPE } from './limits.js';
import { serveBytes } from './bytes.js';
import { projectList, mayDownload } from './project-files.js';

// What the studio calls a file: a media kind, or 'download' for project files.
const kindOf = (type) => (type === DOWNLOAD_TYPE ? 'download' : fileKind(type));

export async function uploadFile(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  const entryId = String(form.get('entryId') ?? '');
  if (!(file instanceof File) || file.size === 0) throw new HttpError(400, 'Choose a file.');
  // Cubase projects and archives are kept by name as opaque bytes, whatever
  // type the browser guessed; everything else must be a type we show safely.
  const download = !fileKind(file.type) && downloadKind(file.name);
  const type = download ? DOWNLOAD_TYPE : file.type;
  if (!fileKind(type) && !download) throw new HttpError(400, 'Unsupported file type. Use an image (PNG, JPG, WebP, GIF), audio, video, PDF, or a Cubase project (.cpr, .bak, .zip).');
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, 'The file is over 25 MB. Upload it to YouTube or Drive and link to it instead.');
  if (!(await getEntry(env, entryId))) throw new HttpError(400, 'Save the item before adding files to it.');

  const id = crypto.randomUUID();
  const name = String(file.name || 'file').slice(0, 200);
  await env.MEDIA.put(`blob:${id}`, await file.arrayBuffer(), { metadata: { type } });
  const d = await db(env);
  await d
    .prepare('INSERT INTO files (id, entry_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, entryId, name, type, file.size, new Date().toISOString())
    .run();
  return json({ id, url: `/files/${id}`, name, type, kind: kindOf(type), ...(download ? { project: download } : {}), size: file.size }, 201);
}

export async function listFiles(env, entryId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM files WHERE entry_id = ? ORDER BY created_at').bind(entryId).all();
  return json({ files: results.map((f) => ({ id: f.id, url: `/files/${f.id}`, name: f.name, type: f.type, kind: kindOf(f.type), size: f.size })) });
}

export async function deleteFile(env, id) {
  const d = await db(env);
  const { meta } = await d.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  if (!meta.changes) throw new HttpError(404, 'That file no longer exists.');
  await env.MEDIA.delete(`blob:${id}`);
  return json({ ok: true });
}

// When an entry goes, its files go with it.
export async function deleteFilesOf(env, entryId) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT id FROM files WHERE entry_id = ?').bind(entryId).all();
  await Promise.all(results.map((f) => env.MEDIA.delete(`blob:${f.id}`)));
  await d.prepare('DELETE FROM files WHERE entry_id = ?').bind(entryId).run();
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
  const { value } = await env.MEDIA.getWithMetadata(`blob:${id}`, 'arrayBuffer');
  if (!value) return null;
  const isPublic = isPublicEntry(acc, entry);
  // Public files can sit in any cache; the rest stay private to the viewer.
  const cache = isPublic ? 'public, max-age=86400' : 'private, max-age=300';
  const res = serveBytes(request, value, download ? DOWNLOAD_TYPE : row.type, download ? 'private, max-age=300' : cache);
  res.headers.set('Vary', 'Cookie');
  if (download) res.headers.set('Content-Disposition', `attachment; filename="${asciiName(row.name)}"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  return res;
}

// The plain-ASCII fallback for Content-Disposition (Hebrew names go in filename*).
function asciiName(name) {
  return String(name).replace(/[^\x20-\x7e]|["\\]/g, '_') || 'file';
}
