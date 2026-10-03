import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';



const ORIGIN = 'https://site.test';
let env;

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`, { status: new URL(r.url).pathname === '/404.html' ? 200 : 200 }) },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));
const page = async (path, cookie) => {
  const res = await call(cookie, path);
  return { status: res.status, text: await res.text(), res };
};
async function entry(o, body) {
  const res = await call(o, '/api/studio/entries', 'POST', { status: 'published', visibility: 'public', ...body });
  expect(res.status).toBe(201);
  return res.json();
}
async function space(o, body) {
  const res = await call(o, '/api/studio/spaces', 'POST', body);
  expect(res.status).toBe(201);
  return res.json();
}
async function member(o, username) {
  const { code } = await (await call(o, '/api/studio/invites', 'POST', {})).json();
  const res = await call(null, '/api/member/join', 'POST', { code, username, password: 'longenough' });
  const cookie = cookieOf(res);
  return { cookie, id: (await (await call(cookie, '/api/member/me')).json()).id };
}

async function book(o) {
  const b = await space(o, { parentId: 'books', kind: 'book', title: 'Gargamitz', visibility: 'public' });
  const ch = await entry(o, { kind: 'chapter', spaceId: b.id, title: 'One', body: 'First paragraph\n\nSecond paragraph', meta: { order: 1 } });
  return { b, ch };
}
async function reader(o, b, name = 'reader') {
  const m = await member(o, name);
  await call(o, `/api/studio/spaces/${b.id}/members`, 'PATCH', { userId: m.id, status: 'active' });
  return m;
}

describe('comments', () => {
  it('are open to the community and the owner only', async () => {
    const o = await owner();
    const { b, ch } = await book(o);
    const outsider = await member(o, 'outsider');
    const r = await reader(o, b);

    const anon = await page('/books/gargamitz/one');
    expect(anon.text).toContain(`/join?space=${b.id}`);
    expect(anon.text).not.toContain('data-comment-form');
    expect((await page('/books/gargamitz/one', outsider.cookie)).text).toContain(`data-join="${b.id}"`);
    expect((await call(outsider.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'hi' })).status).toBe(403);
    expect((await call(null, '/api/comments', 'POST', { entryId: ch.id, body: 'hi' })).status).toBe(401);

    const res = await call(r.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'Loved <this>', anchor: 1, quote: 'Second paragraph' });
    expect(res.status).toBe(201);
    const c = await res.json();
    expect(c.author).toBe('reader');

    const seen = await page('/books/gargamitz/one', r.cookie);
    expect(seen.text).toContain('data-comment-form');
    expect(seen.text).toContain('data-anchors');
    expect(seen.text).toContain('Loved &lt;this&gt;');
    expect(seen.text).toContain('data-anchor="1"');
    expect(seen.text).toContain('href="#p-1"');
    expect((await page('/books/gargamitz/one', outsider.cookie)).text).not.toContain('Loved');
    expect(anon.text).not.toContain('Loved');
    expect((await page('/books/gargamitz/one', o)).text).toContain('Loved');
  });

  it('keep replies one level deep and let the owner answer and close them', async () => {
    const o = await owner();
    const { b, ch } = await book(o);
    const r = await reader(o, b);
    const first = await (await call(r.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'Question' })).json();
    const answer = await (await call(o, '/api/comments', 'POST', { entryId: ch.id, body: 'Answer', replyTo: first.id, anchor: 0 })).json();
    expect(answer.author).toBe('יצחק');
    expect(answer.replyTo).toBe(first.id);
    expect(answer.anchor).toBe(null);
    const deeper = await (await call(r.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'Thanks', replyTo: answer.id })).json();
    expect(deeper.replyTo).toBe(first.id);

    let inbox = await (await call(o, '/api/studio/comments?status=open')).json();
    expect(inbox.open).toBe(2); // the owner's own answer is not counted
    expect(inbox.comments[0].entry.path).toBe('/books/gargamitz/one');
    expect(inbox.comments.map((c) => c.body)).toEqual(['Thanks', 'Question']);
    expect((await call(o, `/api/studio/comments/${first.id}`, 'PATCH', { status: 'resolved' })).status).toBe(200);
    inbox = await (await call(o, '/api/studio/comments?status=open')).json();
    expect(inbox.open).toBe(1);
    expect((await call(r.cookie, `/api/studio/comments/${first.id}`, 'PATCH', { status: 'open' })).status).toBe(401);
  });

  it('can be deleted by their writer or the owner, and go with their item', async () => {
    const o = await owner();
    const { b, ch } = await book(o);
    const r = await reader(o, b);
    const other = await reader(o, b, 'other');
    const c = await (await call(r.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'Mine' })).json();
    await call(other.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'Reply', replyTo: c.id });
    expect((await call(other.cookie, `/api/comments/${c.id}`, 'DELETE')).status).toBe(403);
    expect((await call(r.cookie, `/api/comments/${c.id}`, 'DELETE')).status).toBe(200);
    expect((await (await call(o, '/api/studio/comments')).json()).comments).toHaveLength(0);

    await call(r.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'Again' });
    await call(o, `/api/studio/entries/${ch.id}`, 'DELETE');
    expect((await (await call(o, '/api/studio/comments')).json()).comments).toHaveLength(0);
  });

  it('can be switched off per item and never reach hidden items', async () => {
    const o = await owner();
    const { b, ch } = await book(o);
    const r = await reader(o, b);
    await call(o, `/api/studio/entries/${ch.id}`, 'PATCH', { meta: { order: 1, comments: false } });
    expect((await call(r.cookie, '/api/comments', 'POST', { entryId: ch.id, body: 'x' })).status).toBe(403);
    expect((await page('/books/gargamitz/one', r.cookie)).text).not.toContain('class="comments');

    const draft = await entry(o, { kind: 'chapter', spaceId: b.id, title: 'Draft', status: 'draft' });
    expect((await call(r.cookie, '/api/comments', 'POST', { entryId: draft.id, body: 'x' })).status).toBe(404);
    const two = await entry(o, { kind: 'chapter', spaceId: b.id, title: 'Two' });
    expect((await call(r.cookie, '/api/comments', 'POST', { entryId: two.id, body: '   ' })).status).toBe(400);
  });
});
