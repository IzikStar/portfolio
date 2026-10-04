import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';

const ORIGIN = 'https://site.test';
let env;

beforeEach(() => {
  for (const k of Object.keys(clubs)) delete clubs[k];
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
const clubs = {};
async function club(o, title, more = {}) {
  clubs[title] ??= await (await call(o, '/api/studio/communities', 'POST', { title, ...more })).json();
  return clubs[title];
}
async function joinTo(o, title, name, displayName) {
  const m = await member(o, name, displayName);
  await call(o, `/api/studio/communities/${(await club(o, title)).id}/members`, 'PATCH', { userId: m.id, status: 'active' });
  return m;
}
async function write(cookie, title, body) {
  const id = clubs[title]?.id ?? title;
  const res = await call(cookie, `/api/blog/${id}/posts`, 'POST', { title: 'Hello', body: 'Some *words*', ...body });
  return { status: res.status, post: res.status === 201 ? await res.json() : await res.json().catch(() => null) };
}

describe('community blog', () => {
  it('is read and written by the community only; the owner sees everything', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'Musicians', 'dana', 'Dana');
    const reader = await joinTo(o, 'Readers', 'reader', 'Reader'); // another community
    const outsider = await member(o, 'outsider');

    const { status, post } = await write(dana.cookie, 'Musicians', { title: 'First jam', body: 'We played **loud**' });
    expect(status).toBe(201);
    expect(post.path).toBe('/community/musicians/first-jam');

    // Writing: only members of this community.
    expect((await write(null, 'Musicians')).status).toBe(401);
    expect((await write(outsider.cookie, 'Musicians')).status).toBe(403);
    expect((await write(reader.cookie, 'Musicians')).status).toBe(403);
    expect((await write(dana.cookie, 'nope')).status).toBe(404);

    // Reading: the community and the owner.
    const mine = await page('/community/musicians/first-jam', dana.cookie);
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('<strong>loud</strong>');
    expect(mine.text).toContain('data-comment-form');
    expect((await page('/community/musicians', dana.cookie)).text).toContain('First jam');
    for (const who of [null, outsider.cookie, reader.cookie]) {
      expect((await page('/community/musicians/first-jam', who)).status).toBe(404);
      const list = await page('/community/musicians', who);
      expect(list.status).toBe(200);
      expect(list.text).not.toContain('First jam');
      expect(list.text).not.toContain('data-post-form');
    }
    const asOwner = await page('/community/musicians/first-jam', o);
    expect(asOwner.status).toBe(200);
    expect(asOwner.text).toContain('data-post-mod="pinned"');

    // Comments on the post: same rule.
    expect((await call(reader.cookie, '/api/comments', 'POST', { postId: post.id, body: 'hi' })).status).toBe(404);
    expect((await call(null, '/api/comments', 'POST', { postId: post.id, body: 'hi' })).status).toBe(401);
    expect((await call(dana.cookie, '/api/comments', 'POST', { postId: post.id, body: 'Me again' })).status).toBe(201);
    expect((await page('/community/musicians/first-jam', dana.cookie)).text).toContain('Me again');
    const inbox = await (await call(o, '/api/studio/comments')).json();
    expect(inbox.comments[0].entry).toMatchObject({ kind: 'post', title: 'First jam', path: '/community/musicians/first-jam' });
  });

  it('lets the owner pin, hide, open to everyone and delete any post', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'Musicians', 'dana');
    const eli = await joinTo(o, 'Musicians', 'eli');
    const { post } = await write(dana.cookie, 'Musicians', { title: 'Open letter' });

    // Moderation is the owner's alone.
    expect((await call(dana.cookie, `/api/studio/posts/${post.id}`, 'PATCH', { public: true })).status).toBe(401);
    expect((await call(o, `/api/studio/posts/${post.id}`, 'PATCH', { public: true, pinned: true })).status).toBe(200);
    const anon = await page('/community/musicians/open-letter');
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain('data-comment-form'); // outsiders read, the community talks
    expect((await page('/community/musicians')).text).toContain('Open letter');
    expect((await page('/community')).text).toContain('href="/community/musicians"');

    await call(o, `/api/studio/posts/${post.id}`, 'PATCH', { hidden: true });
    expect((await page('/community/musicians/open-letter')).status).toBe(404);
    expect((await page('/community/musicians/open-letter', eli.cookie)).status).toBe(404);
    expect((await page('/community/musicians/open-letter', dana.cookie)).text).toContain('מוסתר'); // the writer still sees it
    expect((await page('/community/musicians/open-letter', o)).status).toBe(200);
    const studio = await (await call(o, '/api/studio/posts?status=hidden')).json();
    expect(studio.posts.map((p) => p.title)).toEqual(['Open letter']);

    // Another member may not edit or delete it; the writer may edit, the owner may delete.
    await call(o, `/api/studio/posts/${post.id}`, 'PATCH', { hidden: false });
    expect((await call(eli.cookie, `/api/blog/posts/${post.id}`, 'PATCH', { title: 'Mine now', body: 'x' })).status).toBe(403);
    expect((await call(eli.cookie, `/api/blog/posts/${post.id}`, 'DELETE')).status).toBe(403);
    expect((await call(dana.cookie, `/api/blog/posts/${post.id}`, 'PATCH', { title: 'Open letter, again', body: 'Edited' })).status).toBe(200);
    expect((await page('/community/musicians/open-letter', eli.cookie)).text).toContain('Edited');
    await call(eli.cookie, '/api/comments', 'POST', { postId: post.id, body: 'Nice' });
    expect((await call(o, `/api/blog/posts/${post.id}`, 'DELETE')).status).toBe(200);
    expect((await page('/community/musicians/open-letter', o)).status).toBe(404);
    expect((await (await call(o, '/api/studio/comments')).json()).comments).toHaveLength(0);

    // The owner writes too.
    const own = await write(o, 'Musicians', { title: 'From me' });
    expect(own.status).toBe(201);
    expect((await page('/community/musicians/from-me', eli.cookie)).text).toContain('<span class="mention" dir="auto">יצחק</span>');
  });

  it('keeps a hidden community\'s blog away from everyone outside it', async () => {
    const o = await owner();
    await club(o, 'Secret', { hidden: true });
    const insider = await joinTo(o, 'Secret', 'insider');
    const outsider = await member(o, 'outsider');
    const { status, post } = await write(insider.cookie, 'Secret', { title: 'Between us' });
    expect(status).toBe(201);
    expect(post.path).toBe('/community/secret/between-us');
    expect((await page(post.path, insider.cookie)).status).toBe(200);
    await call(o, `/api/studio/posts/${post.id}`, 'PATCH', { public: true });
    for (const who of [null, outsider.cookie]) {
      expect((await page('/community/secret', who)).status).toBe(404);
      expect((await page(post.path, who)).status).toBe(404);
    }
    expect((await write(outsider.cookie, 'Secret')).status).toBe(404);
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
    const dana = await joinTo(o, 'Musicians', 'dana');
    for (let i = 0; i < 6; i++) expect((await write(dana.cookie, 'Musicians', { title: `Post ${i}` })).status).toBe(201);
    expect((await write(dana.cookie, 'Musicians', { title: 'One more' })).status).toBe(429);
    expect((await write(o, 'Musicians', { title: 'Owner is not limited' })).status).toBe(201);
  });
});

