// Portfolio site worker: serves the static site (ASSETS) and a small API for
// the creative sections (music, voice acting, sketches, writing).
// KV layout:
//   "items"         JSON list of every uploaded item, in display order
//   "settings"      JSON { sections: { [name]: boolean }, intros: { [name]: string } }
//   "file:<id>"     the item's file (audio, video, image or PDF)
//   "cover:<id>"    optional cover image
//
// Required bindings/secrets (see wrangler.toml and README):
//   MEDIA          KV namespace
//   ADMIN_PASSWORD secret, the only way into the admin page

import { MAX_FILE_BYTES, MAX_COVER_BYTES, SECTIONS, MEDIA_SECTIONS, fileKind, isCoverType } from './limits.js';

const SESSION_HOURS = 12;
const COOKIE = 'admin_session';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/site' && method === 'GET') {
    const [settings, items] = await Promise.all([getSettings(env), listItems(env)]);
    const visible = items.filter((i) => !i.hidden && settings.sections[i.section]).map(publicItem);
    return json({ sections: settings.sections, intros: settings.intros, items: visible }, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  }

  let m = path.match(/^\/api\/(file|cover)\/([a-z0-9-]+)$/);
  if (m && (method === 'GET' || method === 'HEAD')) return media(request, env, m[1], m[2]);

  if (!path.startsWith('/api/admin/')) throw new HttpError(404, 'Not found.');

  // Everything below changes state or reveals hidden items.
  if (method !== 'GET') checkOrigin(request, url);

  if (path === '/api/admin/login' && method === 'POST') return login(request, env);
  if (path === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  await requireSession(request, env);

  if (path === '/api/admin/session' && method === 'GET') return json({ ok: true });
  if (path === '/api/admin/site' && method === 'GET') {
    const [settings, items] = await Promise.all([getSettings(env), listItems(env)]);
    return json({ ...settings, items });
  }
  if (path === '/api/admin/settings' && method === 'PUT') return saveSettings(request, env);
  if (path === '/api/admin/items' && method === 'POST') return upload(request, env);
  if (path === '/api/admin/order' && method === 'PUT') return reorder(request, env);

  m = path.match(/^\/api\/admin\/items\/([a-z0-9-]+)$/);
  if (m && method === 'PATCH') return editItem(request, env, m[1]);
  if (m && method === 'DELETE') return deleteItem(env, m[1]);

  throw new HttpError(404, 'Not found.');
}

// ---------- settings ----------

function defaultSettings() {
  return {
    sections: Object.fromEntries(SECTIONS.map((s) => [s, true])),
    intros: Object.fromEntries(MEDIA_SECTIONS.map((s) => [s, ''])),
  };
}

async function getSettings(env) {
  const stored = (await env.MEDIA.get('settings', 'json')) ?? {};
  const base = defaultSettings();
  return {
    sections: { ...base.sections, ...pickKnown(stored.sections, SECTIONS, (v) => v === true || v === false) },
    intros: { ...base.intros, ...pickKnown(stored.intros, MEDIA_SECTIONS, (v) => typeof v === 'string') },
  };
}

function pickKnown(obj, keys, valid) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([k, v]) => keys.includes(k) && valid(v)));
}

async function saveSettings(request, env) {
  const body = await readJson(request);
  const current = await getSettings(env);
  const next = {
    sections: { ...current.sections, ...pickKnown(body.sections, SECTIONS, (v) => v === true || v === false) },
    intros: { ...current.intros },
  };
  for (const [k, v] of Object.entries(pickKnown(body.intros, MEDIA_SECTIONS, (v) => typeof v === 'string'))) {
    next.intros[k] = cleanText(v, 600);
  }
  await env.MEDIA.put('settings', JSON.stringify(next));
  return json(next);
}

// ---------- items ----------

async function listItems(env) {
  return (await env.MEDIA.get('items', 'json')) ?? [];
}

async function saveItems(env, items) {
  await env.MEDIA.put('items', JSON.stringify(items));
}

