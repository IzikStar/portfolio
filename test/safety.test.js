import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { emptyOldTrash, crc32, safeName } from '../src/safety.js';

class FakeKV {
  constructor() {
    this.data = new Map();
  }
  async get(key, type) {
    const e = this.data.get(key);
    if (!e) return null;
    if (type === 'json') return JSON.parse(e.value);
    if (type === 'arrayBuffer') return e.value instanceof ArrayBuffer ? e.value : new TextEncoder().encode(String(e.value)).buffer;
    return e.value;
  }
  async getWithMetadata(key) {
    const e = this.data.get(key);
    return e ? { value: e.value, metadata: e.metadata ?? null } : { value: null, metadata: null };
  }
  async put(key, value, opts = {}) {
    this.data.set(key, { value, metadata: opts.metadata });
  }
  async delete(key) {
    this.data.delete(key);
  }
}

const ORIGIN = 'https://site.test';
let env;
beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: new FakeKV(),
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`) },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));
async function entry(o, body) {
  const res = await call(o, '/api/studio/entries', 'POST', { kind: 'chapter', spaceId: 'books', ...body });
  expect(res.status).toBe(201);
  return res.json();
}
async function edit(o, e, body) {
  const res = await call(o, `/api/studio/entries/${e.id}`, 'PATCH', { baseUpdatedAt: e.updatedAt, ...body });
  return { res, data: await res.json() };
}
const revisions = async (o, e) => (await (await call(o, `/api/studio/entries/${e.id}/revisions`)).json()).revisions;
// Make every kept version look older than the 10-minute gap.
const age = () => env.DB.db.prepare(`UPDATE revisions SET kept_at = '2020-01-01T00:00:00.000Z'`).run();
const pause = () => new Promise((r) => setTimeout(r, 5));

describe('versions', () => {
  it('keeps the text an item had before, at most once per 10 minutes of editing', async () => {
    const o = await owner();
    let e = await entry(o, { title: 'Chapter', body: 'first draft' });
    expect(await revisions(o, e)).toEqual([]);

    await pause();
    e = (await edit(o, e, { body: 'second draft' })).data;
    let list = await revisions(o, e);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Chapter', chars: 'first draft'.length, reason: 'edit' });

    // Saving again a second later does not keep another one.
    await pause();
    e = (await edit(o, e, { body: 'third draft' })).data;
    expect(await revisions(o, e)).toHaveLength(1);

    // Ten minutes on, it does.
    age();
    await pause();
    e = (await edit(o, e, { body: 'fourth draft' })).data;
    list = await revisions(o, e);
    expect(list).toHaveLength(2);
    const newest = await (await call(o, `/api/studio/entries/${e.id}/revisions/${list[0].id}`)).json();
    expect(newest.body).toBe('third draft');

    // A save that changes nothing in the text keeps nothing.
    age();
    await pause();
    e = (await edit(o, e, { visibility: 'public' })).data;
    expect(await revisions(o, e)).toHaveLength(2);
  });

  it('always keeps the text before a big cut', async () => {
    const o = await owner();
    const long = 'מילים '.repeat(200);
    let e = await entry(o, { title: 'Long', body: long });
    await pause();
    e = (await edit(o, e, { body: `${long} ועוד` })).data;
    await pause();
    e = (await edit(o, e, { body: 'oops' })).data;
    const list = await revisions(o, e);
    expect(list).toHaveLength(2);
    const kept = await (await call(o, `/api/studio/entries/${e.id}/revisions/${list[0].id}`)).json();
    expect(kept.body).toBe(`${long} ועוד`);
  });

  it('restores a version, and the text it replaced becomes a version too', async () => {
    const o = await owner();
    let e = await entry(o, { title: 'Old title', body: 'the good text', status: 'published', visibility: 'public' });
    await pause();
    e = (await edit(o, e, { title: 'New title', body: 'a worse text' })).data;
    const [v] = await revisions(o, e);
    const res = await call(o, `/api/studio/entries/${e.id}/revisions/${v.id}/restore`, 'POST');
    expect(res.status).toBe(200);
    const back = await res.json();
    expect(back).toMatchObject({ title: 'Old title', body: 'the good text', status: 'published', visibility: 'public' });
    expect(back.updatedAt).not.toBe(e.updatedAt);
    const list = await revisions(o, e);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ title: 'New title', reason: 'restore' });
  });

  it("is the owner's only", async () => {
    const o = await owner();
    const e = await entry(o, { title: 'Private' });
    expect((await call(null, `/api/studio/entries/${e.id}/revisions`)).status).toBe(401);
  });
});

describe('saving from two windows', () => {
  it('refuses a stale save, and keeps the other window as a version when this one is kept', async () => {
    const o = await owner();
    const e = await entry(o, { title: 'Shared', body: 'from the start' });
    await pause();
    const phone = (await edit(o, e, { body: 'written on the phone' })).data;

    const stale = await edit(o, e, { body: 'written on the laptop' });
    expect(stale.res.status).toBe(409);
    expect(stale.data).toMatchObject({ conflict: true, updatedAt: phone.updatedAt });

    const kept = await edit(o, e, { body: 'written on the laptop', overwrite: true });
    expect(kept.res.status).toBe(200);
    expect(kept.data.body).toBe('written on the laptop');
    const list = await revisions(o, e);
    expect(list[0].reason).toBe('conflict');
    const other = await (await call(o, `/api/studio/entries/${e.id}/revisions/${list[0].id}`)).json();
    expect(other.body).toBe('written on the phone');
  });
});

describe('trash', () => {
  it('holds a deleted item with its comments and files, and puts it back', async () => {
    const o = await owner();
    const e = await entry(o, { title: 'Gone for now', body: 'text', status: 'published', visibility: 'public', slug: 'gone' });
    env.DB.db.prepare(`INSERT INTO comments (id, entry_id, author, body, created_at) VALUES ('c1', ?, 'Dana', 'nice', '2026-01-01')`).run(e.id);
    env.DB.db.prepare(`INSERT INTO files (id, entry_id, name, type, size, created_at) VALUES ('f1', ?, 'a.png', 'image/png', 3, '2026-01-01')`).run(e.id);
    await env.MEDIA.put('blob:f1', new Uint8Array([1, 2, 3]).buffer, { metadata: { type: 'image/png' } });

    expect((await call(o, `/api/studio/entries/${e.id}`, 'DELETE')).status).toBe(200);
    expect((await call(o, `/api/studio/entries/${e.id}`)).status).toBe(404);
    expect((await req('/books/gone')).status).toBe(404);
    expect(env.DB.db.prepare('SELECT COUNT(*) AS n FROM comments').get().n).toBe(0);

    const { items, days } = await (await call(o, '/api/studio/trash')).json();
    expect(days).toBe(30);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: e.id, title: 'Gone for now', kind: 'chapter' });

    const res = await call(o, `/api/studio/trash/${e.id}/restore`, 'POST');
    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe('gone');
    const back = await (await call(o, `/api/studio/entries/${e.id}`)).json();
    expect(back).toMatchObject({ title: 'Gone for now', body: 'text', status: 'published' });
    expect(env.DB.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE entry_id = ?').get(e.id).n).toBe(1);
    expect(env.DB.db.prepare('SELECT COUNT(*) AS n FROM files WHERE entry_id = ?').get(e.id).n).toBe(1);
    expect((await (await call(o, '/api/studio/trash')).json()).items).toHaveLength(0);
  });

  it('gives a restored item a new address when its old one was taken, and a wing when its space is gone', async () => {
    const o = await owner();
    const book = await (await call(o, '/api/studio/spaces', 'POST', { wing: 'books', parentId: 'books', kind: 'book', title: 'ספר' })).json();
    const e = await entry(o, { title: 'Chapter', spaceId: book.id, status: 'published', slug: 'chapter' });
    await call(o, `/api/studio/entries/${e.id}`, 'DELETE');
    expect((await call(o, `/api/studio/spaces/${book.id}`, 'DELETE')).status).toBe(200);
    await entry(o, { title: 'Another', status: 'published', slug: 'chapter' });

    const back = await (await call(o, `/api/studio/trash/${e.id}/restore`, 'POST')).json();
    expect(back.slug).toBe(`chapter-${e.id.slice(0, 4)}`);
    expect(back.spaceId).toBe('books');
  });

  it('is emptied of what is older than 30 days, files and versions too', async () => {
    const o = await owner();
    let e = await entry(o, { title: 'Old', body: 'v1' });
    await pause();
    e = (await edit(o, e, { body: 'v2' })).data;
    const fresh = await entry(o, { title: 'Fresh' });
    env.DB.db.prepare(`INSERT INTO files (id, entry_id, name, type, size, created_at) VALUES ('f2', ?, 'a.png', 'image/png', 3, '2026-01-01')`).run(e.id);
    await env.MEDIA.put('blob:f2', new Uint8Array([1]).buffer);
    await call(o, `/api/studio/entries/${e.id}`, 'DELETE');
    await call(o, `/api/studio/entries/${fresh.id}`, 'DELETE');
    env.DB.db.prepare(`UPDATE trash SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(e.id);

    expect(await emptyOldTrash(env)).toBe(1);
    const { items } = await (await call(o, '/api/studio/trash')).json();
    expect(items.map((x) => x.id)).toEqual([fresh.id]);
    expect(env.MEDIA.data.has('blob:f2')).toBe(false);
    expect(env.DB.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE entry_id = ?').get(e.id).n).toBe(0);
  });
});