describe('tagging members', () => {
  it('only resolves to members of the same community', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'Musicians', 'dana', 'Dana');
    const yossi = await joinTo(o, 'Musicians', 'yossi', 'Yossi');
    const reader = await joinTo(o, 'Readers', 'reader', 'Reader');

    // Who can be picked: the community only, and only by the community.
    const music = clubs.Musicians.id;
    const found = await (await call(dana.cookie, `/api/people?community=${music}&q=`)).json();
    expect(found.people.map((p) => p.name)).toEqual(['Yossi']);
    expect((await call(reader.cookie, `/api/people?community=${music}&q=`)).status).toBe(403);
    expect((await call(null, `/api/people?community=${music}&q=`)).status).toBe(401);
    expect((await (await call(o, `/api/people?community=${music}&q=da`)).json()).people.map((p) => p.name)).toEqual(['Dana']);

    const song = await (await call(o, '/api/studio/entries', 'POST', { kind: 'song', title: 'Tune', visibility: 'community', communities: [music], status: 'published', spaceId: 'music' })).json();
    expect((await (await call(dana.cookie, `/api/people?entry=${song.id}&q=`)).json()).people.map((p) => p.name)).toEqual(['Yossi']);
    expect((await call(reader.cookie, `/api/people?entry=${song.id}&q=`)).status).toBe(404);
    const res = await call(dana.cookie, '/api/comments', 'POST', { entryId: song.id, body: `Ask @{${yossi.id}} and @{${reader.id}}` });
    expect(res.status).toBe(201);
    const c = await res.json();
    expect(c.body).toBe(`Ask @{${yossi.id}} and `);

    const seen = await page('/music/tune', yossi.cookie);
    expect(seen.text).toContain('<span class="mention" dir="auto">@Yossi</span>');
    expect(seen.text).not.toContain('Reader');

    // The tagged member sees it on their page; the outsider sees nothing.
    const yp = await page('/community', yossi.cookie);
    expect(yp.text).toContain('תייגו אתכם');
    expect(yp.text).toContain(`/music/tune#c-${c.id}`);
    expect((await page('/community', reader.cookie)).text).not.toContain('/music/tune');

    // Names follow renames.
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('Yossi K', yossi.id).run();
    expect((await page('/music/tune', dana.cookie)).text).toContain('@Yossi K');

    // In a post too.
    const { post } = await write(dana.cookie, 'Musicians', { title: 'Thanks', body: `Thanks @{${yossi.id}}! And @{${reader.id}}` });
    expect(post.body).toBe(`Thanks @{${yossi.id}}! And `);
    expect((await page(post.path, yossi.cookie)).text).toContain('<span class="mention" dir="auto">@Yossi K</span>');
    expect((await page('/community', yossi.cookie)).text).toContain(post.path);

    // Losing access to the post takes it off the list.
    await call(o, `/api/studio/communities/${music}/members`, 'PATCH', { userId: yossi.id, status: 'removed' });
    expect((await page('/community', yossi.cookie)).text).not.toContain(post.path);
  });

  it('lets the owner credit members on an item', async () => {
    const o = await owner();
    const dana = await joinTo(o, 'Musicians', 'dana', 'Dana');
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
    expect(mine.text).toContain('הקרדיטים שלכם');
    expect(mine.text).toContain('href="/music/credited"');
  });
});