function publicItem(i) {
  const { id, section, title, note, link, kind, duration, hasFile, hasCover, createdAt } = i;
  return { id, section, title, note, link, kind, duration, hasFile, hasCover, createdAt };
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanLink(value) {
  const raw = cleanText(value, 500);
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'The link is not a valid web address.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'The link must start with https://');
  return u.href;
}

async function upload(request, env) {
  const form = await request.formData();
  const section = String(form.get('section') ?? '');
  if (!MEDIA_SECTIONS.includes(section)) throw new HttpError(400, 'Pick a section for this item.');
  const title = cleanText(form.get('title'), 120);
  if (!title) throw new HttpError(400, 'Give the item a title.');
  const link = cleanLink(form.get('link'));

  const file = form.get('file');
  const cover = form.get('cover');
  const hasFile = file instanceof File && file.size > 0;
  const hasCover = cover instanceof File && cover.size > 0;
  if (!hasFile && !link) throw new HttpError(400, 'Add a file or a link.');

  let kind = 'link';
  if (hasFile) {
    kind = fileKind(file.type);
    if (!kind) throw new HttpError(400, 'Unsupported file type. Use audio, video, PDF or an image (PNG, JPG, WebP).');
    if (file.size > MAX_FILE_BYTES) throw new HttpError(413, 'The file is over 25 MB. Compress it, or upload it to YouTube or Drive and add a link instead.');
  }
  if (hasCover) {
    if (!isCoverType(cover.type)) throw new HttpError(400, 'The cover must be a PNG, JPG or WebP image.');
    if (cover.size > MAX_COVER_BYTES) throw new HttpError(413, 'The cover image is over 2 MB.');
  }

  const id = crypto.randomUUID();
  if (hasFile) await env.MEDIA.put(`file:${id}`, await file.arrayBuffer(), { metadata: { type: file.type } });
  if (hasCover) await env.MEDIA.put(`cover:${id}`, await cover.arrayBuffer(), { metadata: { type: cover.type } });

  const duration = Number(form.get('duration'));
  const item = {
    id,
    section,
    title,
    note: cleanText(form.get('note'), 600),
    link,
    kind,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    hasFile,
    fileType: hasFile ? file.type : null,
    fileName: hasFile ? cleanText(file.name, 200) : null,
    size: hasFile ? file.size : 0,
    hasCover,
    hidden: form.get('hidden') === 'true',
    createdAt: new Date().toISOString(),
  };
  const items = await listItems(env);
  items.unshift(item);
  await saveItems(env, items);
  return json(item, 201);
}

async function editItem(request, env, id) {
  const body = await readJson(request);
  const items = await listItems(env);
  const item = items.find((i) => i.id === id);
  if (!item) throw new HttpError(404, 'That item no longer exists.');
  if ('title' in body) {
    const title = cleanText(body.title, 120);
    if (!title) throw new HttpError(400, 'Give the item a title.');
    item.title = title;
  }
  if ('note' in body) item.note = cleanText(body.note, 600);
  if ('link' in body) {
    const link = cleanLink(body.link);
    if (!link && !item.hasFile) throw new HttpError(400, 'This item has no file, so it needs a link.');
    item.link = link;
  }
  if ('hidden' in body) item.hidden = Boolean(body.hidden);
  if ('section' in body) {
    if (!MEDIA_SECTIONS.includes(body.section)) throw new HttpError(400, 'Unknown section.');
    item.section = body.section;
  }
  await saveItems(env, items);
  return json(item);
}

async function deleteItem(env, id) {
  const items = await listItems(env);
  const remaining = items.filter((i) => i.id !== id);
  if (remaining.length === items.length) throw new HttpError(404, 'That item no longer exists.');
  await saveItems(env, remaining);
  await Promise.all([env.MEDIA.delete(`file:${id}`), env.MEDIA.delete(`cover:${id}`)]);
  return json({ ok: true });
}

// The client sends the full order of one section; other sections keep their places.
async function reorder(request, env) {
  const { ids } = await readJson(request);
  if (!Array.isArray(ids)) throw new HttpError(400, 'Send the new order as a list of ids.');
  const items = await listItems(env);
  const byId = new Map(items.map((i) => [i.id, i]));
  const queue = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const moving = new Set(queue.map((i) => i.id));
  const ordered = items.map((i) => (moving.has(i.id) ? queue.shift() : i));
  await saveItems(env, ordered);
  return json(ordered);
}

// ---------- media ----------

async function media(request, env, kind, id) {
  const { value, metadata } = await env.MEDIA.getWithMetadata(`${kind}:${id}`, 'arrayBuffer');
  if (!value) throw new HttpError(404, 'Not found.');
  const headers = new Headers({
    'Content-Type': metadata?.type ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
  });
  // Uploads are admin-only, but keep them inert anyway. Chrome refuses to show
  // PDFs under a sandbox CSP, so PDFs get only nosniff.
  if (metadata?.type !== 'application/pdf') {
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  const total = value.byteLength;
  const range = request.headers.get('Range');
  const r = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (r && (r[1] || r[2])) {
    let start = r[1] ? Number(r[1]) : total - Number(r[2]);
    let end = r[1] && r[2] ? Number(r[2]) : total - 1;
    start = Math.max(0, start);
    end = Math.min(end, total - 1);
    if (start > end) {
      headers.set('Content-Range', `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
    headers.set('Content-Length', String(end - start + 1));
    const body = request.method === 'HEAD' ? null : value.slice(start, end + 1);
    return new Response(body, { status: 206, headers });
  }
  headers.set('Content-Length', String(total));
  return new Response(request.method === 'HEAD' ? null : value, { status: 200, headers });
}

// ---------- auth ----------

function checkOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked.');
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin password is not set on the server yet.');
  const { password } = await readJson(request);
  const ok = await safeEqual(String(password ?? ''), env.ADMIN_PASSWORD);
  if (!ok) {
    // Slow down guessing without spending KV writes on a counter.
    await new Promise((r) => setTimeout(r, 1000));
    throw new HttpError(401, 'Wrong password.');
  }
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = `${expires}.${await sign(String(expires), env.ADMIN_PASSWORD)}`;
  const cookie = `${COOKIE}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function requireSession(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin password is not set on the server yet.');
  const cookies = request.headers.get('Cookie') ?? '';
  const token = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const [expires, sig] = (token ?? '').split('.');
  if (!expires || !sig || Number(expires) < Date.now()) throw new HttpError(401, 'Please log in again.');
  const expected = await sign(expires, env.ADMIN_PASSWORD);
  if (!(await safeEqual(sig, expected))) throw new HttpError(401, 'Please log in again.');
}

function clearCookie() {
  return `${COOKIE}=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

const enc = new TextEncoder();

async function sign(message, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`session:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compare digests so timing does not leak the length or prefix of the secret.
async function safeEqual(a, b) {
  const [da, db] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- helpers ----------

async function readJson(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    throw new HttpError(400, 'Expected a JSON body.');
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
