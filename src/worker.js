// Portfolio site worker: serves the static site (ASSETS) and a small API
// for the music section. Tracks live in KV: one JSON list under "tracks",
// audio under "audio:<id>", cover images under "cover:<id>".
//
// Required bindings/secrets (see wrangler.toml and README):
//   MEDIA          KV namespace
//   ADMIN_PASSWORD secret, the only way into the admin page

import { MAX_AUDIO_BYTES, MAX_COVER_BYTES } from './limits.js';

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

  if (path === '/api/tracks' && method === 'GET') {
    const tracks = (await listTracks(env)).filter((t) => !t.hidden).map(publicTrack);
    return json(tracks, 200, { 'Cache-Control': 'public, max-age=60' });
  }

  let m = path.match(/^\/api\/(audio|cover)\/([a-z0-9-]+)$/);
  if (m && (method === 'GET' || method === 'HEAD')) return media(request, env, m[1], m[2]);

  if (!path.startsWith('/api/admin/')) throw new HttpError(404, 'Not found.');

  // Everything below changes state or reveals hidden tracks.
  if (method !== 'GET') checkOrigin(request, url);

  if (path === '/api/admin/login' && method === 'POST') return login(request, env);
  if (path === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  await requireSession(request, env);

  if (path === '/api/admin/session' && method === 'GET') return json({ ok: true });
  if (path === '/api/admin/tracks' && method === 'GET') return json(await listTracks(env));
  if (path === '/api/admin/tracks' && method === 'POST') return upload(request, env);
  if (path === '/api/admin/order' && method === 'PUT') return reorder(request, env);

  m = path.match(/^\/api\/admin\/tracks\/([a-z0-9-]+)$/);
  if (m && method === 'PATCH') return editTrack(request, env, m[1]);
  if (m && method === 'DELETE') return deleteTrack(env, m[1]);

  throw new HttpError(404, 'Not found.');
}

// ---------- tracks ----------

async function listTracks(env) {
  return (await env.MEDIA.get('tracks', 'json')) ?? [];
}

async function saveTracks(env, tracks) {
  await env.MEDIA.put('tracks', JSON.stringify(tracks));
}

function publicTrack(t) {
  const { id, title, note, duration, audioType, hasCover, createdAt } = t;
  return { id, title, note, duration, audioType, hasCover, createdAt };
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

async function upload(request, env) {
  const form = await request.formData();
  const audio = form.get('audio');
  const cover = form.get('cover');
  const title = cleanText(form.get('title'), 120);

  if (!title) throw new HttpError(400, 'Give the track a title.');
  if (!(audio instanceof File) || audio.size === 0) throw new HttpError(400, 'Choose an audio file.');
  if (!audio.type.startsWith('audio/')) throw new HttpError(400, 'That file is not audio. Use MP3, M4A, OGG or WAV.');
  if (audio.size > MAX_AUDIO_BYTES) throw new HttpError(413, 'The audio file is over 25 MB. Export it as MP3 and try again.');

  const hasCover = cover instanceof File && cover.size > 0;
  if (hasCover) {
    if (!cover.type.startsWith('image/')) throw new HttpError(400, 'The cover must be an image.');
    if (cover.size > MAX_COVER_BYTES) throw new HttpError(413, 'The cover image is over 2 MB.');
  }

  const id = crypto.randomUUID();
  await env.MEDIA.put(`audio:${id}`, await audio.arrayBuffer(), {
    metadata: { type: audio.type },
  });
  if (hasCover) {
    await env.MEDIA.put(`cover:${id}`, await cover.arrayBuffer(), {
      metadata: { type: cover.type },
    });
  }

  const duration = Number(form.get('duration'));
  const track = {
    id,
    title,
    note: cleanText(form.get('note'), 280),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    audioType: audio.type,
    fileName: cleanText(audio.name, 200),
    size: audio.size,
    hasCover,
    hidden: form.get('hidden') === 'true',
    createdAt: new Date().toISOString(),
  };
  const tracks = await listTracks(env);
  tracks.unshift(track);
  await saveTracks(env, tracks);
  return json(track, 201);
}

async function editTrack(request, env, id) {
  const body = await readJson(request);
  const tracks = await listTracks(env);
  const track = tracks.find((t) => t.id === id);
  if (!track) throw new HttpError(404, 'That track no longer exists.');
  if ('title' in body) {
    const title = cleanText(body.title, 120);
    if (!title) throw new HttpError(400, 'Give the track a title.');
    track.title = title;
  }
  if ('note' in body) track.note = cleanText(body.note, 280);
  if ('hidden' in body) track.hidden = Boolean(body.hidden);
  await saveTracks(env, tracks);
  return json(track);
}

async function deleteTrack(env, id) {
  const tracks = await listTracks(env);
  const remaining = tracks.filter((t) => t.id !== id);
  if (remaining.length === tracks.length) throw new HttpError(404, 'That track no longer exists.');
  await saveTracks(env, remaining);
  await Promise.all([env.MEDIA.delete(`audio:${id}`), env.MEDIA.delete(`cover:${id}`)]);
  return json({ ok: true });
}

async function reorder(request, env) {
  const { ids } = await readJson(request);
  if (!Array.isArray(ids)) throw new HttpError(400, 'Send the new order as a list of ids.');
  const tracks = await listTracks(env);
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const ordered = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
  // Anything the client didn't mention keeps its place at the end.
  for (const t of tracks) if (!ids.includes(t.id)) ordered.push(t);
  await saveTracks(env, ordered);
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
    'X-Content-Type-Options': 'nosniff',
  });
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
