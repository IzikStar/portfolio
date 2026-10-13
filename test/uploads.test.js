import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { PIECE } from '../src/blobs.js';

class FakeKV {
  constructor() {
    this.data = new Map();
  }
  async get(key, type) {
    const e = this.data.get(key);
    if (!e) return null;
    return type === 'json' ? JSON.parse(e.value) : e.value;
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
    ASSETS: { fetch: async () => new Response('not found page', { status: 404 }) },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
async function owner() {
  const res = await req('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }) });
  return res.headers.get('Set-Cookie').split(';')[0];
}
const json = (cookie, path, method, body) =>
  req(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const entry = async (cookie, fields) => (await json(cookie, '/api/studio/entries', 'POST', { kind: 'dub', spaceId: 'humor', title: 'Clip', ...fields })).json();
const put = (cookie, entryId, bytes, { type = 'video/mp4', name = 'clip.mp4' } = {}) =>
  req(`/api/studio/files?entryId=${entryId}&name=${encodeURIComponent(name)}`, { method: 'PUT', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': type }, body: bytes });

// Bytes where every position is recognisable: byte i is i mod 251.
const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe('uploading a file as the request body', () => {
  it('keeps a small file as one value and serves it', async () => {
    const o = await owner();
    const e = await entry(o);
    const res = await put(o, e.id, pattern(1000), { name: 'סרטון.mp4' });
    expect(res.status).toBe(201);
    const f = await res.json();
    expect(f).toMatchObject({ kind: 'video', size: 1000, name: 'סרטון.mp4', type: 'video/mp4' });
    expect(env.MEDIA.data.has(`blob:${f.id}:0`)).toBe(false);
    const got = await req(f.url, { headers: { Cookie: o } });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(pattern(1000));
  });

  it('keeps a file past one piece in pieces, and serves whole files and ranges across them', async () => {
    const o = await owner();
    const e = await entry(o);
    const size = 2 * PIECE + 12345;
    const f = await (await put(o, e.id, pattern(size))).json();
    expect(f.size).toBe(size);
    expect([0, 1, 2].every((n) => env.MEDIA.data.has(`blob:${f.id}:${n}`))).toBe(true);

    const whole = await req(f.url, { headers: { Cookie: o } });
    expect(whole.headers.get('Content-Length')).toBe(String(size));
    const all = new Uint8Array(await whole.arrayBuffer());
    expect(all.length).toBe(size);
    expect(all[PIECE]).toBe(PIECE % 251);
    expect(all[size - 1]).toBe((size - 1) % 251);

    // A range that starts in the first piece and ends in the third.
    const start = PIECE - 10;
    const end = 2 * PIECE + 5;
    const part = await req(f.url, { headers: { Cookie: o, Range: `bytes=${start}-${end}` } });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${size}`);
    const got = new Uint8Array(await part.arrayBuffer());
    expect(got.length).toBe(end - start + 1);
    expect(got[0]).toBe(start % 251);
    expect(got[got.length - 1]).toBe(end % 251);

    // Deleting the file takes every piece with it.
    expect((await req(`/api/studio/files/${f.id}`, { method: 'DELETE', headers: { Cookie: o, Origin: ORIGIN } })).status).toBe(200);
    expect([...env.MEDIA.data.keys()].some((k) => k.startsWith(`blob:${f.id}`))).toBe(false);
  });

  it('refuses types it cannot show, items that do not exist, and strangers', async () => {
    const o = await owner();
    const e = await entry(o);
    expect((await put(o, e.id, pattern(10), { type: 'text/html', name: 'x.html' })).status).toBe(400);
    expect((await put(o, 'no-such-entry', pattern(10))).status).toBe(400);
    expect((await put('admin_session=nope', e.id, pattern(10))).status).toBe(401);
  });
});

describe('a cover belongs to its space', () => {
  it('shows to whoever may open the space, on the book page and on the shelf', async () => {
    const o = await owner();
    const space = (visibility) => json(o, '/api/studio/spaces', 'POST', { wing: 'books', parentId: 'books', kind: 'book', title: `ספר ${visibility}`, slug: `b-${visibility}`, visibility }).then((r) => r.json());
    const open = await space('public');
    const hidden = await space('private');
    const pic = { type: 'image/png', name: 'cover.png' };
    const a = await (await put(o, `space:${open.id}`, pattern(50), pic)).json();
    const b = await (await put(o, `space:${hidden.id}`, pattern(50), pic)).json();
    expect((await put(o, 'space:nope', pattern(50), pic)).status).toBe(400);
    expect((await put(o, `space:${open.id}`, pattern(50), { type: 'application/zip', name: 'x.zip' })).status).toBe(400);
    expect((await req(a.url)).status).toBe(200);
    expect((await req(a.url)).headers.get('Cache-Control')).toContain('public');
    expect((await req(b.url)).status).toBe(404);
    expect((await req(b.url, { headers: { Cookie: o } })).status).toBe(200);

    await json(o, `/api/studio/spaces/${open.id}`, 'PATCH', { meta: { cover: a.url, coverFile: a.id } });
    expect(await (await req('/books/b-public')).text()).toContain(`<div class="cover"><img src="${a.url}" alt=""></div>`);
    expect(await (await req('/books')).text()).toContain(`<img class="card-cover" src="${a.url}" alt="" loading="lazy">`);

    // A series with a cover opens like a book.
    const series = await (await json(o, '/api/studio/spaces', 'POST', { wing: 'books', parentId: 'books', kind: 'series', title: 'סדרה', slug: 's', visibility: 'public', meta: { cover: a.url } })).json();
    await json(o, `/api/studio/spaces/${open.id}`, 'PATCH', { parentId: series.id });
    const page = await (await req(`/books/s`)).text();
    expect(page).toContain(`<div class="cover"><img src="${a.url}" alt=""></div>`);
    expect(page).toContain('<div class="kicker">סדרה</div>');
  });
});