// Reads the stored entries of a ZIP: name -> bytes.
function unzip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map();
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    const crc = v.getUint32(at + 14, true);
    const size = v.getUint32(at + 18, true);
    const nameLen = v.getUint16(at + 26, true);
    const name = new TextDecoder().decode(buf.subarray(at + 30, at + 30 + nameLen));
    const data = buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 30 + nameLen + size;
  }
  expect(v.getUint32(at, true)).toBe(0x02014b50);
  return out;
}

describe('export', () => {
  it('downloads everything as a ZIP: Markdown per item, data.json, files', async () => {
    const o = await owner();
    await entry(o, { title: 'פרק ראשון', body: 'בהתחלה', meta: { order: 1 } });
    await entry(o, { kind: 'song', spaceId: 'music', title: 'שיר/עם לוכסן', body: '[Am]לה לה', meta: { versions: [{ label: 'הקלטה', url: 'https://youtu.be/x', kind: 'audio' }] } });
    await entry(o, { kind: 'idea', spaceId: null, title: 'רעיון' });
    const { code } = await (await call(o, '/api/studio/invites', 'POST', {})).json();
    await call(null, '/api/member/join', 'POST', { code, username: 'dana', password: 'longenough' });

    expect((await call(null, '/api/studio/export')).status).toBe(401);
    const res = await call(o, '/api/studio/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="izikstar-backup-\d{4}-\d\d-\d\d\.zip"/);
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    const text = (n) => new TextDecoder().decode(files.get(n));

    expect(files.has('ספרים/01 פרק ראשון.md')).toBe(true);
    expect(text('ספרים/01 פרק ראשון.md')).toMatch(/^---\ntitle: "פרק ראשון"\n[\s\S]*---\n\nבהתחלה$/);
    expect(text('מוזיקה/שיר עם לוכסן.md')).toContain('versions:\n  - {"label":"הקלטה","url":"https://youtu.be/x"}');
    expect(files.has('רעיונות/רעיון.md')).toBe(true);
    expect(files.has('קרא אותי.txt')).toBe(true);

    const data = JSON.parse(text('data.json'));
    expect(data.entries).toHaveLength(3);
    expect(data.users[0].username).toBe('dana');
    expect(text('data.json')).not.toContain('password_hash');
  });

  it('makes names every file system takes', () => {
    expect(safeName('a/b:c*?"<>|d')).toBe('a b c d');
    expect(safeName('  ...')).toBe('item');
    expect(safeName('x'.repeat(200))).toHaveLength(80);
  });
});
