// Community members: invite links, join requests the owner approves, and
// member sign-in. A member session is a signed cookie naming the user; every
// request re-reads the user so a suspension or removal takes effect at once.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { safeEqual } from './auth.js';
import { access, knownCommunities } from './spaces.js';
import { addRequests, addActive, cleanCommunityIds, ownerMemberId, syncOwnerMember } from './communities.js';

export const MEMBER_COOKIE = 'member_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // the most Workers allows
const MAX_PENDING = 200;
const USERNAME = /^[\p{L}\p{N}_.-]{3,30}$/u;

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomToken = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// ---------- passwords ----------

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = await pbkdf2(password, fromB64url(salt), Number(iter));
  return safeEqual(b64url(actual), hash);
}

// ---------- sessions ----------

async function sign(message, env) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`member:${env.ADMIN_PASSWORD}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

async function sessionCookie(userId, env) {
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  const payload = `${userId}.${expires}`;
  const token = `${payload}.${await sign(payload, env)}`;
  return `${MEMBER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

const clearCookie = () => `${MEMBER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// The signed-in, active member for this request, or null.
export async function currentMember(request, env) {
  if (!env.ADMIN_PASSWORD || !env.DB) return null;
  const raw = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${MEMBER_COOKIE}=`))
    ?.slice(MEMBER_COOKIE.length + 1);
  const [userId, expires, sig] = (raw ?? '').split('.');
  if (!userId || !expires || !sig || Number(expires) < Date.now()) return null;
  if (!(await safeEqual(sig, await sign(`${userId}.${expires}`, env)))) return null;
  const d = await db(env);
  const user = await d.prepare(`SELECT id, username, display_name FROM users WHERE id = ? AND status = 'active'`).bind(userId).first();
  return user ? { id: user.id, username: user.username, displayName: user.display_name } : null;
}

// ---------- public routes ----------

async function findInvite(d, code) {
  if (!code) return null;
  const inv = await d.prepare('SELECT * FROM invites WHERE code = ?').bind(String(code)).first();
  if (!inv) return null;
  if (inv.uses >= inv.max_uses) return null;
  if (inv.expires_at && inv.expires_at < new Date().toISOString()) return null;
  return inv;
}

export async function checkInvite(env, url) {
  const d = await db(env);
  const inv = await findInvite(d, url.searchParams.get('code'));
  return json({ valid: Boolean(inv) });
}

