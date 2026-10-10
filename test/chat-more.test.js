import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { ChatRoom } from '../src/chat-room.js';
import { FakeD1 } from './fake-d1.js';

const ORIGIN = 'https://site.test';
let env;
let sent; // what the worker handed the live rooms

// Stands in for the CHAT Durable Object namespace.
function fakeRooms() {
  return {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (input, init) => {
        const r = new Request(input, init);
        sent.push({ room: id, path: new URL(r.url).pathname, body: r.method === 'POST' ? await r.text() : null, headers: r.headers });
        return new Response('ok');
      },
    }),
  };
}

beforeEach(() => {
  for (const k of Object.keys(clubs)) delete clubs[k];
  sent = [];
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`) },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body, headers = {}) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
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
const say = (cookie, roomId, body, more = {}) => call(cookie, `/api/chat/${roomId}/messages`, 'POST', { body, ...more });
const history = async (cookie, roomId, q = '') => (await call(cookie, `/api/chat/${roomId}/messages${q}`)).json();

describe('chat: stars, halls of fame, pages shared from the site', () => {
  it('stars a message for everyone, on the chat and on the community page', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const eli = await joinTo(o, 'Jokes', 'eli', 'Eli');
    const m = await (await say(dana.cookie, jokes.id, 'The weather lady says: no weather today')).json();
    expect(m.starred).toBe(false);

    const starred = await (await call(eli.cookie, `/api/chat/messages/${m.id}`, 'PATCH', { starred: true })).json();
    expect(starred.starred).toBe(true);
    expect((await history(dana.cookie, jokes.id)).starred.map((x) => x.id)).toEqual([m.id]);
    const blog = await page('/community/jokes', dana.cookie);
    expect(blog.text).toContain('מסומנות בכוכב');
    expect(blog.text).toContain(`/community/jokes/chat#m-${m.id}`);

    // A reader only reads: no stars either.
    await call(o, `/api/chat/${jokes.id}/members/${eli.id}`, 'PUT', { role: 'read' });
    expect((await call(eli.cookie, `/api/chat/messages/${m.id}`, 'PATCH', { starred: false })).status).toBe(403);

    // A deleted message loses its star.
    await call(dana.cookie, `/api/chat/messages/${m.id}`, 'DELETE');
    expect((await history(dana.cookie, jokes.id)).starred).toEqual([]);
    expect((await page('/community/jokes', dana.cookie)).text).not.toContain('מסומנות בכוכב');
  });

  it('keeps characters with a hall of fame each', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const eli = await joinTo(o, 'Jokes', 'eli', 'Eli');
    const outsider = await member(o, 'outsider');

    // The owner keeps the list of characters.
    expect((await call(dana.cookie, `/api/chat/${jokes.id}/characters`, 'POST', { name: 'The weather lady' })).status).toBe(403);
    const made = await call(o, `/api/chat/${jokes.id}/characters`, 'POST', { name: 'The weather lady', about: 'Forecasts the opposite' });
    expect(made.status).toBe(201);
    const { character: lady } = await made.json();
    expect((await call(o, `/api/chat/${jokes.id}/characters`, 'POST', { name: 'The weather lady' })).status).toBe(409);
    const { character: dad } = await (await call(o, `/api/chat/${jokes.id}/characters`, 'POST', { name: 'Dad' })).json();
    expect((await (await call(dana.cookie, `/api/chat/${jokes.id}/characters`)).json()).characters.map((c) => c.name)).toEqual(['The weather lady', 'Dad']);
    expect((await call(outsider.cookie, `/api/chat/${jokes.id}/characters`)).status).toBe(403);

    // Anyone who writes puts a message in a hall.
    const line = await (await say(dana.cookie, jokes.id, 'Tomorrow: partly yesterday')).json();
    const res = await call(eli.cookie, `/api/chat/messages/${line.id}/hall`, 'POST', { character: lady.id });
    expect(res.status).toBe(201);
    expect((await res.json()).hall).toEqual([{ id: lady.id, name: 'The weather lady' }]);
    await call(o, `/api/chat/messages/${line.id}/hall`, 'POST', { character: dad.id });
    expect((await call(dana.cookie, `/api/chat/messages/${line.id}/hall`, 'POST', { character: 'nope' })).status).toBe(404);
    const priv = await (await say(dana.cookie, jokes.id, 'just for Eli', { audience: [eli.id] })).json();
    expect((await call(dana.cookie, `/api/chat/messages/${priv.id}/hall`, 'POST', { character: lady.id })).status).toBe(400);

    // The hall page: for the community only.
    const hall = await page('/community/jokes/hall', dana.cookie);
    expect(hall.status).toBe(200);
    expect(hall.text).toContain('The weather lady');
    expect(hall.text).toContain('Forecasts the opposite');
    expect(hall.text).toContain('Tomorrow: partly yesterday');
    expect(hall.text).toContain(`/community/jokes/chat#m-${line.id}`);
    expect(hall.text).not.toContain('data-char-new'); // only the owner adds characters
    expect((await page('/community/jokes/hall', o)).text).toContain('data-char-new');
    for (const who of [null, outsider.cookie]) {
      const out = await page('/community/jokes/hall', who);
      expect(out.status).toBe(200);
      expect(out.text).not.toContain('partly yesterday');
    }
    expect((await page('/community/jokes', dana.cookie)).text).toContain('href="/community/jokes/hall"');

    // Out again: whoever put it there, or the owner.
    expect((await call(dana.cookie, `/api/chat/messages/${line.id}/hall/${lady.id}`, 'DELETE')).status).toBe(403);
    expect((await call(eli.cookie, `/api/chat/messages/${line.id}/hall/${lady.id}`, 'DELETE')).status).toBe(200);
    // Renaming shows on the message; deleting a character keeps the message.
    await call(o, `/api/chat/characters/${dad.id}`, 'PATCH', { name: 'Abba' });
    expect((await history(dana.cookie, jokes.id)).messages.find((x) => x.id === line.id).hall).toEqual([{ id: dad.id, name: 'Abba' }]);
    expect((await call(dana.cookie, `/api/chat/characters/${dad.id}`, 'DELETE')).status).toBe(403);
    await call(o, `/api/chat/characters/${dad.id}`, 'DELETE');
    const after = (await history(dana.cookie, jokes.id)).messages.find((x) => x.id === line.id);
    expect(after.hall).toEqual([]);
    expect(after.body).toBe('Tomorrow: partly yesterday');

    // A deleted message leaves every hall.
    await call(o, `/api/chat/messages/${line.id}/hall`, 'POST', { character: lady.id });
    await call(dana.cookie, `/api/chat/messages/${line.id}`, 'DELETE');
    expect((await page('/community/jokes/hall', dana.cookie)).text).not.toContain('partly yesterday');
  });

  it('takes pages of the site into a chat, from the share button', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    await club(o, 'Readers');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const loner = await member(o, 'loner');

    // The chats one can send to.
    expect((await (await call(dana.cookie, '/api/chat/rooms')).json()).rooms).toEqual([{ id: jokes.id, title: 'Jokes', path: '/community/jokes/chat', canWrite: true }]);
    expect((await (await call(o, '/api/chat/rooms')).json()).rooms.map((r) => r.title).sort()).toEqual(['Jokes', 'Readers']);
    expect((await call(null, '/api/chat/rooms')).status).toBe(401);

    const res = await say(dana.cookie, jokes.id, '', { share: { path: '/music/some-song', title: '  A   song ' } });
    expect(res.status).toBe(201);
    const m = await res.json();
    expect(m.share).toEqual({ path: '/music/some-song', title: 'A song', where: 'מוזיקה' });
    expect(m.body).toBe('');
    for (const bad of ['https://evil.test/x', '//evil.test/x', '/\\evil', 'javascript:alert(1)', '/a b', '/x"onmouseover']) {
      expect((await say(dana.cookie, jokes.id, 'look', { share: { path: bad, title: 'x' } })).status).toBe(400);
    }
    // With a few words too; the community page shows the line.
    await say(dana.cookie, jokes.id, 'read this', { share: { path: '/community/jokes/a-post', title: 'A post' } });
    expect((await history(dana.cookie, jokes.id)).messages.at(-1).share.where).toBe('קהילה');

    // As a blog post the page stays a link.
    const post = await (await call(dana.cookie, `/api/chat/messages/${m.id}/post`, 'POST', {})).json();
    const blog = await page(post.post.path, dana.cookie);
    expect(blog.text).toContain('href="/music/some-song"');

    // The header button: for whoever is in a chat.
    expect((await page('/community/jokes', dana.cookie)).text).toContain('data-share');
    expect((await page('/community/jokes', o)).text).toContain('data-share');
    expect((await page('/community/jokes')).text).not.toContain('data-share');
    expect((await page('/community', loner.cookie)).text).not.toContain('data-share');
    expect((await page('/community/jokes/chat', dana.cookie)).text).not.toContain('data-share');
  });
});
