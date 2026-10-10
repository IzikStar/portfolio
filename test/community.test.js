import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { hashPassword, verifyPassword } from '../src/members.js';

const ORIGIN = 'https://site.test';
let env;

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async (r) => new Response(new URL(r.url).pathname === '/404.html' ? 'not found page' : 'asset') },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const post = (path, body, headers = {}) =>
  req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];

async function owner() {
  return cookieOf(await post('/api/admin/login', { password: env.ADMIN_PASSWORD }));
}
const studio = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

async function invite(cookie, opts = {}) {
  const res = await studio(cookie, '/api/studio/invites', 'POST', { maxUses: 1, days: 7, ...opts });
  expect(res.status).toBe(201);
  return (await res.json()).code;
}

describe('passwords', () => {
  it('hashes with a salt and verifies', async () => {
    const a = await hashPassword('hunter22');
    const b = await hashPassword('hunter22');
    expect(a).not.toBe(b);
    expect(await verifyPassword('hunter22', a)).toBe(true);
    expect(await verifyPassword('hunter23', a)).toBe(false);
  });
});

describe('joining', () => {
  it('lets an invited person in at once and uses up the invite', async () => {
    const o = await owner();
    const code = await invite(o);
    expect(await (await req(`/api/member/invite?code=${code}`)).json()).toEqual({ valid: true });

    const res = await post('/api/member/join', { code, username: 'dana', displayName: 'Dana', password: 'longenough' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'active' });
    const cookie = cookieOf(res);
    expect(res.headers.get('Set-Cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(await (await req('/api/member/me', { headers: { Cookie: cookie } })).json()).toMatchObject({ username: 'dana', displayName: 'Dana' });

    expect(await (await req(`/api/member/invite?code=${code}`)).json()).toEqual({ valid: false });
    expect((await post('/api/member/join', { code, username: 'eli', password: 'longenough' })).status).toBe(400);
  });

  it('refuses expired invites', async () => {
    const o = await owner();
    const code = await invite(o);
    await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE code = ?').bind('2000-01-01T00:00:00.000Z', code).run();
    expect((await post('/api/member/join', { code, username: 'late', password: 'longenough' })).status).toBe(400);
  });

  it('queues a request without an invite until the owner approves it', async () => {
    const res = await post('/api/member/join', { username: 'guest', password: 'longenough', note: 'We met at the meetup' });
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(res.headers.get('Set-Cookie')).toBeNull();

    const login = () => post('/api/member/login', { username: 'guest', password: 'longenough' });
    expect((await login()).status).toBe(403);

    const o = await owner();
    const { users } = await (await studio(o, '/api/studio/community')).json();
    expect(users[0]).toMatchObject({ username: 'guest', status: 'pending', note: 'We met at the meetup' });
    await studio(o, `/api/studio/members/${users[0].id}`, 'PATCH', { status: 'active' });

    const ok = await login();
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toMatch(/^member_session=/);
  });

  it('validates usernames and passwords and keeps usernames unique, ignoring case', async () => {
    expect((await post('/api/member/join', { username: 'ab', password: 'longenough' })).status).toBe(400);
    expect((await post('/api/member/join', { username: 'has space', password: 'longenough' })).status).toBe(400);
    expect((await post('/api/member/join', { username: 'okname', password: 'short' })).status).toBe(400);
    expect((await post('/api/member/join', { username: 'שם_עברי', password: 'longenough' })).status).toBe(201);
    expect((await post('/api/member/join', { username: 'Taken', password: 'longenough' })).status).toBe(201);
    expect((await post('/api/member/join', { username: 'taken', password: 'otherpassword' })).status).toBe(409);
  });

  it('drops bot sign-ups that fill the hidden field', async () => {
    expect((await post('/api/member/join', { username: 'botty', password: 'longenough', website: 'http://spam' })).status).toBe(400);
  });

  it('blocks cross-site sign-ins', async () => {
    expect((await post('/api/member/login', { username: 'x', password: 'y' }, { Origin: 'https://evil.test' })).status).toBe(403);
  });

  it('keeps the studio community routes owner-only', async () => {
    expect((await req('/api/studio/community')).status).toBe(401);
    const o = await owner();
    const code = await invite(o);
    const member = cookieOf(await post('/api/member/join', { code, username: 'dana', password: 'longenough' }));
    expect((await req('/api/studio/community', { headers: { Cookie: member } })).status).toBe(401);
  });
});

describe('what members see', () => {
  async function setup() {
    const o = await owner();
    for (const [title, visibility] of [['Open post', 'public'], ['Inner circle', 'members'], ['Just mine', 'private']]) {
      await studio(o, '/api/studio/entries', 'POST', { kind: 'article', title, visibility, status: 'published' });
    }
    const code = await invite(o);
    const res = await post('/api/member/join', { code, username: 'dana', displayName: 'Dana', password: 'longenough' });
    return { o, member: cookieOf(res) };
  }

  it('shows members the community articles but never private ones', async () => {
    const { member } = await setup();
    const list = await (await req('/api/entries?kind=article', { headers: { Cookie: member } })).json();
    expect(list.entries.map((e) => e.title).sort()).toEqual(['Inner circle', 'Open post']);
    expect((await req('/articles/inner-circle', { headers: { Cookie: member } })).status).toBe(200);
    expect((await req('/articles/just-mine', { headers: { Cookie: member } })).status).toBe(404);
    expect((await req('/articles/inner-circle')).status).toBe(404);

    const page = await (await req('/community', { headers: { Cookie: member } })).text();
    expect(page).toContain('Inner circle');
    expect(page).toContain('Dana');
    expect(page).not.toContain('Just mine');
  });

  it('shows the public an invitation instead of the feed', async () => {
    await setup();
    const page = await (await req('/community')).text();
    expect(page).toContain('/join');
    expect(page).not.toContain('Inner circle');
  });

  it('cuts off a suspended member on the next request', async () => {
    const { o, member } = await setup();
    const { users } = await (await studio(o, '/api/studio/community')).json();
    await studio(o, `/api/studio/members/${users[0].id}`, 'PATCH', { status: 'suspended' });
    expect((await req('/articles/inner-circle', { headers: { Cookie: member } })).status).toBe(404);
    expect((await req('/api/member/me', { headers: { Cookie: member } })).status).toBe(401);
    expect((await post('/api/member/login', { username: 'dana', password: 'longenough' })).status).toBe(403);
  });

  it('rejects a tampered member cookie', async () => {
    const { member } = await setup();
    const [name, value] = member.split('=');
    const [id, expires, sig] = value.split('.');
    const forged = `${name}=${id}.${Number(expires) + 1000}.${sig}`;
    expect((await req('/api/member/me', { headers: { Cookie: forged } })).status).toBe(401);
  });

  it('lets the owner revoke an invite', async () => {
    const o = await owner();
    const code = await invite(o);
    expect((await studio(o, `/api/studio/invites/${code}`, 'DELETE')).status).toBe(200);
    expect(await (await req(`/api/member/invite?code=${code}`)).json()).toEqual({ valid: false });
  });
});
