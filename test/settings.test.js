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
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`) },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => (await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD })).headers.get('Set-Cookie').split(';')[0];

describe('social links', () => {
  it('are set in the studio and shown on every page', async () => {
    const o = await owner();
    expect((await (await call(o, '/api/studio/settings')).json()).socials[0].label).toBe('GitHub');
    expect((await call(o, '/api/studio/settings/socials', 'PUT', { socials: [{ label: 'YouTube', href: 'http://youtube.com/x' }] })).status).toBe(400);
    expect((await call(o, '/api/studio/settings/socials', 'PUT', { socials: [{ label: '', href: 'https://youtube.com/x' }] })).status).toBe(400);
    expect((await call(null, '/api/studio/settings/socials', 'PUT', { socials: [] })).status).toBe(401);
    const res = await call(o, '/api/studio/settings/socials', 'PUT', { socials: [{ label: 'YouTube', href: 'https://youtube.com/@x' }, { label: '', href: '' }] });
    expect((await res.json()).socials).toEqual([{ label: 'YouTube', href: 'https://youtube.com/@x' }]);
    const home = await (await call(null, '/')).text();
    expect(home).toContain('href="https://youtube.com/@x"');
    expect(home).not.toContain('github.com/IzikStar');
  });
});

describe('the old admin page', () => {
  it('moves its items into the wings once, with their files', async () => {
    const o = await owner();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await env.MEDIA.put('file:a', bytes, { metadata: { type: 'audio/mpeg' } });
    await env.MEDIA.put('items', JSON.stringify([
      { id: 'a', section: 'music', title: 'Old song', note: 'A note', kind: 'audio', hasFile: true, fileName: 'song.mp3', hidden: false, createdAt: '2024-06-01T00:00:00.000Z' },
      { id: 'b', section: 'voice', title: 'Old dub', link: 'https://youtu.be/abcdefghijk', kind: 'link', hasFile: false, hidden: true, createdAt: '2024-07-01T00:00:00.000Z' },
      { id: 'c', section: 'writing', title: 'Old essay', link: 'https://example.com/essay', kind: 'link', hasFile: false, hidden: false },
    ]));
    const first = await (await call(o, '/api/studio/import-legacy', 'POST', {})).json();
    expect(first.created.map((x) => [x.title, x.kind, x.status])).toEqual([
      ['Old song', 'song', 'published'],
      ['Old dub', 'dub', 'draft'],
      ['Old essay', 'article', 'published'],
    ]);
    const again = await (await call(o, '/api/studio/import-legacy', 'POST', {})).json();
    expect(again).toMatchObject({ created: [], skipped: 3, total: 3 });

    const song = await (await call(o, `/api/studio/entries/${first.created[0].id}`)).json();
    expect(song).toMatchObject({ spaceId: 'music', summary: 'A note', visibility: 'public', publishedAt: '2024-06-01T00:00:00.000Z' });
    expect(song.meta.versions[0]).toMatchObject({ label: 'הקלטה', kind: 'audio' });
    const file = await call(null, song.meta.versions[0].url);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await (await call(null, '/music/old-song')).text()).toContain('Old song');

    const dub = await (await call(o, `/api/studio/entries/${first.created[1].id}`)).json();
    expect(dub).toMatchObject({ spaceId: 'humor', visibility: 'private', status: 'draft' });
    expect(dub.meta.versions[0].url).toBe('https://youtu.be/abcdefghijk');
    const essay = await (await call(o, `/api/studio/entries/${first.created[2].id}`)).json();
    expect(essay.body).toContain('https://example.com/essay');
    expect((await call(null, '/api/studio/import-legacy', 'POST', {})).status).toBe(401);
  });
});
