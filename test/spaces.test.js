import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { db } from '../src/db.js';

const ORIGIN = 'https://site.test';
let env;

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async () => new Response('asset') },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

async function owner() {
  return cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));
}

async function member(o, username) {
  const { code } = await (await call(o, '/api/studio/invites', 'POST', {})).json();
  const res = await call(null, '/api/member/join', 'POST', { code, username, password: 'longenough' });
  expect(res.status).toBe(201);
  return { cookie: cookieOf(res), id: (await (await call(cookieOf(res), '/api/member/me')).json()).id };
}

async function space(o, body) {
  const res = await call(o, '/api/studio/spaces', 'POST', body);
  expect(res.status).toBe(201);
  return res.json();
}

async function community(o, body) {
  const res = await call(o, '/api/studio/communities', 'POST', body);
  expect(res.status).toBe(201);
  return res.json();
}

const approve = (o, c, userId) => call(o, `/api/studio/communities/${c.id}/members`, 'PATCH', { userId, status: 'active' });

async function entry(o, body) {
  const res = await call(o, '/api/studio/entries', 'POST', { status: 'published', ...body });
  expect(res.status).toBe(201);
  return res.json();
}

const titles = async (cookie, kind) => (await (await call(cookie, `/api/entries?kind=${kind}`)).json()).entries.map((e) => e.title);