export async function join(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'The site is not set up for sign-ups yet.');
  const body = await readJson(request);
  if (body.website) throw new HttpError(400, 'Could not sign you up.'); // honeypot
  const username = cleanText(body.username, 30).normalize('NFKC');
  const displayName = cleanText(body.displayName, 60) || username;
  const password = String(body.password ?? '');
  if (!USERNAME.test(username)) throw new HttpError(400, 'Username: 3 to 30 letters, digits, dots, dashes or underscores.');
  if (password.length < 8) throw new HttpError(400, 'Password: at least 8 characters.');
  if (password.length > 200) throw new HttpError(400, 'Password is too long.');

  const d = await db(env);
  // The communities asked for: the join page's checkboxes, or the one page
  // the visitor came from.
  const wanted = Array.isArray(body.communities) ? body.communities : body.communityId ? [body.communityId] : [];
  const publicAcc = () => access(env, { role: 'public', member: null });

  // Already has an account (same username and password): the new request
  // joins that account instead of asking for a second one.
  const existing = await d.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    if (!(await verifyPassword(password, existing.password_hash))) {
      await new Promise((r) => setTimeout(r, 1000)); // as slow as a wrong sign-in
      throw new HttpError(409, 'That username is taken.');
    }
    if (existing.status !== 'active' && existing.status !== 'pending') throw new HttpError(403, 'This account is not active.');
    const acc = existing.status === 'active' ? await access(env, { role: 'member', member: { id: existing.id } }) : await publicAcc();
    await addRequests(env, acc, existing.id, wanted, body.note);
    if (existing.status === 'pending') return json({ status: 'pending', existing: true }, 200);
    return json({ status: 'active', existing: true }, 200, { 'Set-Cookie': await sessionCookie(existing.id, env) });
  }

  const invite = body.code ? await findInvite(d, body.code) : null;
  if (body.code && !invite) throw new HttpError(400, 'This invite link is no longer valid.');
  if (!invite) {
    const { n } = await d.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`).first();
    if (n >= MAX_PENDING) throw new HttpError(429, 'Too many open requests right now. Try again later.');
  }

  const user = {
    id: crypto.randomUUID(),
    status: invite ? 'active' : 'pending',
  };
  try {
    await d
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, status, request_note, invite_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(user.id, username, displayName, await hashPassword(password), user.status, cleanText(body.note, 600), invite?.code ?? null, new Date().toISOString())
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'That username is taken.');
    throw err;
  }
  if (wanted.length) await addRequests(env, await publicAcc(), user.id, wanted, body.note);
  if (!invite) return json({ status: 'pending' }, 201);

  // Count the use only if the invite still has room (two people racing for the last use).
  const { meta } = await d.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ? AND uses < max_uses').bind(invite.code).run();
  if (!meta.changes) {
    await d.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
    throw new HttpError(400, 'This invite link is no longer valid.');
  }
  // An invite to communities puts the new member straight in them.
  await addActive(env, user.id, JSON.parse(invite.communities || '[]'));
  return json({ status: 'active' }, 201, { 'Set-Cookie': await sessionCookie(user.id, env) });
}

export async function memberLogin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'The site is not set up for sign-ins yet.');
  const body = await readJson(request);
  const d = await db(env);
  const user = await d.prepare('SELECT * FROM users WHERE username = ?').bind(cleanText(body.username, 30).normalize('NFKC')).first();
  const ok = user && (await verifyPassword(String(body.password ?? ''), user.password_hash));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1000));
    throw new HttpError(401, 'Wrong username or password.');
  }
  if (user.status === 'pending') throw new HttpError(403, 'Your request is waiting for approval.');
  if (user.status !== 'active') throw new HttpError(403, 'This account is not active.');
  await d.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id).run();
  return json({ ok: true, displayName: user.display_name }, 200, { 'Set-Cookie': await sessionCookie(user.id, env) });
}

export function memberLogout() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

export async function me(request, env) {
  const user = await currentMember(request, env);
  if (!user) throw new HttpError(401, 'Not signed in.');
  return json(user);
}

// ---------- owner (studio) ----------

export async function listCommunity(env) {
  await syncOwnerMember(env);
  const ownerId = await ownerMemberId(env);
  const d = await db(env);
  const [users, invites, joined] = await Promise.all([
    d.prepare(`SELECT id, username, display_name, status, request_note, invite_code, created_at, last_login_at FROM users ORDER BY created_at DESC`).all(),
    d.prepare('SELECT * FROM invites ORDER BY created_at DESC').all(),
    d.prepare(`SELECT user_id, community_id, status FROM community_members WHERE status IN ('active', 'pending')`).all(),
  ]);
  // Where each person stands: { communityId: 'active' | 'pending' }.
  const where = new Map();
  for (const r of joined.results) where.set(r.user_id, { ...(where.get(r.user_id) ?? {}), [r.community_id]: r.status });
  return json({
    users: users.results.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      status: u.status,
      note: u.request_note,
      viaInvite: Boolean(u.invite_code),
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      communities: where.get(u.id) ?? {},
      isOwner: u.id === ownerId,
    })),
    invites: invites.results.map((i) => ({
      code: i.code,
      note: i.note,
      maxUses: i.max_uses,
      uses: i.uses,
      expiresAt: i.expires_at,
      communities: JSON.parse(i.communities || '[]'),
      createdAt: i.created_at,
    })),
  });
}

export async function setMemberStatus(request, env, id) {
  const { status } = await readJson(request);
  if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'Unknown status.');
  const d = await db(env);
  const { meta } = await d.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, id).run();
  if (!meta.changes) throw new HttpError(404, 'That member no longer exists.');
  return json({ ok: true });
}

export async function removeMember(env, id) {
  const d = await db(env);
  const { meta } = await d.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  if (!meta.changes) throw new HttpError(404, 'That member no longer exists.');
  return json({ ok: true });
}

export async function createInvite(request, env) {
  const body = await readJson(request);
  const maxUses = Math.min(Math.max(Math.round(Number(body.maxUses) || 1), 1), 1000);
  const days = Number(body.days);
  const invite = {
    code: randomToken(12),
    note: cleanText(body.note, 200),
    maxUses,
    uses: 0,
    expiresAt: Number.isFinite(days) && days > 0 ? new Date(Date.now() + Math.min(days, 365) * 86400 * 1000).toISOString() : null,
    communities: body.communities ? cleanCommunityIds(body.communities, await knownCommunities(env)) : [],
    createdAt: new Date().toISOString(),
  };
  const d = await db(env);
  await d
    .prepare('INSERT INTO invites (code, note, max_uses, uses, expires_at, communities, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .bind(invite.code, invite.note, invite.maxUses, invite.expiresAt, JSON.stringify(invite.communities), invite.createdAt)
    .run();
  return json(invite, 201);
}

export async function revokeInvite(env, code) {
  const d = await db(env);
  const { meta } = await d.prepare('DELETE FROM invites WHERE code = ?').bind(code).run();
  if (!meta.changes) throw new HttpError(404, 'That invite no longer exists.');
  return json({ ok: true });
}
