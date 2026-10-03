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
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`) },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));
const page = async (path, cookie) => {
  const res = await call(cookie, path);
  return { status: res.status, text: await res.text() };
};
async function member(o, username, displayName = username) {
  const { code } = await (await call(o, '/api/studio/invites', 'POST', {})).json();
  const res = await call(null, '/api/member/join', 'POST', { code, username, displayName, password: 'longenough' });
  const cookie = cookieOf(res);
  return { cookie, id: (await (await call(cookie, '/api/member/me')).json()).id };
}
async function joinTo(o, spaceId, name, displayName) {
  const m = await member(o, name, displayName);
  await call(o, `/api/studio/spaces/${spaceId}/members`, 'PATCH', { userId: m.id, status: 'active' });
  return m;
}
async function write(cookie, spaceId, body) {
  const res = await call(cookie, `/api/blog/${spaceId}/posts`, 'POST', { title: 'Hello', body: 'Some *words*', ...body });
  return { status: res.status, post: res.status === 201 ? await res.json() : await res.json().catch(() => null) };
}

describe('community blog', () => {
  it('is read and written by the community only; the owner sees everything', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'music', 'dana', 'Dana');
    const reader = await joinTo(o, 'books', 'reader', 'Reader'); // another community
    const outsider = await member(o, 'outsider');

    const { status, post } = await write(dana.cookie, 'music', { title: 'First jam', body: 'We played **loud**' });
    expect(status).toBe(201);
    expect(post.path).toBe('/music/blog/first-jam');

    // Writing: only members of this community.
    expect((await write(null, 'music')).status).toBe(401);
    expect((await write(outsider.cookie, 'music')).status).toBe(403);
    expect((await write(reader.cookie, 'music')).status).toBe(403);
    expect((await write(dana.cookie, 'nope')).status).toBe(404);

    // Reading: the community and the owner.
    const mine = await page('/music/blog/first-jam', dana.cookie);
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('<strong>loud</strong>');
    expect(mine.text).toContain('data-comment-form');
    expect((await page('/music/blog', dana.cookie)).text).toContain('First jam');
    for (const who of [null, outsider.cookie, reader.cookie]) {
      expect((await page('/music/blog/first-jam', who)).status).toBe(404);
      const list = await page('/music/blog', who);
      expect(list.status).toBe(200);
      expect(list.text).not.toContain('First jam');
      expect(list.text).not.toContain('data-post-form');
    }
    const asOwner = await page('/music/blog/first-jam', o);
    expect(asOwner.status).toBe(200);
    expect(asOwner.text).toContain('data-post-mod="pinned"');

    // Comments on the post: same rule.
    expect((await call(reader.cookie, '/api/comments', 'POST', { postId: post.id, body: 'hi' })).status).toBe(404);
    expect((await call(null, '/api/comments', 'POST', { postId: post.id, body: 'hi' })).status).toBe(401);
    expect((await call(dana.cookie, '/api/comments', 'POST', { postId: post.id, body: 'Me again' })).status).toBe(201);
    expect((await page('/music/blog/first-jam', dana.cookie)).text).toContain('Me again');
    const inbox = await (await call(o, '/api/studio/comments')).json();
    expect(inbox.comments[0].entry).toMatchObject({ kind: 'post', title: 'First jam', path: '/music/blog/first-jam' });
  });

  it('lets the owner pin, hide, open to everyone and delete any post', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'music', 'dana');
    const eli = await joinTo(o, 'music', 'eli');
    const { post } = await write(dana.cookie, 'music', { title: 'Open letter' });

    // Moderation is the owner's alone.
    expect((await call(dana.cookie, `/api/studio/posts/${post.id}`, 'PATCH', { public: true })).status).toBe(401);
    expect((await call(o, `/api/studio/posts/${post.id}`, 'PATCH', { public: true, pinned: true })).status).toBe(200);
    const anon = await page('/music/blog/open-letter');
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain('data-comment-form'); // outsiders read, the community talks
    expect((await page('/music/blog')).text).toContain('Open letter');
    expect((await page('/music')).text).toContain('href="/music/blog"');

    await call(o, `/api/studio/posts/${post.id}`, 'PATCH', { hidden: true });
    expect((await page('/music/blog/open-letter')).status).toBe(404);
    expect((await page('/music/blog/open-letter', eli.cookie)).status).toBe(404);
    expect((await page('/music/blog/open-letter', dana.cookie)).text).toContain('מוסתר'); // the writer still sees it
    expect((await page('/music/blog/open-letter', o)).status).toBe(200);
    const studio = await (await call(o, '/api/studio/posts?status=hidden')).json();
    expect(studio.posts.map((p) => p.title)).toEqual(['Open letter']);

    // Another member may not edit or delete it; the writer may edit, the owner may delete.
    await call(o, `/api/studio/posts/${post.id}`, 'PATCH', { hidden: false });
    expect((await call(eli.cookie, `/api/blog/posts/${post.id}`, 'PATCH', { title: 'Mine now', body: 'x' })).status).toBe(403);
    expect((await call(eli.cookie, `/api/blog/posts/${post.id}`, 'DELETE')).status).toBe(403);
    expect((await call(dana.cookie, `/api/blog/posts/${post.id}`, 'PATCH', { title: 'Open letter, again', body: 'Edited' })).status).toBe(200);
    expect((await page('/music/blog/open-letter', eli.cookie)).text).toContain('Edited');
    await call(eli.cookie, '/api/comments', 'POST', { postId: post.id, body: 'Nice' });
    expect((await call(o, `/api/blog/posts/${post.id}`, 'DELETE')).status).toBe(200);
    expect((await page('/music/blog/open-letter', o)).status).toBe(404);
    expect((await (await call(o, '/api/studio/comments')).json()).comments).toHaveLength(0);

    // The owner writes too.
    const own = await write(o, 'music', { title: 'From me' });
    expect(own.status).toBe(201);
    expect((await page('/music/blog/from-me', eli.cookie)).text).toContain('<span class="mention" dir="auto">יצחק</span>');
  });

  it('gives a space with its own community a blog of its own', async () => {
    const o = await owner();
    const book = await (await call(o, '/api/studio/spaces', 'POST', { parentId: 'books', kind: 'book', title: 'Gargamitz', visibility: 'public' })).json();
    const genre = await (await call(o, '/api/studio/spaces', 'POST', { parentId: 'books', kind: 'genre', title: 'Fantasy', visibility: 'public' })).json();
    const beta = await joinTo(o, book.id, 'beta');
    const wingOnly = await joinTo(o, 'books', 'wingonly');

    const { status, post } = await write(beta.cookie, book.id, { title: 'Chapter thoughts' });
    expect(status).toBe(201);
    expect(post.path).toBe('/books/gargamitz/blog/chapter-thoughts');
    expect((await page(post.path, beta.cookie)).status).toBe(200);
    expect((await page(post.path, wingOnly.cookie)).status).toBe(404);
    expect((await write(wingOnly.cookie, book.id)).status).toBe(403);
    expect((await page('/books/gargamitz', beta.cookie)).text).toContain('href="/books/gargamitz/blog"');
    // A space without its own community has no blog; its people use the wing's.
    expect((await page('/books/fantasy/blog', wingOnly.cookie)).status).toBe(404);
    expect((await write(wingOnly.cookie, genre.id)).status).toBe(404);
  });

  it('keeps "blog" free in every wing and space', async () => {
    const o = await owner();
    expect((await call(o, '/api/studio/spaces', 'POST', { parentId: 'music', title: 'x', slug: 'blog' })).status).toBe(400);
    const s = await (await call(o, '/api/studio/spaces', 'POST', { parentId: 'music', title: 'Blog' })).json();
    expect(s.slug).toBe('blog-2');
    expect((await call(o, '/api/studio/entries', 'POST', { kind: 'song', title: 'x', slug: 'blog' })).status).toBe(400);
    const e = await (await call(o, '/api/studio/entries', 'POST', { kind: 'song', title: 'Blog', status: 'published' })).json();
    expect(e.slug).toBe('blog-2');
  });

  it('limits how many posts a member writes in an hour', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'music', 'dana');
    for (let i = 0; i < 6; i++) expect((await write(dana.cookie, 'music', { title: `Post ${i}` })).status).toBe(201);
    expect((await write(dana.cookie, 'music', { title: 'One more' })).status).toBe(429);
    expect((await write(o, 'music', { title: 'Owner is not limited' })).status).toBe(201);
  });
});

describe('tagging members', () => {
  it('only resolves to members of the same community', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'music', 'dana', 'Dana');
    const yossi = await joinTo(o, 'music', 'yossi', 'Yossi');
    const reader = await joinTo(o, 'books', 'reader', 'Reader');

    // Who can be picked: the community only, and only by the community.
    const found = await (await call(dana.cookie, '/api/people?space=music&q=')).json();
    expect(found.people.map((p) => p.name)).toEqual(['Yossi']);
    expect((await call(reader.cookie, '/api/people?space=music&q=')).status).toBe(403);
    expect((await call(null, '/api/people?space=music&q=')).status).toBe(401);
    expect((await (await call(o, '/api/people?space=music&q=da')).json()).people.map((p) => p.name)).toEqual(['Dana']);

    const song = await (await call(o, '/api/studio/entries', 'POST', { kind: 'song', title: 'Tune', visibility: 'community', status: 'published', spaceId: 'music' })).json();
    const res = await call(dana.cookie, '/api/comments', 'POST', { entryId: song.id, body: `Ask @{${yossi.id}} and @{${reader.id}}` });
    expect(res.status).toBe(201);
    const c = await res.json();
    expect(c.body).toBe(`Ask @{${yossi.id}} and `);

    const seen = await page('/music/tune', yossi.cookie);
    expect(seen.text).toContain('<span class="mention" dir="auto">@Yossi</span>');
    expect(seen.text).not.toContain('Reader');

    // The tagged member sees it on their page; the outsider sees nothing.
    const yp = await page('/community', yossi.cookie);
    expect(yp.text).toContain('תייגו אותך');
    expect(yp.text).toContain(`/music/tune#c-${c.id}`);
    expect((await page('/community', reader.cookie)).text).not.toContain('/music/tune');

    // Names follow renames.
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('Yossi K', yossi.id).run();
    expect((await page('/music/tune', dana.cookie)).text).toContain('@Yossi K');

    // In a post too.
    const { post } = await write(dana.cookie, 'music', { title: 'Thanks', body: `Thanks @{${yossi.id}}! And @{${reader.id}}` });
    expect(post.body).toBe(`Thanks @{${yossi.id}}! And `);
    expect((await page(post.path, yossi.cookie)).text).toContain('<span class="mention" dir="auto">@Yossi K</span>');
    expect((await page('/community', yossi.cookie)).text).toContain(post.path);

    // Losing access to the post takes it off the list.
    await call(o, `/api/studio/spaces/music/members`, 'PATCH', { userId: yossi.id, status: 'removed' });
    expect((await page('/community', yossi.cookie)).text).not.toContain(post.path);
  });

  it('lets the owner credit members on an item', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'music', 'dana', 'Dana');
    const song = await (
      await call(o, '/api/studio/entries', 'POST', {
        kind: 'song',
        title: 'Credited',
        status: 'published',
        visibility: 'public',
        spaceId: 'music',
        meta: { credits: [{ role: 'שירה', userId: dana.id }, { role: 'x', userId: 'not-a-user' }] },
      })
    ).json();
    expect(song.meta.credits).toEqual([{ role: 'שירה', userId: dana.id }]);
    expect((await page('/music/credited')).text).toContain('שירה: <span class="mention" dir="auto">Dana</span>');
    const mine = await page('/community', dana.cookie);
    expect(mine.text).toContain('הקרדיטים שלך');
    expect(mine.text).toContain('href="/music/credited"');
  });
});
