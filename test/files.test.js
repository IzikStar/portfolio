import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';

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
    ASSETS: { fetch: async () => new Response('not found page') },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
async function owner() {
  const res = await req('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }) });
  return res.headers.get('Set-Cookie').split(';')[0];
}
const json = (cookie, path, method, body) =>
  req(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function entry(cookie, fields) {
  return (await json(cookie, '/api/studio/entries', 'POST', { kind: 'article', title: 'Post', ...fields })).json();
}
function upload(cookie, entryId, { type = 'image/png', size = 100, name = 'shot.png' } = {}) {
  const form = new FormData();
  form.set('entryId', entryId);
  form.set('file', new File([new Uint8Array(size).fill(1)], name, { type }));
  return req('/api/studio/files', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN }, body: form });
}

describe('entry files', () => {
  it('uploads a file to an entry and serves it with the entry visibility', async () => {
    const o = await owner();
    const draft = await entry(o, { visibility: 'public' });
    const res = await upload(o, draft.id);
    expect(res.status).toBe(201);
    const f = await res.json();
    expect(f).toMatchObject({ url: `/files/${f.id}`, kind: 'image', size: 100 });

    // draft: owner only
    expect((await req(f.url)).status).toBe(404);
    const mine = await req(f.url, { headers: { Cookie: o } });
    expect(mine.status).toBe(200);
    expect(mine.headers.get('Content-Type')).toBe('image/png');
    expect(mine.headers.get('Cache-Control')).toMatch(/private/);
    expect(mine.headers.get('Content-Security-Policy')).toMatch(/sandbox/);

    await json(o, `/api/studio/entries/${draft.id}`, 'PATCH', { status: 'published' });
    const pub = await req(f.url);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('Cache-Control')).toMatch(/public/);
    expect((await req(f.url, { headers: { Range: 'bytes=0-9' } })).status).toBe(206);
  });

  it('keeps members-only files from the public', async () => {
    const o = await owner();
    const e = await entry(o, { visibility: 'members', status: 'published' });
    const f = await (await upload(o, e.id)).json();
    expect((await req(f.url)).status).toBe(404);
  });

  it('rejects unsupported, oversized and orphan uploads', async () => {
    const o = await owner();
    const e = await entry(o, {});
    expect((await upload(o, e.id, { type: 'text/html', name: 'x.html' })).status).toBe(400);
    expect((await upload(o, e.id, { type: 'image/svg+xml', name: 'x.svg' })).status).toBe(400);
    expect((await upload(o, e.id, { size: 95 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await upload(o, 'no-such-entry')).status).toBe(400);
    expect((await upload('admin_session=nope', e.id)).status).toBe(401);
  });

  it('lists and deletes files; an entry in the trash keeps them until it is emptied', async () => {
    const o = await owner();
    const e = await entry(o, {});
    const a = await (await upload(o, e.id)).json();
    const b = await (await upload(o, e.id, { type: 'application/pdf', name: 'cv.pdf' })).json();
    const list = await (await req(`/api/studio/entries/${e.id}/files`, { headers: { Cookie: o } })).json();
    expect(list.files.map((f) => f.id)).toEqual([a.id, b.id]);

    expect((await req(`/api/studio/files/${a.id}`, { method: 'DELETE', headers: { Cookie: o, Origin: ORIGIN } })).status).toBe(200);
    expect(env.MEDIA.data.has(`blob:${a.id}`)).toBe(false);

    await req(`/api/studio/entries/${e.id}`, { method: 'DELETE', headers: { Cookie: o, Origin: ORIGIN } });
    expect((await req(b.url ?? `/files/${b.id}`, { headers: { Cookie: o } })).status).toBe(404);
    expect(env.MEDIA.data.has(`blob:${b.id}`)).toBe(true);

    await req(`/api/studio/trash/${e.id}`, { method: 'DELETE', headers: { Cookie: o, Origin: ORIGIN } });
    expect(env.MEDIA.data.has(`blob:${b.id}`)).toBe(false);
  });
});
