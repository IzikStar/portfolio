// Notifications that pop up on a person's phone or computer (Web Push), also
// when the site is closed, once they said yes on /notifications.
//
//   GET  /api/push/key          the site's public key (the browser needs it to subscribe)
//   POST /api/push/subscribe    { subscription } this device, for the signed-in person
//   POST /api/push/unsubscribe  { endpoint }
//   GET  /api/push/prefs        which kinds of notification this person gets
//   PUT  /api/push/prefs        { prefs: { <kind>: true|false } }
//   POST /api/push/test         a test notification to this person's devices
//
// Who gets what: a member hears about their own communities only (a new post,
// the chat, a message for them, a comment on what they wrote, a tag, being let
// in); the owner hears about everything (requests, new members, posts, the
// chat, comments). The owner's own member account counts as the owner, so he
// never gets the same thing twice. A message for some members only reaches
// them alone, and a device showing that chat right now does not pop it up.
//
// The keys (VAPID, RFC 8292) are made on first use and kept in D1 settings, so
// there is nothing to set up. Each message is encrypted for the one device it
// goes to (RFC 8291); the push services only carry it.
import { db } from './db.js';
import { HttpError, json, readJson } from './http.js';
import { SITE } from './site.js';
import { excerpt } from './markdown.js';
import { ownerMemberId } from './communities.js';
import { mentionNames } from './mentions.js';

const KEYS = 'push_vapid';
const MAX_DEVICES = 10;
const TTL = 3 * 86400;
const MAX_FAILS = 5;

// The kinds of notification each side can turn on or off (all on to begin with).
export const KINDS = {
  member: [
    { id: 'post', label: 'פוסט חדש בקהילה שלי' },
    { id: 'chat', label: 'הודעות בצ׳אט של הקהילה' },
    { id: 'private', label: 'הודעה פרטית אליי' },
    { id: 'comment', label: 'תגובה על מה שכתבתי' },
    { id: 'mention', label: 'מישהו תייג אותי' },
    { id: 'approved', label: 'אישור הצטרפות לקהילה' },
  ],
  owner: [
    { id: 'join', label: 'בקשות הצטרפות' },
    { id: 'member', label: 'חברים חדשים' },
    { id: 'post', label: 'פוסטים חדשים בקהילות' },
    { id: 'chat', label: 'הודעות בצ׳אטים' },
    { id: 'private', label: 'הודעה פרטית אליי' },
    { id: 'comment', label: 'תגובות' },
  ],
};

// Services browsers subscribe through. The worker only ever posts to these.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];

const enc = new TextEncoder();
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// ---------- keys ----------

