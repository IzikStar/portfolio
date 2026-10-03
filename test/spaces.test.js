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
    expect(spaces.every((s) => s.ownCommunity && s.membership === null)).toBe(true);
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
  it('opens community items only to that community', async () => {
    const o = await owner();
    await entry(o, { kind: 'song', title: 'Open song', visibility: 'public' });
    await entry(o, { kind: 'song', title: 'Raw demo', visibility: 'community' });
    await entry(o, { kind: 'song', title: 'For members', visibility: 'members' });
    const dana = await member(o, 'dana');

    expect(await titles(null, 'song')).toEqual(['Open song']);
    expect((await titles(dana.cookie, 'song')).sort()).toEqual(['For members', 'Open song']);

    const asked = await call(dana.cookie, '/api/member/spaces/music/join', 'POST', { note: 'I play too' });
    expect(await asked.json()).toEqual({ status: 'pending', spaceId: 'music' });
    expect((await titles(dana.cookie, 'song')).sort()).toEqual(['For members', 'Open song']);

    const { members } = await (await call(o, '/api/studio/spaces/music/members')).json();
    expect(members).toMatchObject([{ username: 'dana', status: 'pending', note: 'I play too' }]);
    await call(o, '/api/studio/spaces/music/members', 'PATCH', { userId: dana.id, status: 'active' });
    expect((await titles(dana.cookie, 'song')).sort()).toEqual(['For members', 'Open song', 'Raw demo']);

    await call(o, '/api/studio/spaces/music/members', 'PATCH', { userId: dana.id, status: 'removed' });
    expect(await titles(dana.cookie, 'song')).not.toContain('Raw demo');
  });

  it('gives a book its own beta readers, apart from the books wing', async () => {
    const o = await owner();
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Gargamitz', visibility: 'public' });
    expect(book).toMatchObject({ wing: 'books', ownCommunity: true, slug: 'gargamitz' });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'Chapter 1', visibility: 'public' });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'Chapter 2', visibility: 'community' });

    const wingReader = await member(o, 'wing');
    await call(wingReader.cookie, '/api/member/spaces/books/join', 'POST', {});
    await call(o, '/api/studio/spaces/books/members', 'PATCH', { userId: wingReader.id, status: 'active' });
    expect(await titles(wingReader.cookie, 'chapter')).toEqual(['Chapter 1']);

    const beta = await member(o, 'beta');
    const asked = await (await call(beta.cookie, `/api/member/spaces/${book.id}/join`, 'POST', {})).json();
    expect(asked.spaceId).toBe(book.id);
    await call(o, `/api/studio/spaces/${book.id}/members`, 'PATCH', { userId: beta.id, status: 'active' });
    expect((await titles(beta.cookie, 'chapter')).sort()).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('lets a series share the community of its genre', async () => {
    const o = await owner();
    const genre = await space(o, { parentId: 'sketches', kind: 'genre', title: 'Parody', visibility: 'public', ownCommunity: true });
    const series = await space(o, { parentId: genre.id, kind: 'series', title: 'Office', visibility: 'public' });
    expect(series.ownCommunity).toBe(false);
    await entry(o, { kind: 'sketch', spaceId: series.id, title: 'Episode 1', visibility: 'community' });

    const fan = await member(o, 'fan');
    const asked = await (await call(fan.cookie, `/api/member/spaces/${series.id}/join`, 'POST', {})).json();
    expect(asked.spaceId).toBe(genre.id);
    await call(o, `/api/studio/spaces/${genre.id}/members`, 'PATCH', { userId: fan.id, status: 'active' });
    expect(await titles(fan.cookie, 'sketch')).toEqual(['Episode 1']);
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
    expect((await req(`/api/member/spaces/${book.id}/join`, { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it('refuses requests to a closed community', async () => {
    const o = await owner();
    await call(o, '/api/studio/spaces/torah', 'PATCH', { joinMode: 'closed' });
    const m = await member(o, 'closed');
    expect((await call(m.cookie, '/api/member/spaces/torah/join', 'POST', {})).status).toBe(403);
  });
});

describe('signing up from a space', () => {
  it('asks for the community, and approving it lets the person in', async () => {
    const o = await owner();
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Beta book', visibility: 'public' });
    const res = await call(null, '/api/member/join', 'POST', { username: 'reader', password: 'longenough', spaceId: book.id, note: 'love it' });
    expect(await res.json()).toEqual({ status: 'pending' });

    const { members } = await (await call(o, `/api/studio/spaces/${book.id}/members`)).json();
    expect(members).toMatchObject([{ username: 'reader', status: 'pending', accountPending: true, note: 'love it' }]);
    await call(o, `/api/studio/spaces/${book.id}/members`, 'PATCH', { userId: members[0].userId, status: 'active' });

    const login = await call(null, '/api/member/login', 'POST', { username: 'reader', password: 'longenough' });
    expect(login.status).toBe(200);
  });
});

describe('studio spaces', () => {
  it('counts items, members and requests, and keeps full spaces from being deleted', async () => {
    const o = await owner();
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Counted' });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'One' });
    const { spaces } = await (await call(o, '/api/studio/spaces')).json();
    expect(spaces.find((s) => s.id === book.id)).toMatchObject({ entries: 1, members: 0, requests: 0 });
    expect((await call(o, `/api/studio/spaces/${book.id}`, 'DELETE')).status).toBe(409);
    expect((await call(o, `/api/studio/spaces/${book.id}`, 'PATCH', { parentId: book.id })).status).toBe(400);
  });

  it('is owner-only', async () => {
    expect((await req('/api/studio/spaces')).status).toBe(401);
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
});
