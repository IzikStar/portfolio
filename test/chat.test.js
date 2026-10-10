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

describe('community chat', () => {
  it('is for the community and the owner only', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const reader = await joinTo(o, 'Readers', 'reader');
    const outsider = await member(o, 'outsider');

    const res = await say(dana.cookie, jokes.id, 'Why did the chord cross the road?');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ author: 'Dana', userId: dana.id, body: 'Why did the chord cross the road?', pinned: false });
    expect((await say(o, jokes.id, 'To get to the bridge')).status).toBe(201);

    expect((await say(null, jokes.id, 'hi')).status).toBe(401);
    expect((await say(outsider.cookie, jokes.id, 'hi')).status).toBe(403);
    expect((await say(reader.cookie, jokes.id, 'hi')).status).toBe(403);
    expect((await call(outsider.cookie, `/api/chat/${jokes.id}/messages`)).status).toBe(403);
    expect((await say(dana.cookie, jokes.id, '   ')).status).toBe(400);

    const { messages, more } = await history(dana.cookie, jokes.id);
    expect(more).toBe(false);
    expect(messages.map((m) => [m.author, m.body])).toEqual([
      ['Dana', 'Why did the chord cross the road?'],
      ['יצחק', 'To get to the bridge'],
    ]);

    // The page: the chat for those inside, a way in for those outside.
    const inside = await page('/community/jokes/chat', dana.cookie);
    expect(inside.status).toBe(200);
    expect(inside.text).toContain('id="chat-data"');
    expect(inside.text).toContain('src="/chat.js"');
    expect(inside.text).toContain('data-page="chat"');
    expect(inside.text).toContain('To get to the bridge');
    for (const who of [null, outsider.cookie]) {
      const out = await page('/community/jokes/chat', who);
      expect(out.status).toBe(200);
      expect(out.text).not.toContain('chat-data');
      expect(out.text).not.toContain('bridge');
    }
    // The community page leads into the chat, with its latest line.
    const blog = await page('/community/jokes', dana.cookie);
    expect(blog.text).toContain('href="/community/jokes/chat"');
    expect(blog.text).toContain('To get to the bridge');
    expect((await page('/community/jokes', outsider.cookie)).text).not.toContain('/community/jokes/chat');
  });

  it('keeps a hidden community\'s chat out of sight', async () => {
    const o = await owner();
    const secret = await club(o, 'Secret', { hidden: true });
    const insider = await joinTo(o, 'Secret', 'insider');
    const outsider = await member(o, 'outsider');
    expect((await say(insider.cookie, secret.id, 'psst')).status).toBe(201);
    expect((await say(outsider.cookie, secret.id, 'hi')).status).toBe(404);
    expect((await page('/community/secret/chat', outsider.cookie)).status).toBe(404);
    expect((await page('/community/secret/chat')).status).toBe(404);
    expect((await page('/community/secret/chat', insider.cookie)).status).toBe(200);
  });

  it('replies, edits, pins and deletes, and a poll sees every change', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const eli = await joinTo(o, 'Jokes', 'eli', 'Eli');
    const first = await (await say(dana.cookie, jokes.id, 'Knock knock')).json();
    const { now } = await history(eli.cookie, jokes.id);

    const reply = await (await say(eli.cookie, jokes.id, "Who's there?", { replyTo: first.id })).json();
    expect(reply.reply).toMatchObject({ author: 'Dana', text: 'Knock knock' });

    // Only the writer edits; anyone in the chat pins.
    expect((await call(eli.cookie, `/api/chat/messages/${first.id}`, 'PATCH', { body: 'Mine now' })).status).toBe(403);
    const edited = await (await call(dana.cookie, `/api/chat/messages/${first.id}`, 'PATCH', { body: 'Knock knock!' })).json();
    expect(edited).toMatchObject({ body: 'Knock knock!' });
    expect(edited.editedAt).toBeTruthy();
    expect((await call(eli.cookie, `/api/chat/messages/${first.id}`, 'PATCH', { pinned: true })).status).toBe(200);
    const start = await history(eli.cookie, jokes.id);
    expect(start.pinned.map((m) => m.body)).toEqual(['Knock knock!']);

    // Polling with ?since= brings the new reply and the edited, pinned message.
    const changes = await history(eli.cookie, jokes.id, `?since=${encodeURIComponent(now)}`);
    const byId = new Map(changes.messages.map((m) => [m.id, m]));
    expect(byId.get(first.id)).toMatchObject({ body: 'Knock knock!', pinned: true });
    expect(byId.get(reply.id)).toMatchObject({ body: "Who's there?" });

    // Deleting: the writer or the owner, never someone else. The text is gone for good.
    expect((await call(eli.cookie, `/api/chat/messages/${first.id}`, 'DELETE')).status).toBe(403);
    expect((await call(o, `/api/chat/messages/${first.id}`, 'DELETE')).status).toBe(200);
    expect((await call(eli.cookie, `/api/chat/messages/${reply.id}`, 'DELETE')).status).toBe(200);
    const after = await history(dana.cookie, jokes.id);
    expect(after.messages.map((m) => [m.deleted, m.body, m.pinned])).toEqual([
      [true, '', false],
      [true, '', false],
    ]);
    expect(after.pinned).toEqual([]);
    expect((await call(dana.cookie, `/api/chat/messages/${first.id}`, 'PATCH', { body: 'back' })).status).toBe(404);

    // Someone outside cannot touch a message at all.
    const outsider = await member(o, 'outsider');
    expect((await call(outsider.cookie, `/api/chat/messages/${reply.id}`, 'PATCH', { pinned: true })).status).toBe(404);
  });

  it('pages back through older messages', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    for (let i = 0; i < 85; i++) {
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      await env.DB.prepare(
        `INSERT INTO chat_messages (id, community_id, user_id, author, body, created_at, changed_at) VALUES (?, ?, NULL, 'x', ?, ?, ?)`,
      ).bind(`m${String(i).padStart(3, '0')}`, jokes.id, `line ${i}`, t, t).run();
    }
    const first = await history(o, jokes.id);
    expect(first.messages).toHaveLength(80);
    expect(first.more).toBe(true);
    expect(first.messages[0].body).toBe('line 5');
    const older = await history(o, jokes.id, `?before=${encodeURIComponent(first.messages[0].createdAt)}`);
    expect(older.messages.map((m) => m.body)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
    expect(older.more).toBe(false);
  });

  it('limits how fast a member writes', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana');
    for (let i = 0; i < 40; i++) expect((await say(dana.cookie, jokes.id, `ha ${i}`)).status).toBe(201);
    expect((await say(dana.cookie, jokes.id, 'one more')).status).toBe(429);
    expect((await say(o, jokes.id, 'the owner is never limited')).status).toBe(201);
  });

  it('turns a message into a blog post with comments, credited to its writer', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const eli = await joinTo(o, 'Jokes', 'eli', 'Eli');
    const joke = await (await say(dana.cookie, jokes.id, 'A bass player walks into a bar\nand nobody notices.')).json();
    const other = await (await say(eli.cookie, jokes.id, 'Classic')).json();

    // Members post their own messages only, and only for the community.
    expect((await call(dana.cookie, `/api/chat/messages/${other.id}/post`, 'POST', {})).status).toBe(403);
    const res = await call(dana.cookie, `/api/chat/messages/${joke.id}/post`, 'POST', { public: true });
    expect(res.status).toBe(201);
    const posted = await res.json();
    expect(posted.post).toMatchObject({ path: '/community/jokes/a-bass-player-walks-into-a-bar', public: false, comments: 0 });
    expect((await page(posted.post.path)).status).toBe(404);
    const asEli = await page(posted.post.path, eli.cookie);
    expect(asEli.text).toContain('and nobody notices.');
    expect(asEli.text).toContain('data-comment-form');
    expect(asEli.text).toContain('Dana');

    // Comments on it show up in the chat as a count.
    const { posts } = await (await call(o, '/api/studio/posts')).json();
    expect((await call(eli.cookie, '/api/comments', 'POST', { postId: posts[0].id, body: 'Ha!' })).status).toBe(201);
    expect((await history(dana.cookie, jokes.id)).messages[0].post.comments).toBe(1);

    // The owner opens it to everyone; outsiders read it, the community comments.
    const open = await (await call(o, `/api/chat/messages/${joke.id}/post`, 'POST', { public: true })).json();
    expect(open.post.public).toBe(true);
    const anon = await page(posted.post.path);
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain('data-comment-form');

    // The owner can publish someone else's message; it stays theirs.
    const second = await (await call(o, `/api/chat/messages/${other.id}/post`, 'POST', { public: true })).json();
    expect(second.post.public).toBe(true);
    const all = await (await call(o, '/api/studio/posts')).json();
    expect(all.posts.find((p) => p.title === 'Classic')).toMatchObject({ author: 'Eli', public: true });
    // Eli wrote it, so Eli may edit the post.
    const eliPost = all.posts.find((p) => p.title === 'Classic');
    expect((await call(eli.cookie, `/api/blog/posts/${eliPost.id}`, 'PATCH', { title: 'Classic', body: 'Classic!' })).status).toBe(200);
  });

  it('never gives a post the chat\'s address', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const res = await call(o, `/api/blog/${jokes.id}/posts`, 'POST', { title: 'chat', body: 'about chatting' });
    expect((await res.json()).path).toBe('/community/jokes/chat-2');
  });

  it('hands every change to the live room', async () => {
    env.CHAT = fakeRooms();
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const m = await (await say(dana.cookie, jokes.id, 'live!')).json();
    await call(dana.cookie, `/api/chat/messages/${m.id}`, 'PATCH', { pinned: true });
    expect(sent.map((s) => s.room)).toEqual([jokes.id, jokes.id]);
    expect(sent.every((s) => s.path === '/broadcast')).toBe(true);
    const [a, b] = sent.map((s) => JSON.parse(s.body));
    expect(a).toMatchObject({ type: 'message', message: { id: m.id, body: 'live!', author: 'Dana' } });
    expect(b).toMatchObject({ type: 'message', message: { id: m.id, pinned: true } });
  });

  it('opens a socket only for those inside, from this site', async () => {
    const o = await owner();
    const jokes = await club(o, 'Jokes');
    const dana = await joinTo(o, 'Jokes', 'dana', 'Dana');
    const outsider = await member(o, 'outsider');
    const ws = { Upgrade: 'websocket' };
    const path = `/api/chat/${jokes.id}/socket`;

    // No live rooms bound: the page is told to poll.
    const noLive = await call(dana.cookie, path, 'GET', undefined, ws);
    expect(noLive.status).toBe(503);
    expect(await noLive.json()).toMatchObject({ poll: true });

    env.CHAT = fakeRooms();
    expect((await call(dana.cookie, path)).status).toBe(426);
    expect((await call(outsider.cookie, path, 'GET', undefined, ws)).status).toBe(403);
    expect((await call(null, path, 'GET', undefined, ws)).status).toBe(401);
    expect((await call(dana.cookie, path, 'GET', undefined, { ...ws, Origin: 'https://evil.test' })).status).toBe(403);
    expect(sent).toHaveLength(0);

    expect((await call(dana.cookie, path, 'GET', undefined, ws)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe(jokes.id);
    expect(sent[0].headers.get('X-Chat-User')).toBe(dana.id);
    expect(decodeURIComponent(sent[0].headers.get('X-Chat-Name'))).toBe('Dana');
    expect(sent[0].headers.get('X-Chat-Room')).toBe(jokes.id);
    expect(sent[0].headers.get('Upgrade')).toBe('websocket');
    await call(o, path, 'GET', undefined, ws);
    expect(sent[1].headers.get('X-Chat-User')).toBe('owner');
  });
});