async function vapid(env) {
  const d = await db(env);
  const read = async () => {
    const row = await d.prepare('SELECT value FROM settings WHERE key = ?').bind(KEYS).first();
    return row ? JSON.parse(row.value) : null;
  };
  let keys = await read();
  if (keys) return keys;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const made = {
    publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  // Two first uses at once: whichever wrote first wins, both use it.
  await d.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(KEYS, JSON.stringify(made)).run();
  keys = await read();
  return keys;
}

// The Authorization header for one push service (RFC 8292).
export async function vapidHeader(keys, endpoint, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const part = (o) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: SITE })}`;
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ---------- encryption (RFC 8291, aes128gcm) ----------

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// `fixed` (tests only): the server's key pair and the salt, for the RFC's example.
export async function encrypt(subscription, text, fixed = {}) {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const own = fixed.keys ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', own.publicKey));
  const theirs = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, own.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the text, then the "last record" delimiter.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

// ---------- who is asking ----------

// The id a person's devices and choices are kept under: "owner" or a member's id.
async function whoOf(env, v) {
  if (v.acc?.owner || v.role === 'owner') return 'owner';
  if (!v.member) return null;
  return v.member.id === (await ownerMemberId(env)) ? 'owner' : v.member.id;
}

async function mustWho(env, v) {
  const who = await whoOf(env, v);
  if (!who) throw new HttpError(401, 'Sign in first.');
  return who;
}

const kindsFor = (who) => (who === 'owner' ? KINDS.owner : KINDS.member);

async function prefsOf(env, whos) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT who, prefs FROM push_prefs WHERE who IN (SELECT value FROM json_each(?))').bind(JSON.stringify(whos)).all();
  const out = new Map();
  for (const r of results) {
    try {
      out.set(r.who, JSON.parse(r.prefs));
    } catch {
      // unreadable choices read as "all on"
    }
  }
  return out;
}

// ---------- API ----------

export async function pushApi(request, env, url, v) {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/push/key' && method === 'GET') return json({ publicKey: (await vapid(env)).publicKey });
  const who = await mustWho(env, v);
  const d = await db(env);
  if (path === '/api/push/subscribe' && method === 'POST') {
    const { subscription: s } = await readJson(request);
    const endpoint = String(s?.endpoint ?? '');
    let host;
    try {
      const u = new URL(endpoint);
      if (u.protocol !== 'https:') throw new Error();
      host = u.hostname;
    } catch {
      throw new HttpError(400, 'Not a push subscription.');
    }
    if (!PUSH_HOSTS.some((re) => re.test(host))) throw new HttpError(400, 'Unknown push service.');
    const p256dh = String(s?.keys?.p256dh ?? '');
    const auth = String(s?.keys?.auth ?? '');
    let ok = false;
    try {
      ok = fromB64url(p256dh).length === 65 && fromB64url(auth).length === 16;
    } catch {
      // not base64
    }
    if (!ok || endpoint.length > 1000) throw new HttpError(400, 'Not a push subscription.');
    const now = new Date().toISOString();
    await d
      .prepare(
        `INSERT INTO push_subs (endpoint, who, p256dh, auth, agent, created_at, fails) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(endpoint) DO UPDATE SET who = excluded.who, p256dh = excluded.p256dh, auth = excluded.auth, agent = excluded.agent, fails = 0`,
      )
      .bind(endpoint, who, p256dh, auth, String(request.headers.get('User-Agent') ?? '').slice(0, 200), now)
      .run();
    // Keep the newest few devices per person.
    await d
      .prepare(`DELETE FROM push_subs WHERE who = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE who = ? ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`)
      .bind(who, who)
      .run();
    return json({ ok: true }, 201);
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const { endpoint } = await readJson(request);
    await d.prepare('DELETE FROM push_subs WHERE endpoint = ? AND who = ?').bind(String(endpoint ?? ''), who).run();
    return json({ ok: true });
  }
  if (path === '/api/push/prefs' && method === 'GET') {
    const prefs = (await prefsOf(env, [who])).get(who) ?? {};
    const { n } = await d.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE who = ?').bind(who).first();
    return json({ owner: who === 'owner', devices: n, kinds: kindsFor(who).map((k) => ({ ...k, on: prefs[k.id] !== false })) });
  }
  if (path === '/api/push/prefs' && method === 'PUT') {
    const { prefs } = await readJson(request);
    const clean = {};
    for (const k of kindsFor(who)) clean[k.id] = prefs?.[k.id] !== false;
    await d
      .prepare('INSERT INTO push_prefs (who, prefs) VALUES (?, ?) ON CONFLICT(who) DO UPDATE SET prefs = excluded.prefs')
      .bind(who, JSON.stringify(clean))
      .run();
    return json({ ok: true, prefs: clean });
  }
  if (path === '/api/push/test' && method === 'POST') {
    const sent = await deliver(env, [who], null, { title: 'ההתראות עובדות', body: 'כך תיראה התראה מהאתר.', url: '/notifications', tag: 'test' });
    return json({ ok: true, sent });
  }
  throw new HttpError(404, 'Not found.');
}

// ---------- sending ----------

// Send one notification to these people (ids or "owner") who did not turn this
// kind off. `kind` null skips the check (the test button). Returns how many
// devices took it.
async function deliver(env, whos, kind, message) {
  const list = [...new Set(whos)].filter(Boolean);
  if (!list.length) return 0;
  const d = await db(env);
  // Members whose account was suspended or removed hear nothing.
  const { results: subs } = await d
    .prepare(
      `SELECT * FROM push_subs WHERE who IN (SELECT value FROM json_each(?))
       AND (who = 'owner' OR who IN (SELECT id FROM users WHERE status = 'active'))`,
    )
    .bind(JSON.stringify(list))
    .all();
  if (!subs.length) return 0;
  const prefs = kind ? await prefsOf(env, list) : new Map();
  const wanted = subs.filter((s) => !kind || prefs.get(s.who)?.[kind] !== false);
  if (!wanted.length) return 0;
  const keys = await vapid(env);
  const text = JSON.stringify({ title: message.title, body: message.body, url: message.url ?? '/', tag: message.tag ?? kind ?? 'site' });
  const results = await Promise.all(wanted.map((s) => sendOne(env, keys, s, text, message.urgent)));
  return results.filter(Boolean).length;
}

async function sendOne(env, keys, sub, text, urgent) {
  const d = await db(env);
  let res;
  try {
    const body = await encrypt({ keys: { p256dh: sub.p256dh, auth: sub.auth } }, text);
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(keys, sub.endpoint),
        TTL: String(TTL),
        Urgency: urgent ? 'high' : 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
      },
      body,
    });
  } catch (err) {
    console.error('push', err);
    return false;
  }
  if (res.ok) {
    if (sub.fails) await d.prepare('UPDATE push_subs SET fails = 0 WHERE endpoint = ?').bind(sub.endpoint).run();
    return true;
  }
  // Gone: the person turned notifications off or the browser dropped the subscription.
  if (res.status === 404 || res.status === 410 || sub.fails + 1 >= MAX_FAILS) {
    await d.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
  } else {
    await d.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').bind(sub.endpoint).run();
    console.error('push refused', res.status, await res.text().catch(() => ''));
  }
  return false;
}

// Run after the response when the request lets us (env.waitUntil, set by the
// worker), otherwise now. A failed push never fails what the person did.
function later(env, work) {
  const p = work().catch((err) => console.error('notify', err));
  if (typeof env.waitUntil === 'function') env.waitUntil(p);
  else return p;
}

// Members' ids as their devices know them ("owner" for the owner's own account),
// without the people in `skip`.
async function asWho(env, ids, skip = []) {
  const om = await ownerMemberId(env);
  const map = (id) => (id && id === om ? 'owner' : id);
  const out = new Set(ids.map(map));
  for (const s of skip) out.delete(map(s));
  out.delete(null);
  out.delete(undefined);
  return [...out];
}

async function activeMembers(env, communityId) {
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT m.user_id FROM community_members m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.status = 'active' AND u.status = 'active'`,
    )
    .bind(communityId)
    .all();
  return results.map((r) => r.user_id);
}