describe('wings', () => {
  it('exist from the start, one per kind of work', async () => {
    const { spaces } = await (await req('/api/spaces')).json();
    expect(spaces.map((s) => s.id)).toEqual(['music', 'books', 'sketches', 'humor', 'torah', 'articles', 'software', 'videos']);
    expect(spaces.every((s) => s.kind === 'wing')).toBe(true);
  });

  it('put new items in the wing for their kind unless told otherwise', async () => {
    const o = await owner();
    expect((await entry(o, { kind: 'song', title: 'Song' })).spaceId).toBe('music');
    expect((await entry(o, { kind: 'article', title: 'Essay' })).spaceId).toBe('articles');
    expect((await entry(o, { kind: 'idea', body: 'x', status: 'draft' })).spaceId).toBe(null);
    const res = await call(o, '/api/studio/entries', 'POST', { kind: 'song', title: 'Lost', spaceId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('cannot be deleted', async () => {
    const o = await owner();
    expect((await call(o, '/api/studio/spaces/music', 'DELETE')).status).toBe(400);
  });
});

describe('community access', () => {
  it('opens an item only to the communities it lists, whatever its wing', async () => {
    const o = await owner();
    const nonsense = await community(o, { title: 'Nonsense humor' });
    const beta = await community(o, { title: 'Beta readers' });
    await entry(o, { kind: 'song', title: 'Open song', visibility: 'public' });
    await entry(o, { kind: 'song', title: 'Silly song', visibility: 'community', communities: [nonsense.id] });
    await entry(o, { kind: 'sketch', title: 'Silly sketch', visibility: 'community', communities: [nonsense.id, beta.id] });
    await entry(o, { kind: 'song', title: 'For members', visibility: 'members' });
    await entry(o, { kind: 'song', title: 'Nobody yet', visibility: 'community' });
    const dana = await member(o, 'dana');

    expect(await titles(null, 'song')).toEqual(['Open song']);
    expect((await titles(dana.cookie, 'song')).sort()).toEqual(['For members', 'Open song']);

    const asked = await call(dana.cookie, `/api/member/communities/${nonsense.id}/join`, 'POST', { note: 'I laugh a lot' });
    expect(await asked.json()).toEqual({ status: 'pending', communityId: nonsense.id });
    expect((await titles(dana.cookie, 'song')).sort()).toEqual(['For members', 'Open song']);

    const { members } = await (await call(o, `/api/studio/communities/${nonsense.id}/members`)).json();
    expect(members).toMatchObject([{ username: 'dana', status: 'pending', note: 'I laugh a lot' }]);
    await approve(o, nonsense, dana.id);
    expect((await titles(dana.cookie, 'song')).sort()).toEqual(['For members', 'Open song', 'Silly song']);
    expect(await titles(dana.cookie, 'sketch')).toEqual(['Silly sketch']);

    await call(o, `/api/studio/communities/${nonsense.id}/members`, 'PATCH', { userId: dana.id, status: 'removed' });
    expect(await titles(dana.cookie, 'song')).not.toContain('Silly song');
  });

  it('refuses communities that do not exist and drops a deleted one from every item', async () => {
    const o = await owner();
    const c = await community(o, { title: 'Short lived' });
    const bad = await call(o, '/api/studio/entries', 'POST', { kind: 'song', title: 'X', communities: 'nope' });
    expect(bad.status).toBe(400);
    const x = await entry(o, { kind: 'song', title: 'Kept', visibility: 'community', communities: [c.id, 'made-up'] });
    expect(x.communities).toEqual([c.id]);
    expect((await call(o, `/api/studio/communities/${c.id}`, 'DELETE')).status).toBe(200);
    const after = await (await call(o, `/api/studio/entries/${x.id}`)).json();
    expect(after.communities).toEqual([]);
  });

  it('opens a space to its communities, and new items in it start open to them too', async () => {
    const o = await owner();
    const beta = await community(o, { title: 'Gargamitz readers' });
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Gargamitz', visibility: 'community', communities: [beta.id] });
    expect(book).toMatchObject({ wing: 'books', slug: 'gargamitz', communities: [beta.id] });
    const ch = await entry(o, { kind: 'chapter', spaceId: book.id, title: 'Chapter 1', visibility: 'community' });
    expect(ch.communities).toEqual([beta.id]);

    const reader = await member(o, 'reader');
    expect(await titles(reader.cookie, 'chapter')).toEqual([]);
    await call(reader.cookie, `/api/member/communities/${beta.id}/join`, 'POST', {});
    await approve(o, beta, reader.id);
    expect(await titles(reader.cookie, 'chapter')).toEqual(['Chapter 1']);
  });

  it('hides everything inside a private space, even public items', async () => {
    const o = await owner();
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Secret book' });
    expect(book.visibility).toBe('private');
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'Leaked?', visibility: 'public' });
    expect(await titles(null, 'chapter')).toEqual([]);
    const { spaces } = await (await req('/api/spaces')).json();
    expect(spaces.map((s) => s.id)).not.toContain(book.id);
    expect((await call(o, '/api/spaces').then((r) => r.json())).spaces.map((s) => s.id)).toContain(book.id);
  });

  it('refuses requests to a closed community and to a hidden one', async () => {
    const o = await owner();
    const closed = await community(o, { title: 'Invite only', joinMode: 'closed' });
    const hidden = await community(o, { title: 'Secret club', hidden: true });
    const m = await member(o, 'closed');
    expect((await call(m.cookie, `/api/member/communities/${closed.id}/join`, 'POST', {})).status).toBe(403);
    expect((await call(m.cookie, `/api/member/communities/${hidden.id}/join`, 'POST', {})).status).toBe(404);
    expect((await req(`/api/member/communities/${closed.id}/join`, { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it('keeps a hidden community out of sight for outsiders, items and all', async () => {
    const o = await owner();
    const open = await community(o, { title: 'Open club', summary: 'Everyone may ask' });
    const hidden = await community(o, { title: 'Secret club', hidden: true });
    await entry(o, { kind: 'sketch', title: 'Locked but known', slug: 'known', visibility: 'community', communities: [open.id] });
    await entry(o, { kind: 'sketch', title: 'Never heard of it', slug: 'secret', visibility: 'community', communities: [hidden.id] });

    const { communities } = await (await req('/api/communities')).json();
    expect(communities.map((c) => c.title)).toEqual(['Open club']);
    const hub = await (await req('/community')).text();
    expect(hub).toContain('Open club');
    expect(hub).not.toContain('Secret club');
    expect((await req(`/community/${hidden.slug}`)).status).toBe(404);
    expect((await req(`/community/${open.slug}`)).status).toBe(200);

    const wing = await (await req('/sketches')).text();
    expect(wing).toContain('עוד פריט אחד פתוח');
    expect(wing).toContain('Open club');
    expect(wing).not.toContain('Secret club');

    // Its own members see it like any other community.
    const insider = await member(o, 'insider');
    await approve(o, hidden, insider.id);
    expect(await titles(insider.cookie, 'sketch')).toEqual(['Never heard of it']);
    expect((await call(insider.cookie, `/community/${hidden.slug}`)).status).toBe(200);
  });

  it('lets an invite put new members straight into communities', async () => {
    const o = await owner();
    const closed = await community(o, { title: 'Inner circle', joinMode: 'closed', hidden: true });
    await entry(o, { kind: 'song', title: 'Inner song', visibility: 'community', communities: [closed.id] });
    const { code, communities } = await (await call(o, '/api/studio/invites', 'POST', { communities: [closed.id] })).json();
    expect(communities).toEqual([closed.id]);
    const res = await call(null, '/api/member/join', 'POST', { code, username: 'friend', password: 'longenough' });
    expect(await titles(res.headers.get('Set-Cookie').split(';')[0], 'song')).toEqual(['Inner song']);
  });
});

describe('signing up from a community', () => {
  it('asks for the community, and approving it lets the person in', async () => {
    const o = await owner();
    const beta = await community(o, { title: 'Beta book readers' });
    const res = await call(null, '/api/member/join', 'POST', { username: 'reader', password: 'longenough', communityId: beta.id, note: 'love it' });
    expect(await res.json()).toEqual({ status: 'pending' });

    const { members } = await (await call(o, `/api/studio/communities/${beta.id}/members`)).json();
    expect(members).toMatchObject([{ username: 'reader', status: 'pending', accountPending: true, note: 'love it' }]);
    await approve(o, beta, members[0].userId);

    const login = await call(null, '/api/member/login', 'POST', { username: 'reader', password: 'longenough' });
    expect(login.status).toBe(200);
  });
});

describe('one account, many communities', () => {
  it('asks for several communities in one sign-up', async () => {
    const o = await owner();
    const a = await community(o, { title: 'Alpha' });
    const b = await community(o, { title: 'Beta' });
    const closed = await community(o, { title: 'Closed', joinMode: 'closed' });
    const hidden = await community(o, { title: 'Hidden', hidden: true });
    const res = await call(null, '/api/member/join', 'POST', { username: 'sis', password: 'longenough', communities: [a.id, b.id, closed.id, hidden.id] });
    expect(await res.json()).toEqual({ status: 'pending' });
    const { users } = await (await call(o, '/api/studio/community')).json();
    expect(users[0].communities).toEqual({ [a.id]: 'pending', [b.id]: 'pending' });
  });

  it('adds a second request to the same account instead of a new one', async () => {
    const o = await owner();
    const a = await community(o, { title: 'Alpha' });
    const b = await community(o, { title: 'Beta' });
    await call(null, '/api/member/join', 'POST', { username: 'sis', password: 'longenough', communityId: a.id });
    const again = await call(null, '/api/member/join', 'POST', { username: 'SIS', password: 'longenough', communityId: b.id });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'pending', existing: true });
    const { users } = await (await call(o, '/api/studio/community')).json();
    expect(users).toHaveLength(1);
    expect(users[0].communities).toEqual({ [a.id]: 'pending', [b.id]: 'pending' });
    // Someone else's username with a wrong password is still refused.
    expect((await call(null, '/api/member/join', 'POST', { username: 'sis', password: 'wrongpassword', communityId: b.id })).status).toBe(409);
  });

  it('signs an active member in and adds the request when they sign up again', async () => {
    const o = await owner();
    const a = await community(o, { title: 'Alpha' });
    const m = await member(o, 'known');
    const res = await call(null, '/api/member/join', 'POST', { username: 'known', password: 'longenough', communities: [a.id] });
    expect(await res.json()).toEqual({ status: 'active', existing: true });
    expect(cookieOf(res)).toMatch(/^member_session=/);
    const { members } = await (await call(o, `/api/studio/communities/${a.id}/members`)).json();
    expect(members).toMatchObject([{ userId: m.id, status: 'pending' }]);
  });

  it('lets a signed-in member ask for several at once', async () => {
    const o = await owner();
    const a = await community(o, { title: 'Alpha' });
    const b = await community(o, { title: 'Beta' });
    const m = await member(o, 'many');
    await approve(o, a, m.id);
    const res = await call(m.cookie, '/api/member/communities/join', 'POST', { communities: [a.id, b.id], note: 'hi' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'pending', communities: [b.id] });
    expect((await call(m.cookie, '/api/member/communities/join', 'POST', { communities: [a.id] })).status).toBe(400);
    expect((await call(null, '/api/member/communities/join', 'POST', { communities: [b.id] })).status).toBe(401);
  });

  it('lets the owner put one person in several communities with one save', async () => {
    const o = await owner();
    const a = await community(o, { title: 'Alpha' });
    const b = await community(o, { title: 'Beta' });
    const c = await community(o, { title: 'Gamma' });
    await call(null, '/api/member/join', 'POST', { username: 'sis', password: 'longenough', communities: [a.id, c.id] });
    const { users } = await (await call(o, '/api/studio/community')).json();
    const id = users[0].id;

    // Approve Alpha, add Beta, leave Gamma unticked: the account opens too.
    const res = await call(o, `/api/studio/members/${id}/communities`, 'PUT', { communities: [a.id, b.id] });
    expect(res.status).toBe(200);
    let after = (await (await call(o, '/api/studio/community')).json()).users[0];
    expect(after).toMatchObject({ status: 'active', communities: { [a.id]: 'active', [b.id]: 'active' } });
    expect((await call(null, '/api/member/login', 'POST', { username: 'sis', password: 'longenough' })).status).toBe(200);

    await call(o, `/api/studio/members/${id}/communities`, 'PUT', { communities: [b.id] });
    after = (await (await call(o, '/api/studio/community')).json()).users[0];
    expect(after.communities).toEqual({ [b.id]: 'active' });

    expect((await call(o, '/api/studio/members/nobody/communities', 'PUT', { communities: [] })).status).toBe(404);
    expect((await call(null, `/api/studio/members/${id}/communities`, 'PUT', { communities: [] })).status).toBe(401);
  });
});

describe("the owner's own member account", () => {
  it('belongs to every community, old and new', async () => {
    const o = await owner();
    const a = await community(o, { title: 'Alpha', joinMode: 'closed' });
    const me = await member(o, 'itsme');
    const res = await call(o, '/api/studio/settings/owner-member', 'PUT', { userId: me.id });
    expect(res.status).toBe(200);
    const b = await community(o, { title: 'Beta', hidden: true });
    const { users } = await (await call(o, '/api/studio/community')).json();
    expect(users.find((u) => u.id === me.id)).toMatchObject({ isOwner: true, communities: { [a.id]: 'active', [b.id]: 'active' } });
    const { communities } = await (await call(me.cookie, '/api/communities')).json();
    expect(communities.map((c) => c.membership)).toEqual(['active', 'active']);
    expect((await call(o, '/api/studio/settings/owner-member', 'PUT', { userId: 'nobody' })).status).toBe(404);
    expect((await call(me.cookie, '/api/studio/settings/owner-member', 'PUT', { userId: me.id })).status).toBe(401);
  });
});

describe('studio spaces and communities', () => {
  it('counts items, and keeps full spaces from being deleted', async () => {
    const o = await owner();
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Counted' });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'One' });
    const { spaces } = await (await call(o, '/api/studio/spaces')).json();
    expect(spaces.find((s) => s.id === book.id)).toMatchObject({ entries: 1 });
    expect((await call(o, `/api/studio/spaces/${book.id}`, 'DELETE')).status).toBe(409);
    expect((await call(o, `/api/studio/spaces/${book.id}`, 'PATCH', { parentId: book.id })).status).toBe(400);
  });

  it('counts a community\'s members, requests and items, and keeps addresses unique', async () => {
    const o = await owner();
    const c = await community(o, { title: 'Counted club' });
    await entry(o, { kind: 'song', title: 'One', communities: [c.id] });
    const m = await member(o, 'counted');
    await call(m.cookie, `/api/member/communities/${c.id}/join`, 'POST', {});
    const { communities } = await (await call(o, '/api/studio/communities')).json();
    expect(communities.find((x) => x.id === c.id)).toMatchObject({ entries: 1, members: 0, requests: 1, path: '/community/counted-club' });
    expect((await call(o, '/api/studio/communities', 'POST', { title: 'Other', slug: 'counted-club' })).status).toBe(409);
  });

  it('is owner-only', async () => {
    expect((await req('/api/studio/spaces')).status).toBe(401);
    expect((await req('/api/studio/communities')).status).toBe(401);
  });
});

describe('migration', () => {
  it('adds the space column to an older database and files old items into wings', async () => {
    const old = new FakeD1();
    old.db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL, slug TEXT, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private', status TEXT NOT NULL DEFAULT 'draft', tags TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}', pinned INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'studio', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, published_at TEXT)`);
    old.db.exec(`INSERT INTO entries (id, kind, title, created_at, updated_at) VALUES ('a', 'article', 'A', 'x', 'x'), ('p', 'project', 'P', 'x', 'x'), ('i', 'idea', 'I', 'x', 'x')`);
    const d = await db({ DB: old });
    const { results } = await d.prepare('SELECT id, space_id FROM entries ORDER BY id').all();
    expect(results).toEqual([{ id: 'a', space_id: 'articles' }, { id: 'i', space_id: null }, { id: 'p', space_id: 'software' }]);
  });

  it('turns the old per-space communities into communities, members and all', async () => {
    const old = new FakeD1();
    const now = 'x';
    old.db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL, slug TEXT, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private', status TEXT NOT NULL DEFAULT 'draft', tags TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}', pinned INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'studio', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, published_at TEXT, space_id TEXT)`);
    old.db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, wing TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'collection',
      title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'public', join_mode TEXT NOT NULL DEFAULT 'request',
      own_community INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}', sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.db.exec(`CREATE TABLE space_members (space_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, decided_at TEXT, PRIMARY KEY (space_id, user_id))`);
    old.db.exec(`INSERT INTO spaces VALUES ('books', 'books', NULL, 'books', 'wing', 'ספרים', '', 'public', 'request', 1, '{}', 0, '${now}', '${now}'),
      ('series', 'books', 'books', 'garg', 'series', 'גרגמיץ', '', 'private', 'closed', 1, '{}', 0, '${now}', '${now}'),
      ('vol1', 'books', 'series', 'vol1', 'book', 'צביר 1', '', 'private', 'request', 0, '{}', 0, '${now}', '${now}')`);
    old.db.exec(`INSERT INTO space_members VALUES ('series', 'u1', 'active', '', '${now}', NULL), ('books', 'u2', 'active', '', '${now}', NULL)`);
    old.db.exec(`INSERT INTO entries (id, kind, title, visibility, space_id, created_at, updated_at) VALUES ('c1', 'chapter', 'C', 'community', 'vol1', 'x', 'x'), ('w', 'chapter', 'W', 'community', 'books', 'x', 'x')`);
    const d = await db({ DB: old });
    expect(await d.prepare('SELECT id, title, join_mode FROM communities').all()).toEqual({ results: [{ id: 'series', title: 'קוראי בטא: גרגמיץ', join_mode: 'closed' }] });
    expect((await d.prepare('SELECT community_id, user_id FROM community_members').all()).results).toEqual([{ community_id: 'series', user_id: 'u1' }]);
    expect((await d.prepare('SELECT id, communities FROM entries ORDER BY id').all()).results).toEqual([{ id: 'c1', communities: '["series"]' }, { id: 'w', communities: '[]' }]);
    expect((await d.prepare(`SELECT communities FROM spaces WHERE id = 'vol1'`).first()).communities).toBe('["series"]');
  });
});
