import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';

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


describe('public routes', () => {
  it('serves static assets for non-API paths', async () => {
    expect(await (await req('/styles.css')).text()).toBe('asset');
  });

  it('no longer has the old admin page or its item routes', async () => {
    const res = await req('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/studio#cv`);
    expect((await req('/admin.html')).headers.get('Location')).toBe(`${ORIGIN}/studio#cv`);
    const cookie = await login();
    for (const [path, method] of [['/api/site', 'GET'], ['/api/file/x', 'GET'], ['/api/cover/x', 'GET'], ['/api/admin/site', 'GET'], ['/api/admin/items', 'POST'], ['/api/admin/settings', 'PUT'], ['/api/admin/order', 'PUT']]) {
      expect((await req(path, { method, headers: { Cookie: cookie, Origin: ORIGIN } })).status).toBe(404);
    }
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

  it('blocks owner routes without a session', async () => {
    expect((await req('/api/admin/session')).status).toBe(401);
    expect((await req('/api/studio/cv')).status).toBe(401);
  });

  it('rejects a forged or expired cookie', async () => {
    const future = Date.now() + 3600_000;
    expect((await req('/api/admin/session', { headers: { Cookie: `admin_session=${future}.forged` } })).status).toBe(401);
    const cookie = await login();
    const sig = cookie.split('.')[1];
    expect((await req('/api/admin/session', { headers: { Cookie: `admin_session=${Date.now() - 1000}.${sig}` } })).status).toBe(401);
  });

  it('stops working when the password changes', async () => {
    const cookie = await login();
    expect((await req('/api/admin/session', { headers: { Cookie: cookie } })).status).toBe(200);
    env.ADMIN_PASSWORD = 'a new password';
    expect((await req('/api/admin/session', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('blocks cross-site writes even with a valid cookie', async () => {
    const cookie = await login();
    const res = await req('/api/admin/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.test' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses to log anyone in when no password is configured', async () => {
    delete env.ADMIN_PASSWORD;
    const res = await req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: '' }) });
    expect(res.status).toBe(503);
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
      const res = await worker.fetch(new Request(`https://${host}/og.png`), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('asset');
    }
  });
});
