import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { encrypt, b64url, fromB64url, vapidHeader } from '../src/push.js';

// RFC 8291, appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const pointJwk = (raw, d) => {
  const p = fromB64url(raw);
  return { kty: 'EC', crv: 'P-256', x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)), ...(d ? { d } : {}) };
};

describe('push encryption', () => {
  it('matches the example in RFC 8291', async () => {
    const privateKey = await crypto.subtle.importKey('jwk', pointJwk(RFC.asPublic, RFC.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('raw', fromB64url(RFC.asPublic), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const body = await encrypt({ keys: { p256dh: RFC.uaPublic, auth: RFC.auth } }, RFC.plaintext, { keys: { privateKey, publicKey }, salt: fromB64url(RFC.salt) });
    expect(b64url(body)).toBe(RFC.body);
  });
});

describe('VAPID', () => {
  it('signs a token the push service can check with the public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const keys = { publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
    const header = await vapidHeader(keys, 'https://fcm.googleapis.com/fcm/send/abc');
    const [, t, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(k).toBe(keys.publicKey);
    const [h, p, sig] = t.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64url(p)))).toMatchObject({ aud: 'https://fcm.googleapis.com' });
    const pub = await crypto.subtle.importKey('raw', fromB64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(sig), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });
});

// ---------- the site end to end, with the push services stubbed ----------

const ORIGIN = 'https://site.test';
let env;
let pushes; // what the worker posted to push services
let present; // who has a chat open, by community id
let status; // what the push service answers

beforeEach(() => {
  pushes = [];
  present = {};
  status = 201;
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`) },
    CHAT: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (input) => (new URL(typeof input === 'string' ? input : input.url).pathname === '/present' ? Response.json({ ids: present[id] ?? [] }) : new Response('ok')),
      }),
    },
  };
  vi.stubGlobal('fetch', async (url, init) => {
    pushes.push({ url: String(url), init });
    return new Response('', { status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));
async function member(o, username) {
  const { code } = await (await call(o, '/api/studio/invites', 'POST', {})).json();
  const cookie = cookieOf(await call(null, '/api/member/join', 'POST', { code, username, displayName: username, password: 'longenough' }));
  return { cookie, id: (await (await call(cookie, '/api/member/me')).json()).id };
}
const club = async (o, title, more = {}) => (await call(o, '/api/studio/communities', 'POST', { title, ...more })).json();
const admit = (o, c, m) => call(o, `/api/studio/communities/${c.id}/members`, 'PATCH', { userId: m.id, status: 'active' });

// A browser's subscription, with the private half kept to read what arrives.
let n = 0;
async function device() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    authBytes: auth,
    json: { endpoint: `https://fcm.googleapis.com/fcm/send/device-${++n}`, keys: { p256dh: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64url(auth) } },
  };
}
async function subscribed(cookie) {
  const dev = await device();
  expect((await call(cookie, '/api/push/subscribe', 'POST', { subscription: dev.json })).status).toBe(201);
  return dev;
}

// What the browser does with a push: RFC 8291 from the receiving side.
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
async function read(dev, body) {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const idlen = bytes[20];
  const asPublic = bytes.slice(21, 21 + idlen);
  const sealed = bytes.slice(21 + idlen);
  const uaPublic = fromB64url(dev.json.keys.p256dh);
  const theirs = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, dev.pair.privateKey, 256));
  const te = new TextEncoder();
  const join = (...a) => Uint8Array.from(a.flatMap((x) => [...x]));
  const ikm = await hkdf(dev.authBytes, shared, join(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
}
const to = (dev) => pushes.filter((p) => p.url === dev.json.endpoint);
const got = async (dev) => Promise.all(to(dev).map((p) => read(dev, p.init.body)));

describe('notification settings', () => {
  it('needs a sign-in and a real push service', async () => {
    const o = await owner();
    const dana = await member(o, 'dana');
    const dev = await device();
    expect((await call(null, '/api/push/subscribe', 'POST', { subscription: dev.json })).status).toBe(401);
    expect((await call(dana.cookie, '/api/push/subscribe', 'POST', { subscription: { ...dev.json, endpoint: 'https://evil.test/x' } })).status).toBe(400);
    expect((await call(dana.cookie, '/api/push/subscribe', 'POST', { subscription: { ...dev.json, keys: { p256dh: 'abc', auth: 'abc' } } })).status).toBe(400);
    expect((await call(dana.cookie, '/api/push/subscribe', 'POST', { subscription: dev.json })).status).toBe(201);
    const key = await (await call(null, '/api/push/key')).json();
    expect(fromB64url(key.publicKey)).toHaveLength(65);
    expect((await (await call(null, '/api/push/key')).json()).publicKey).toBe(key.publicKey);
  });

  it('shows members and the owner their own kinds, and keeps choices', async () => {
    const o = await owner();
    const dana = await member(o, 'dana');
    const mine = await (await call(dana.cookie, '/api/push/prefs')).json();
    expect(mine.owner).toBe(false);
    expect(mine.kinds.map((k) => k.id)).toContain('approved');
    expect(mine.kinds.every((k) => k.on)).toBe(true);
    await call(dana.cookie, '/api/push/prefs', 'PUT', { prefs: { chat: false, made_up: false } });
    const after = await (await call(dana.cookie, '/api/push/prefs')).json();
    expect(after.kinds.find((k) => k.id === 'chat').on).toBe(false);
    expect(after.kinds.find((k) => k.id === 'post').on).toBe(true);
    expect((await (await call(o, '/api/push/prefs')).json()).kinds.map((k) => k.id)).toContain('join');
  });

  it('sends a test notification to the asker only', async () => {
    const o = await owner();
    const dana = await member(o, 'dana');
    const eli = await member(o, 'eli');
    const d1 = await subscribed(dana.cookie);
    const e1 = await subscribed(eli.cookie);
    expect(await (await call(dana.cookie, '/api/push/test', 'POST')).json()).toEqual({ ok: true, sent: 1 });
    expect(to(e1)).toHaveLength(0);
    const [p] = to(d1);
    expect(p.init.headers.Authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(p.init.headers['Content-Encoding']).toBe('aes128gcm');
    expect((await got(d1))[0]).toMatchObject({ title: 'ההתראות עובדות', url: '/notifications' });
  });

  it('forgets a device the push service says is gone', async () => {
    const o = await owner();
    const dana = await member(o, 'dana');
    await subscribed(dana.cookie);
    status = 410;
    expect((await (await call(dana.cookie, '/api/push/test', 'POST')).json()).sent).toBe(0);
    expect((await (await call(dana.cookie, '/api/push/prefs')).json()).devices).toBe(0);
  });

  it('serves the settings page to people who are signed in', async () => {
    const o = await owner();
    const dana = await member(o, 'dana');
    const page = await (await call(dana.cookie, '/notifications')).text();
    expect(page).toContain('data-kind="private"');
    expect(page).toContain('rel="manifest"');
    expect(page).toContain('data-who="member"');
    expect(await (await call(o, '/notifications')).text()).toContain('data-kind="join"');
    const pub = await (await call(null, '/notifications')).text();
    expect(pub).toContain('/login?next=%2Fnotifications');
    expect(pub).not.toContain('data-kind=');
  });
});

describe('who hears about what', () => {
  it('chat messages reach the community and the owner, not the writer or outsiders', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const other = await club(o, 'Other');
    const [dana, eli, out] = [await member(o, 'dana'), await member(o, 'eli'), await member(o, 'out')];
    await admit(o, jokes, dana);
    await admit(o, jokes, eli);
    await admit(o, other, out);
    const [dd, ed, od, own] = [await subscribed(dana.cookie), await subscribed(eli.cookie), await subscribed(out.cookie), await subscribed(o)];

    expect((await call(dana.cookie, `/api/chat/${jokes.id}/messages`, 'POST', { body: 'knock knock' })).status).toBe(201);
    expect(to(dd)).toHaveLength(0);
    expect(to(od)).toHaveLength(0);
    expect((await got(ed))[0]).toMatchObject({ title: 'Jokes', body: 'dana: knock knock', url: `/community/${jokes.slug}/chat` });
    expect((await got(own))[0]).toMatchObject({ body: 'dana: knock knock' });
  });

  it('a message for some members reaches only them; the owner only when it is for him', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const [dana, eli, gil] = [await member(o, 'dana'), await member(o, 'eli'), await member(o, 'gil')];
    for (const m of [dana, eli, gil]) await admit(o, jokes, m);
    const [ed, gd, own] = [await subscribed(eli.cookie), await subscribed(gil.cookie), await subscribed(o)];

    await call(dana.cookie, `/api/chat/${jokes.id}/messages`, 'POST', { body: 'just for eli', audience: [eli.id] });
    expect((await got(ed))[0]).toMatchObject({ title: 'הודעה פרטית מdana', body: 'just for eli' });
    expect(to(gd)).toHaveLength(0);
    expect(to(own)).toHaveLength(0);

    await call(dana.cookie, `/api/chat/${jokes.id}/messages`, 'POST', { body: 'just for you', audience: ['owner'] });
    expect((await got(own))[0]).toMatchObject({ body: 'just for you' });
    expect(to(ed)).toHaveLength(1);
  });

  it('skips whoever has the chat open and whoever turned the kind off', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const [dana, eli, gil] = [await member(o, 'dana'), await member(o, 'eli'), await member(o, 'gil')];
    for (const m of [dana, eli, gil]) await admit(o, jokes, m);
    const [ed, gd] = [await subscribed(eli.cookie), await subscribed(gil.cookie)];
    present[jokes.id] = [eli.id];
    await call(gil.cookie, '/api/push/prefs', 'PUT', { prefs: { chat: false } });
    await call(dana.cookie, `/api/chat/${jokes.id}/messages`, 'POST', { body: 'hello' });
    expect(to(ed)).toHaveLength(0);
    expect(to(gd)).toHaveLength(0);
  });

  it('posts and comments: the community hears of posts, writers of comments on their posts', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const [dana, eli] = [await member(o, 'dana'), await member(o, 'eli')];
    await admit(o, jokes, dana);
    await admit(o, jokes, eli);
    const [dd, ed, own] = [await subscribed(dana.cookie), await subscribed(eli.cookie), await subscribed(o)];

    const post = await (await call(eli.cookie, `/api/blog/${jokes.id}/posts`, 'POST', { title: 'A pun', body: 'Read it' })).json();
    expect(to(ed)).toHaveLength(0);
    expect((await got(dd))[0]).toMatchObject({ title: 'פוסט חדש בJokes', body: 'eli: A pun', url: post.path });
    expect(to(own)).toHaveLength(1);

    await call(dana.cookie, '/api/comments', 'POST', { postId: post.id, body: `Nice one @{${eli.id}}` });
    const [, onComment] = await got(ed).then((list) => [null, list.at(-1)]);
    expect(onComment).toMatchObject({ title: 'תגובה חדשה על "A pun"', body: 'dana: Nice one @eli', url: `${post.path}#comments` });
    expect(to(ed)).toHaveLength(1); // tagged and the writer: one notification
    expect((await got(own)).at(-1)).toMatchObject({ title: 'תגובה חדשה על "A pun"' });
    expect(to(dd)).toHaveLength(1);
  });

  it('a hidden community stays hidden: an outsider hears nothing of it', async () => {
    const o = await owner();
    const secret = await club(o, 'Secret', { hidden: true });
    const [dana, out] = [await member(o, 'dana'), await member(o, 'out')];
    await admit(o, secret, dana);
    const od = await subscribed(out.cookie);
    await call(dana.cookie, `/api/blog/${secret.id}/posts`, 'POST', { title: 'Shh', body: 'quiet' });
    await call(dana.cookie, `/api/chat/${secret.id}/messages`, 'POST', { body: 'quiet' });
    expect(to(od)).toHaveLength(0);
  });

  it('join requests go to the owner; being let in goes to the member', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await member(o, 'dana');
    const [dd, own] = [await subscribed(dana.cookie), await subscribed(o)];
    expect((await call(dana.cookie, `/api/member/communities/${jokes.id}/join`, 'POST', { note: 'hi' })).status).toBe(201);
    expect((await got(own))[0]).toMatchObject({ title: 'בקשת הצטרפות', body: 'dana מבקש/ת להצטרף לJokes', url: `/studio#group/${jokes.id}` });
    await admit(o, jokes, dana);
    expect((await got(dd))[0]).toMatchObject({ title: 'התקבלת לקהילה Jokes', url: `/community/${jokes.slug}` });
    await admit(o, jokes, dana); // already in: not again
    expect(to(dd)).toHaveLength(1);
    await member(o, 'newbie');
    expect((await got(own)).at(-1)).toMatchObject({ title: 'חבר/ה חדש/ה' });
  });
});

