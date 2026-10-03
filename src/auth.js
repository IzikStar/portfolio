// Owner sign-in: ADMIN_PASSWORD is the only way in. The session is a signed,
// expiring cookie (no server-side state), valid across the whole site so the
// owner also sees private items on the public pages.
import { HttpError, json, readJson } from './http.js';

const SESSION_HOURS = 12;
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
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = `${expires}.${await sign(String(expires), env.ADMIN_PASSWORD)}`;
  const headers = new Headers();
  headers.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
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

export async function isOwner(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map((c) => c.trim());
  for (const c of cookies) {
    if (!c.startsWith(`${COOKIE}=`)) continue;
    const [expires, sig] = c.slice(COOKIE.length + 1).split('.');
    if (!expires || !sig || Number(expires) < Date.now()) continue;
    if (await safeEqual(sig, await sign(expires, env.ADMIN_PASSWORD))) return true;
  }
  return false;
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
