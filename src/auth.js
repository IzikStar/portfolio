// Owner sign-in: ADMIN_PASSWORD is the only way in. The session is a signed,
// expiring cookie (no server-side state), valid across the whole site so the
// owner also sees private items on the public pages. It lasts 30 days and is
// renewed as it is used (renewOwner), so only a month away signs him out.
import { HttpError, json, readJson } from './http.js';

const SESSION_HOURS = 30 * 24;
// A session this much younger than its full length is renewed on the next visit.
export const RENEW_AFTER_MS = 24 * 3600 * 1000;
export const COOKIE = 'admin_session';

export async function login(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin password is not set on the server yet.');
  const { password } = await readJson(request);
  const ok = await safeEqual(String(password ?? ''), env.ADMIN_PASSWORD);
  if (!ok) {
    // Slow down guessing without spending KV writes on a counter.
    await new Promise((r) => setTimeout(r, 1000));
    throw new HttpError(401, 'Wrong password.');
  }
  const headers = new Headers();
  headers.append('Set-Cookie', await ownerCookie(env));
  // Sessions from before the platform were scoped to /api/admin; drop them.
  headers.append('Set-Cookie', clearCookie('/api/admin'));
  return json({ ok: true }, 200, headers);
}

export function logout() {
  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie('/'));
  headers.append('Set-Cookie', clearCookie('/api/admin'));
  return json({ ok: true }, 200, headers);
}

async function ownerCookie(env) {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = `${expires}.${await sign(String(expires), env.ADMIN_PASSWORD)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}

// When the owner's valid session ends, in ms since 1970, or 0.
async function ownerUntil(request, env) {
  if (!env.ADMIN_PASSWORD) return 0;
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map((c) => c.trim());
  for (const c of cookies) {
    if (!c.startsWith(`${COOKIE}=`)) continue;
    const [expires, sig] = c.slice(COOKIE.length + 1).split('.');
    if (!expires || !sig || Number(expires) < Date.now()) continue;
    if (await safeEqual(sig, await sign(expires, env.ADMIN_PASSWORD))) return Number(expires);
  }
  return 0;
}

export async function isOwner(request, env) {
  return (await ownerUntil(request, env)) > 0;
}

// A fresh 30-day cookie when the owner's session is a day old or more.
export async function renewOwner(request, env) {
  const until = await ownerUntil(request, env);
  if (!until || until - Date.now() > SESSION_HOURS * 3600 * 1000 - RENEW_AFTER_MS) return null;
  return ownerCookie(env);
}

export async function requireOwner(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin password is not set on the server yet.');
  if (!(await isOwner(request, env))) throw new HttpError(401, 'Please log in again.');
}

function clearCookie(path) {
  return `${COOKIE}=; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

const enc = new TextEncoder();

async function sign(message, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`session:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compare digests so timing does not leak the length or prefix of the secret.
export async function safeEqual(a, b) {
  const [da, db] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