// Tags as names, markdown as plain text.
async function plain(env, text, max = 160) {
  const names = await mentionNames(env, [text]);
  return excerpt(String(text).replace(/@\{([0-9a-f-]{36})\}/g, (m, id) => (names.get(id) ? `@${names.get(id)}` : '')), max);
}

// ---------- the events ----------

// A new post on a community's blog: its members and the owner, not the
// writer. People tagged in it hear that they were tagged instead.
export function onPost(env, c, post, path, tagged = []) {
  return later(env, async () => {
    const writer = post.userId ?? 'owner';
    const tags = (await asWho(env, tagged, [writer])).filter((w) => w !== 'owner');
    const whos = await asWho(env, [...(await activeMembers(env, c.id)), 'owner'], [writer, ...tags]);
    await deliver(env, whos, 'post', { title: `פוסט חדש ב${c.title}`, body: `${post.author}: ${post.title}`, url: path, tag: `post-${post.id}` });
    await deliver(env, tags, 'mention', { title: `${post.author} תייג/ה אותך`, body: post.title, url: path, tag: `post-${post.id}` });
  });
}

// A chat message. One for some members only goes to them (and to the owner
// only when it is for him); a message to everyone goes to the whole community.
// A device that has the chat in front of it right now skips showing it
// (public/sw.js); the person's other devices still get it.
export function onChat(env, c, m, path) {
  return later(env, async () => {
    const writer = m.userId ?? 'owner';
    const priv = m.audience.length > 0;
    const whos = await asWho(env, priv ? m.audience : [...(await activeMembers(env, c.id)), 'owner'], [writer]);
    if (!(await anyDevices(env, whos))) return;
    const body = await plain(env, m.body, 180);
    if (priv) await deliver(env, whos, 'private', { title: `הודעה פרטית מ${m.author}`, body, url: path, tag: `dm-${c.id}`, urgent: true });
    else await deliver(env, whos, 'chat', { title: c.title, body: `${m.author}: ${body}`, url: path, tag: `chat-${c.id}` });
  });
}

