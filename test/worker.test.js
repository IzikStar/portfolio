import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { MAX_AUDIO_BYTES } from '../src/limits.js';

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
    MEDIA: new FakeKV(),
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async () => new Response('asset') },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);

async function login() {
  const res = await req('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('Set-Cookie').split(';')[0];
}

function uploadForm({ title = 'Song', size = 1000, type = 'audio/mpeg', hidden = false } = {}) {
  const form = new FormData();
  form.set('title', title);
  form.set('note', 'Recorded at home');
  form.set('audio', new File([new Uint8Array(size).fill(7)], 'song.mp3', { type }));
  form.set('duration', '183.4');
  form.set('hidden', String(hidden));
  return form;
}

async function upload(cookie, opts) {
  return req('/api/admin/tracks', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN }, body: uploadForm(opts) });
}

describe('public routes', () => {
  it('serves static assets for non-API paths', async () => {
    expect(await (await req('/')).text()).toBe('asset');
  });

  it('lists no tracks on a fresh site', async () => {
    const res = await req('/api/tracks');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns 404 for unknown API paths', async () => {
    expect((await req('/api/nope')).status).toBe(404);
  });
});

describe('admin auth', () => {
  it('rejects a wrong password', async () => {
    const res = await req('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guess' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('sets a secure, http-only session cookie on the right password', async () => {
    const res = await req('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    });
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('blocks admin routes without a session', async () => {
    expect((await req('/api/admin/tracks')).status).toBe(401);
    expect((await req('/api/admin/session')).status).toBe(401);
  });

  it('rejects a forged or expired cookie', async () => {
    const future = Date.now() + 3600_000;
    expect((await req('/api/admin/tracks', { headers: { Cookie: `admin_session=${future}.forged` } })).status).toBe(401);
    const cookie = await login();
    const sig = cookie.split('.')[1];
    expect((await req('/api/admin/tracks', { headers: { Cookie: `admin_session=${Date.now() - 1000}.${sig}` } })).status).toBe(401);
  });

  it('stops working when the password changes', async () => {
    const cookie = await login();
    env.ADMIN_PASSWORD = 'a new password';
    expect((await req('/api/admin/tracks', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('blocks cross-site writes even with a valid cookie', async () => {
    const cookie = await login();
    const res = await req('/api/admin/tracks', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.test' },
      body: uploadForm(),
    });
    expect(res.status).toBe(403);
  });

  it('refuses to log anyone in when no password is configured', async () => {
    delete env.ADMIN_PASSWORD;
    const res = await req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: '' }) });
    expect(res.status).toBe(503);
  });
});

describe('tracks', () => {
  it('uploads a track and shows it publicly without private fields', async () => {
    const cookie = await login();
    const res = await upload(cookie, { title: '  שיר ראשון  ' });
    expect(res.status).toBe(201);
    const track = await res.json();
    expect(track.title).toBe('שיר ראשון');
    expect(track.duration).toBe(183);

    const list = await (await req('/api/tracks')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('fileName');
    expect(list[0]).not.toHaveProperty('hidden');
  });

  it('rejects non-audio and oversized files', async () => {
    const cookie = await login();
    expect((await upload(cookie, { type: 'application/pdf' })).status).toBe(400);
    expect((await upload(cookie, { size: MAX_AUDIO_BYTES + 1 })).status).toBe(413);
    expect((await upload(cookie, { title: '   ' })).status).toBe(400);
  });

  it('keeps hidden tracks off the public list but in the admin list', async () => {
    const cookie = await login();
    await upload(cookie, { title: 'Draft', hidden: true });
    expect(await (await req('/api/tracks')).json()).toEqual([]);
    const admin = await (await req('/api/admin/tracks', { headers: { Cookie: cookie } })).json();
    expect(admin.map((t) => t.title)).toEqual(['Draft']);
  });

  it('edits, reorders and deletes tracks', async () => {
    const cookie = await login();
    const a = await (await upload(cookie, { title: 'A' })).json();
    const b = await (await upload(cookie, { title: 'B' })).json();
    const json = { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' };

    // newest first
    let list = await (await req('/api/tracks')).json();
    expect(list.map((t) => t.title)).toEqual(['B', 'A']);

    await req('/api/admin/order', { method: 'PUT', headers: json, body: JSON.stringify({ ids: [a.id, b.id] }) });
    list = await (await req('/api/tracks')).json();
    expect(list.map((t) => t.title)).toEqual(['A', 'B']);

    const edited = await req(`/api/admin/tracks/${a.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ title: 'A2', note: 'new' }) });
    expect((await edited.json()).title).toBe('A2');

    expect((await req(`/api/admin/tracks/${a.id}`, { method: 'DELETE', headers: json })).status).toBe(200);
    expect(env.MEDIA.data.has(`audio:${a.id}`)).toBe(false);
    list = await (await req('/api/tracks')).json();
    expect(list.map((t) => t.title)).toEqual(['B']);
    expect((await req(`/api/admin/tracks/${a.id}`, { method: 'DELETE', headers: json })).status).toBe(404);
  });
});

describe('audio streaming', () => {
  it('serves the whole file and byte ranges for seeking', async () => {
    const cookie = await login();
    const { id } = await (await upload(cookie, { size: 1000 })).json();

    const full = await req(`/api/audio/${id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Type')).toBe('audio/mpeg');
    expect((await full.arrayBuffer()).byteLength).toBe(1000);

    const part = await req(`/api/audio/${id}`, { headers: { Range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 100-199/1000');
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const tail = await req(`/api/audio/${id}`, { headers: { Range: 'bytes=-50' } });
    expect(tail.headers.get('Content-Range')).toBe('bytes 950-999/1000');

    const bad = await req(`/api/audio/${id}`, { headers: { Range: 'bytes=5000-' } });
    expect(bad.status).toBe(416);
  });

  it('returns 404 for missing audio', async () => {
    expect((await req('/api/audio/does-not-exist')).status).toBe(404);
  });
});