describe('staying signed in', () => {
  const realNow = Date.now;
  afterEach(() => (Date.now = realNow));

  it('keeps sessions for 30 days and renews them as they are used', async () => {
    const res = await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD });
    expect(res.headers.get('Set-Cookie')).toContain(`Max-Age=${30 * 86400}`);
    const o = cookieOf(res);
    const dana = await member(o, 'dana');
    // Fresh: nothing to renew.
    expect((await call(o, '/community')).headers.get('Set-Cookie')).toBeNull();
    expect((await call(dana.cookie, '/community')).headers.get('Set-Cookie')).toBeNull();
    // Three weeks later both are still in, and get 30 more days.
    Date.now = () => realNow() + 21 * 86400 * 1000;
    const page = await call(o, '/community');
    expect(page.headers.get('Set-Cookie')).toMatch(/^admin_session=.+Max-Age=2592000/);
    const mres = await call(dana.cookie, '/community');
    expect(mres.headers.get('Set-Cookie')).toMatch(/^member_session=.+Max-Age=2592000/);
    // A month and a half after signing in, with the renewed cookie: still in.
    Date.now = () => realNow() + 45 * 86400 * 1000;
    expect((await call(cookieOf(mres), '/api/member/me')).status).toBe(200);
    expect((await call(dana.cookie, '/api/member/me')).status).toBe(401);
  });
});