async function anyDevices(env, whos) {
  if (!whos.length) return false;
  const d = await db(env);
  return Boolean(await d.prepare('SELECT 1 AS x FROM push_subs WHERE who IN (SELECT value FROM json_each(?)) LIMIT 1').bind(JSON.stringify(whos)).first());
}

// A comment. The owner hears of every one; the writer of the post and of the
// comment replied to hear of theirs; tagged people hear they were tagged.
// `canSee(userId)` says whether that member may read the thing commented on.
export function onComment(env, comment, { title, path, ownerOfTarget, parentWriter, tagged, canSee }) {
  return later(env, async () => {
    const writer = comment.userId ?? 'owner';
    if (!(await anyDevices(env, await asWho(env, [parentWriter, ownerOfTarget, ...(tagged ?? []), 'owner'].filter(Boolean), [writer])))) return;
    const body = await plain(env, comment.body, 160);
    const url = `${path}#comments`;
    const done = new Set(await asWho(env, [writer]));
    const send = async (ids, kind, heading, text) => {
      const ok = [];
      for (const id of ids) if (id === 'owner' || (await canSee(id))) ok.push(id);
      const whos = (await asWho(env, ok)).filter((w) => !done.has(w));
      whos.forEach((w) => done.add(w));
      await deliver(env, whos, kind, { title: heading, body: text, url, tag: `comment-${comment.entryId}` });
    };
    if (parentWriter) await send([parentWriter], 'comment', 'תשובה לתגובה שלך', `${comment.author}: ${body}`);
    if (ownerOfTarget && ownerOfTarget !== 'owner') await send([ownerOfTarget], 'comment', `תגובה חדשה על "${title}"`, `${comment.author}: ${body}`);
    if (tagged?.length) await send(tagged, 'mention', `${comment.author} תייג/ה אותך`, body);
    await send(['owner'], 'comment', `תגובה חדשה על "${title}"`, `${comment.author}: ${body}`);
  });
}

// Someone asked to join a community (or signed up without one).
export function onJoinRequest(env, name, c) {
  return later(env, () =>
    deliver(env, ['owner'], 'join', {
      title: 'בקשת הצטרפות',
      body: c ? `${name} מבקש/ת להצטרף ל${c.title}` : `${name} נרשם/ה לאתר ומחכה לאישור`,
      url: c ? `/studio#group/${c.id}` : '/studio#community',
      tag: `join-${c?.id ?? 'site'}`,
    }),
  );
}

// Someone came in with an invite link.
export function onNewMember(env, name) {
  return later(env, () => deliver(env, ['owner'], 'member', { title: 'חבר/ה חדש/ה', body: `${name} הצטרף/ה עם קישור הזמנה`, url: '/studio#community', tag: 'member' }));
}

// The owner let a member into communities: [{ id, slug, title }].
export function onApproved(env, userId, communities, pathOf) {
  if (!communities.length) return;
  return later(env, async () => {
    const whos = await asWho(env, [userId], ['owner']);
    const names = communities.map((c) => c.title).join(', ');
    await deliver(env, whos, 'approved', {
      title: communities.length === 1 ? `התקבלת לקהילה ${names}` : 'התקבלת לקהילות',
      body: communities.length === 1 ? 'אפשר להיכנס, לקרוא ולכתוב.' : names,
      url: communities.length === 1 ? pathOf(communities[0]) : '/community',
      tag: `approved-${userId}`,
    });
  });
}