// ---------- the live room itself ----------

class FakeSocket {
  constructor() {
    this.got = [];
    this.readyState = 1;
    this.att = null;
  }
  send(text) {
    this.got.push(text === 'pong' ? text : JSON.parse(text));
  }
  close(code) {
    this.readyState = 3;
    this.closedWith = code;
  }
  serializeAttachment(a) {
    this.att = structuredClone(a);
  }
  deserializeAttachment() {
    return this.att;
  }
}

function fakeState() {
  const sockets = [];
  return {
    sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
    getWebSockets: () => sockets.filter((ws) => ws.readyState === 1),
    setWebSocketAutoResponse: () => {},
  };
}

// Joins a socket to the room the way the room's own fetch does.
function join(room, state, who) {
  const ws = new FakeSocket();
  state.acceptWebSocket(ws);
  ws.serializeAttachment({ room: 'jokes', checked: Date.now(), ...who });
  return ws;
}

describe('the live room', () => {
  it('passes messages on, says who is here and who is typing', async () => {
    const state = fakeState();
    const room = new ChatRoom(state, { DB: null });
    const a = join(room, state, { id: 'owner', name: 'יצחק' });
    const b = join(room, state, { id: 'u1', name: 'Dana' });
    await room.presence();
    expect(a.got.at(-1)).toEqual({ type: 'presence', people: [{ id: 'owner', name: 'יצחק' }, { id: 'u1', name: 'Dana' }] });

    const res = await room.fetch(new Request('https://chat.internal/broadcast', { method: 'POST', body: JSON.stringify({ type: 'message', message: { id: 'm1' } }) }));
    expect(res.status).toBe(200);
    expect(a.got.at(-1)).toEqual({ type: 'message', message: { id: 'm1' } });
    expect(b.got.at(-1)).toEqual({ type: 'message', message: { id: 'm1' } });

    const before = b.got.length;
    await room.webSocketMessage(b, JSON.stringify({ type: 'typing' }));
    expect(a.got.at(-1)).toEqual({ type: 'typing', id: 'u1', name: 'Dana' });
    expect(b.got).toHaveLength(before); // not back to the one typing
    await room.webSocketMessage(b, 'not json');
    await room.webSocketMessage(b, JSON.stringify({ type: 'message', message: { id: 'forged' } }));
    expect(a.got.at(-1)).toEqual({ type: 'typing', id: 'u1', name: 'Dana' });

    b.readyState = 3;
    await room.webSocketClose(b, 1006);
    expect(a.got.at(-1)).toEqual({ type: 'presence', people: [{ id: 'owner', name: 'יצחק' }] });
  });

  it('closes the socket of someone taken out of the community', async () => {
    const d = new FakeD1();
    d.db.exec(`CREATE TABLE community_members (community_id TEXT, user_id TEXT, status TEXT);
      CREATE TABLE users (id TEXT, status TEXT);
      INSERT INTO users VALUES ('u1', 'active'), ('u2', 'active');
      INSERT INTO community_members VALUES ('jokes', 'u1', 'active'), ('jokes', 'u2', 'active');`);
    const state = fakeState();
    const room = new ChatRoom(state, { DB: d });
    const stays = join(room, state, { id: 'u1', name: 'Dana', checked: 0 });
    const goes = join(room, state, { id: 'u2', name: 'Eli', checked: 0 });
    d.db.exec(`DELETE FROM community_members WHERE user_id = 'u2'`);
    await room.send(JSON.stringify({ type: 'message', message: { id: 'm2' } }));
    expect(stays.got.at(-1)).toEqual({ type: 'message', message: { id: 'm2' } });
    expect(goes.got).toHaveLength(0);
    expect(goes.closedWith).toBe(4003);
    expect(stays.deserializeAttachment().checked).toBeGreaterThan(0);
  });
});
