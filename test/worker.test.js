import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { MAX_FILE_BYTES } from '../src/limits.js';

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

function uploadForm({ section = 'music', title = 'Song', size = 1000, type = 'audio/mpeg', hidden = false, link = '', file = true } = {}) {
  const form = new FormData();
  form.set('section', section);
  form.set('title', title);
  form.set('note', 'Recorded at home');
  form.set('link', link);
  if (file) form.set('file', new File([new Uint8Array(size).fill(7)], 'song.mp3', { type }));
  form.set('duration', '183.4');
  form.set('hidden', String(hidden));
  return form;
}

async function upload(cookie, opts) {
  return req('/api/admin/items', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN }, body: uploadForm(opts) });
}

const site = async () => (await req('/api/site')).json();

describe('public routes', () => {
  it('serves static assets for non-API paths', async () => {
    expect(await (await req('/styles.css')).text()).toBe('asset');
  });

  it('starts with every section on and no items', async () => {
    const data = await site();
    expect(data.items).toEqual([]);
    expect(Object.values(data.sections).every(Boolean)).toBe(true);
    expect(Object.keys(data.sections)).toEqual(['code', 'music', 'voice', 'sketches', 'writing', 'about', 'contact']);
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
    expect((await req('/api/admin/site')).status).toBe(401);
    expect((await req('/api/admin/session')).status).toBe(401);
  });

  it('rejects a forged or expired cookie', async () => {
    const future = Date.now() + 3600_000;
    expect((await req('/api/admin/site', { headers: { Cookie: `admin_session=${future}.forged` } })).status).toBe(401);
    const cookie = await login();
    const sig = cookie.split('.')[1];
    expect((await req('/api/admin/site', { headers: { Cookie: `admin_session=${Date.now() - 1000}.${sig}` } })).status).toBe(401);
  });

  it('stops working when the password changes', async () => {
    const cookie = await login();
    env.ADMIN_PASSWORD = 'a new password';
    expect((await req('/api/admin/site', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('blocks cross-site writes even with a valid cookie', async () => {
    const cookie = await login();
    const res = await req('/api/admin/site', {
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

describe('items', () => {
  it('uploads a file and shows it publicly without private fields', async () => {
    const cookie = await login();
    const res = await upload(cookie, { title: '  שיר ראשון  ' });
    expect(res.status).toBe(201);
    const item = await res.json();
    expect(item.title).toBe('שיר ראשון');
    expect(item.kind).toBe('audio');
    expect(item.duration).toBe(183);

    const { items } = await site();
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('fileName');
    expect(items[0]).not.toHaveProperty('hidden');
  });

  it('accepts a link without a file, in any creative section', async () => {
    const cookie = await login();
    const res = await upload(cookie, { section: 'sketches', file: false, link: 'https://youtu.be/abc' });
    expect(res.status).toBe(201);
    expect((await res.json()).kind).toBe('link');
    expect((await upload(cookie, { section: 'voice', type: 'video/mp4' })).status).toBe(201);
    expect((await upload(cookie, { section: 'writing', type: 'application/pdf' })).status).toBe(201);
    const { items } = await site();
    expect(items.map((i) => [i.section, i.kind])).toEqual([['writing', 'pdf'], ['voice', 'video'], ['sketches', 'link']]);
  });

  it('rejects bad input', async () => {
    const cookie = await login();
    expect((await upload(cookie, { type: 'text/html' })).status).toBe(400);
    expect((await upload(cookie, { type: 'image/svg+xml' })).status).toBe(400);
    expect((await upload(cookie, { size: MAX_FILE_BYTES + 1 })).status).toBe(413);
    expect((await upload(cookie, { title: '   ' })).status).toBe(400);
    expect((await upload(cookie, { section: 'code' })).status).toBe(400);
    expect((await upload(cookie, { file: false })).status).toBe(400);
    expect((await upload(cookie, { file: false, link: 'javascript:alert(1)' })).status).toBe(400);
  });

  it('keeps hidden items off the public site but in the admin list', async () => {
    const cookie = await login();
    await upload(cookie, { title: 'Draft', hidden: true });
    expect((await site()).items).toEqual([]);
    const admin = await (await req('/api/admin/site', { headers: { Cookie: cookie } })).json();
    expect(admin.items.map((t) => t.title)).toEqual(['Draft']);
  });

  it('edits, reorders within a section and deletes', async () => {
    const cookie = await login();
    const a = await (await upload(cookie, { title: 'A' })).json();
    const x = await (await upload(cookie, { title: 'X', section: 'voice' })).json();
    const b = await (await upload(cookie, { title: 'B' })).json();
    const json = { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' };
    const titles = async () => (await site()).items.map((t) => t.title);

    expect(await titles()).toEqual(['B', 'X', 'A']);
    await req('/api/admin/order', { method: 'PUT', headers: json, body: JSON.stringify({ ids: [a.id, b.id] }) });
    expect(await titles()).toEqual(['A', 'X', 'B']);

    const edited = await req(`/api/admin/items/${a.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ title: 'A2', section: 'writing' }) });
    expect(await edited.json()).toMatchObject({ title: 'A2', section: 'writing' });
    const noLink = await req(`/api/admin/items/${x.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ link: 'ftp://x' }) });
    expect(noLink.status).toBe(400);

    expect((await req(`/api/admin/items/${a.id}`, { method: 'DELETE', headers: json })).status).toBe(200);
    expect(env.MEDIA.data.has(`file:${a.id}`)).toBe(false);
    expect(await titles()).toEqual(['X', 'B']);
    expect((await req(`/api/admin/items/${a.id}`, { method: 'DELETE', headers: json })).status).toBe(404);
  });
});

describe('section settings', () => {
  it('turns sections off for the public site and hides their items', async () => {
    const cookie = await login();
    await upload(cookie, { section: 'music' });
    await upload(cookie, { section: 'voice' });
    const json = { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' };
    const res = await req('/api/admin/settings', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ sections: { music: false, code: false, bogus: false, voice: 'yes' }, intros: { voice: '  שלום  ', code: 'x' } }),
    });
    expect(res.status).toBe(200);
    const data = await site();
    expect(data.sections).toMatchObject({ music: false, code: false, voice: true, writing: true });
    expect(data.sections).not.toHaveProperty('bogus');
    expect(data.intros).toEqual({ music: '', voice: 'שלום', sketches: '', writing: '' });
    expect(data.items.map((i) => i.section)).toEqual(['voice']);
  });

  it('requires a session to change settings', async () => {
    const res = await req('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ sections: { code: false } }) });
    expect(res.status).toBe(401);
  });
});

describe('file streaming', () => {
  it('serves the whole file and byte ranges for seeking', async () => {
    const cookie = await login();
    const { id } = await (await upload(cookie, { size: 1000 })).json();

    const full = await req(`/api/file/${id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(full.headers.get('Content-Security-Policy')).toMatch(/sandbox/);
    expect((await full.arrayBuffer()).byteLength).toBe(1000);

    const part = await req(`/api/file/${id}`, { headers: { Range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 100-199/1000');
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const tail = await req(`/api/file/${id}`, { headers: { Range: 'bytes=-50' } });
    expect(tail.headers.get('Content-Range')).toBe('bytes 950-999/1000');

    const bad = await req(`/api/file/${id}`, { headers: { Range: 'bytes=5000-' } });
    expect(bad.status).toBe(416);
  });

  it('returns 404 for missing files', async () => {
    expect((await req('/api/file/does-not-exist')).status).toBe(404);
  });
});

describe('custom domains', () => {
  it('redirects the secondary domains to the main address, keeping path and query', async () => {
    for (const host of ['izikstar.com', 'www.izikstar.com', 'www.itschakshteren.com']) {
      const res = await worker.fetch(new Request(`https://${host}/admin?x=1`), env);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://itschakshteren.com/admin?x=1');
    }
  });

  it('serves the main address and workers.dev without redirecting', async () => {
    for (const host of ['itschakshteren.com', 'portfolio.itschakme.workers.dev']) {
      const res = await worker.fetch(new Request(`https://${host}/cv`), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('asset');
    }
  });
});
