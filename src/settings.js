// Studio settings: the social links shown on every page, and moving what the
// old admin page (/admin, items in KV) holds into the wings.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { socials } from './site.js';
import { saveEntry, slugify } from './entries.js';
import { fileKind } from './limits.js';

const MAX_LINKS = 20;

export async function getSettings(env) {
  return json({ socials: await socials(env) });
}

export async function saveSocials(request, env) {
  const body = await readJson(request);
  if (!Array.isArray(body.socials)) throw new HttpError(400, 'Send the links as a list.');
  const list = [];
  for (const s of body.socials.slice(0, MAX_LINKS)) {
    const label = cleanText(s?.label, 40);
    const raw = cleanText(s?.href, 300);
    if (!label && !raw) continue;
    let href;
    try {
      href = new URL(raw).href;
    } catch {
      throw new HttpError(400, `"${label || raw}" is not a valid web address.`);
    }
    if (!href.startsWith('https://')) throw new HttpError(400, `"${label || raw}" must start with https://`);
    if (!label) throw new HttpError(400, `Give ${href} a name.`);
    list.push({ label, href });
  }
  const d = await db(env);
  await d.prepare(`INSERT INTO settings (key, value) VALUES ('socials', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(list)).run();
  return json({ socials: list });
}

// ---------- the old admin page ----------

// Where each old section goes.
const LEGACY = {
  music: { spaceId: 'music', kind: 'song' },
  voice: { spaceId: 'humor', kind: 'dub' },
  sketches: { spaceId: 'sketches', kind: 'sketch' },
  writing: { spaceId: 'articles', kind: 'article' },
};
const VERSION_LABEL = { audio: 'הקלטה', video: 'סרטון' };

async function freeSlug(d, kind, title, fallback) {
  const base = slugify(title) || fallback;
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await d.prepare('SELECT 1 FROM entries WHERE kind = ? AND slug = ?').bind(kind, slug).first())) return slug;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

// Copy a KV value from the old layout ("file:<id>", "cover:<id>") into an
// entry's files, so it follows the entry's visibility from now on.
async function copyFile(env, d, key, entryId, name) {
  const { value, metadata } = await env.MEDIA.getWithMetadata(key, 'arrayBuffer');
  const type = metadata?.type ?? '';
  if (!value || !fileKind(type)) return null;
  const id = crypto.randomUUID();
  await env.MEDIA.put(`blob:${id}`, value, { metadata: { type } });
  await d
    .prepare('INSERT INTO files (id, entry_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, entryId, String(name || 'file').slice(0, 200), type, value.byteLength, new Date().toISOString())
    .run();
  return { url: `/files/${id}`, kind: fileKind(type) };
}

// Every item from the old admin page becomes an item in its wing, once.
// Items that were shown on the site stay public; hidden ones become private drafts.
// The old copies are left in place.
export async function importLegacy(env) {
  const d = await db(env);
  const items = (await env.MEDIA.get('items', 'json')) ?? [];
  const created = [];
  let skipped = 0;
  for (const item of items) {
    const to = LEGACY[item.section];
    if (!to || (await d.prepare(`SELECT id FROM entries WHERE json_extract(meta, '$.legacy.id') = ?`).bind(item.id).first())) {
      skipped++;
      continue;
    }
    const id = crypto.randomUUID();
    const title = cleanText(item.title, 200) || 'בלי כותרת';
    const versions = [];
    const body = [];
    let cover;
    // The entry row goes in first so files can point at it.
    const when = item.createdAt || new Date().toISOString();
    const entry = {
      id,
      kind: to.kind,
      spaceId: to.spaceId,
      slug: await freeSlug(d, to.kind, title, id.slice(0, 8)),
      title,
      summary: cleanText(item.note, 600),
      body: '',
      visibility: item.hidden ? 'private' : 'public',
      status: item.hidden ? 'draft' : 'published',
      tags: [],
      meta: { legacy: { id: item.id } },
      pinned: false,
      source: 'legacy',
      createdAt: when,
      updatedAt: when,
      publishedAt: item.hidden ? null : when,
    };
    await saveEntry(env, entry, true);
    if (item.hasFile) {
      const f = await copyFile(env, d, `file:${item.id}`, id, item.fileName || title);
      if (f?.kind === 'audio' || f?.kind === 'video') versions.push({ label: VERSION_LABEL[f.kind], url: f.url, kind: f.kind });
      else if (f?.kind === 'image') body.push(`![${title}](${f.url})`);
      else if (f) body.push(`[הקובץ המלא (PDF)](${f.url})`);
    }
    if (item.hasCover) cover = (await copyFile(env, d, `cover:${item.id}`, id, 'cover'))?.url;
    if (item.link) {
      if (item.section === 'writing') body.push(`[לקריאה](${item.link})`);
      else versions.push({ label: versions.length ? 'קישור' : VERSION_LABEL[item.kind] ?? 'קישור', url: item.link });
    }
    entry.body = body.join('\n\n');
    entry.meta = { ...entry.meta, ...(versions.length ? { versions } : {}), ...(cover ? { cover } : {}) };
    await saveEntry(env, entry);
    created.push({ id, title, kind: to.kind, spaceId: to.spaceId, status: entry.status });
  }
  return json({ created, skipped, total: items.length });
}
