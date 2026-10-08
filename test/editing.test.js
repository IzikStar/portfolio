import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
afterEach(() => vi.unstubAllGlobals());

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));
async function entry(o, body) {
  const res = await call(o, '/api/studio/entries', 'POST', { status: 'published', visibility: 'public', ...body });
  expect(res.status).toBe(201);
  return res.json();
}
async function space(o, body) {
  const res = await call(o, '/api/studio/spaces', 'POST', { visibility: 'public', ...body });
  expect(res.status).toBe(201);
  return res.json();
}
async function member(o, username) {
  const { code } = await (await call(o, '/api/studio/invites', 'POST', {})).json();
  const res = await call(null, '/api/member/join', 'POST', { code, username, password: 'longenough' });
  const cookie = cookieOf(res);
  return { cookie, id: (await (await call(cookie, '/api/member/me')).json()).id };
}
const move = (cookie, body) => call(cookie, '/api/studio/entries/move', 'POST', body);
function upload(cookie, entryId, { type = '', name = 'song.cpr', size = 64 } = {}) {
  const form = new FormData();
  form.set('entryId', entryId);
  form.set('file', new File([new Uint8Array(size).fill(60)], name, { type }));
  return req('/api/studio/files', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN }, body: form });
}

describe('moving items', () => {
  it('is for the owner only', async () => {
    const o = await owner();
    const x = await entry(o, { kind: 'torah', title: 'Not really torah' });
    expect((await move(null, { ids: [x.id], spaceId: 'humor' })).status).toBe(401);
    const m = await member(o, 'dana');
    expect((await move(m.cookie, { ids: [x.id], spaceId: 'humor' })).status).toBe(401);
    const cross = await req('/api/studio/entries/move', { method: 'POST', headers: { Cookie: o, Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [x.id], spaceId: 'humor' }) });
    expect(cross.status).toBe(403);
    expect((await (await call(o, `/api/studio/entries/${x.id}`)).json()).spaceId).toBe('torah');
  });

  it('moves to another wing and space with a kind that fits, and refuses one that does not', async () => {
    const o = await owner();
    const x = await entry(o, { kind: 'torah', title: 'Funny one' });
    const series = await space(o, { parentId: 'humor', kind: 'series', title: 'Shorts' });
    expect((await move(o, { ids: [x.id], spaceId: series.id, kind: 'chapter' })).status).toBe(400);
    expect((await move(o, { ids: [x.id], spaceId: 'nowhere' })).status).toBe(400);
    expect((await move(o, { ids: ['gone'], spaceId: 'humor' })).status).toBe(404);

    // No kind: a torah item becomes the wing's first kind.
    const res = await move(o, { ids: [x.id], spaceId: series.id });
    expect(res.status).toBe(200);
    const [moved] = (await res.json()).entries;
    expect(moved).toMatchObject({ spaceId: series.id, kind: 'dub', slug: x.slug });
    const again = (await (await move(o, { ids: [x.id], spaceId: 'humor', kind: 'humor' })).json()).entries[0];
    expect(again).toMatchObject({ spaceId: 'humor', kind: 'humor' });
  });

  it('keeps slugs unique where the items land', async () => {
    const o = await owner();
    await entry(o, { kind: 'dub', title: 'Same', slug: 'same' });
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Book' });
    const other = await entry(o, { kind: 'chapter', title: 'Same', slug: 'same', spaceId: book.id });
    const a = await entry(o, { kind: 'torah', title: 'Same', slug: 'same' });
    const b = await entry(o, { kind: 'article', title: 'Same', slug: 'same' });
    // Into a wing where a dub already uses the slug: both need new ones, and differ from each other.
    const { entries } = await (await move(o, { ids: [a.id, b.id], spaceId: 'humor', kind: 'dub' })).json();
    const slugs = entries.map((x) => x.slug);
    expect(slugs).toEqual(['same-2', 'same-3']);
    // Same space, different kind: still unique within the space.
    const v = await entry(o, { kind: 'video', title: 'Same', slug: 'same', spaceId: 'videos' });
    const into = (await (await move(o, { ids: [v.id], spaceId: book.id, kind: 'chapter' })).json()).entries[0];
    expect(into.slug).not.toBe('same');
    expect(into.slug).not.toBe(other.slug);
  });

  it('sends the old address of a published item to its new one', async () => {
    const o = await owner();
    const x = await entry(o, { kind: 'torah', title: 'Vort', slug: 'vort' });
    const series = await space(o, { parentId: 'humor', kind: 'series', title: 'Shorts', slug: 'shorts' });
    expect((await req('/torah/vort')).status).toBe(200);
    const moved = (await (await move(o, { ids: [x.id], spaceId: series.id })).json()).entries[0];
    expect(moved.meta.oldPaths).toEqual(['/torah/vort']);

    const res = await req('/torah/vort');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/humor/shorts/vort');
    expect((await req('/humor/shorts/vort')).status).toBe(200);

    // Moving on keeps every old address working; moving back drops the one it now uses.
    await move(o, { ids: [x.id], spaceId: 'articles' });
    expect((await req('/torah/vort')).headers.get('Location')).toBe('/articles/vort');
    expect((await req('/humor/shorts/vort')).headers.get('Location')).toBe('/articles/vort');
    const back = (await (await move(o, { ids: [x.id], spaceId: 'torah', kind: 'torah' })).json()).entries[0];
    expect(back.meta.oldPaths).toEqual(['/articles/vort', '/humor/shorts/vort']);
    expect((await req('/torah/vort')).status).toBe(200);
  });

  it('redirects only for visitors who may see the item, and lets a new item take the old address', async () => {
    const o = await owner();
    const x = await entry(o, { kind: 'torah', title: 'Vort', slug: 'vort' });
    await move(o, { ids: [x.id], spaceId: 'articles' });
    await call(o, `/api/studio/entries/${x.id}`, 'PATCH', { visibility: 'community' });
    expect((await req('/torah/vort')).status).toBe(404);
    expect((await req('/torah/vort', { headers: { Cookie: o } })).status).toBe(301);

    await entry(o, { kind: 'torah', title: 'New vort', slug: 'vort' });
    const res = await req('/torah/vort');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('New vort');
  });

  it('does not remember addresses of drafts, and moves made by editing the space work the same', async () => {
    const o = await owner();
    const d = await entry(o, { kind: 'torah', title: 'Draft', slug: 'draft', status: 'draft' });
    const moved = (await (await move(o, { ids: [d.id], spaceId: 'articles' })).json()).entries[0];
    expect(moved.meta.oldPaths).toBeUndefined();

    const x = await entry(o, { kind: 'article', title: 'Essay', slug: 'essay' });
    const patched = await (await call(o, `/api/studio/entries/${x.id}`, 'PATCH', { spaceId: 'torah', kind: 'torah', meta: { oldPaths: ['/evil'] } })).json();
    expect(patched.meta.oldPaths).toEqual(['/articles/essay']);
    // The client cannot rewrite the list.
    const again = await (await call(o, `/api/studio/entries/${x.id}`, 'PATCH', { meta: { oldPaths: [] } })).json();
    expect(again.meta.oldPaths).toEqual(['/articles/essay']);
    expect((await req('/articles/essay')).headers.get('Location')).toBe('/torah/essay');
  });
});

describe('project files', () => {
  async function setup() {
    const o = await owner();
    const fans = (await (await call(o, '/api/studio/communities', 'POST', { title: 'Fans' })).json());
    const song = await entry(o, { kind: 'song', title: 'Song', slug: 'song', communities: [fans.id] });
    const files = {};
    for (const [name, type] of [['mix.cpr', ''], ['stems.zip', 'application/zip'], ['mix.bak', 'application/octet-stream'], ['all.cpr', '']]) {
      const res = await upload(o, song.id, { name, type });
      expect(res.status).toBe(201);
      files[name] = await res.json();
    }
    const projects = [
      { label: 'Owner mix', url: files['mix.cpr'].url, kind: 'cubase' },
      { label: 'Community stems', url: files['stems.zip'].url, kind: 'zip', visibility: 'community' },
      { label: 'Members backup', url: files['mix.bak'].url, kind: 'cubase', visibility: 'members' },
      { label: 'Drive project', url: 'https://drive.google.com/file/d/abcdefghijk12345/view?usp=drivesdk', kind: 'cubase', visibility: 'public' },
    ];
    await call(o, `/api/studio/entries/${song.id}`, 'PATCH', { meta: { projects } });
    const inside = await member(o, 'dana');
    await call(o, `/api/studio/communities/${fans.id}/members`, 'PATCH', { userId: inside.id, status: 'active' });
    const outside = await member(o, 'noa');
    return { o, song, files, inside, outside };
  }
  const page = async (cookie) => (await req('/music/song', cookie ? { headers: { Cookie: cookie } } : {})).text();

  it('lists each one only to who its visibility allows', async () => {
    const { o, inside, outside } = await setup();
    const mine = await page(o);
    for (const label of ['Owner mix', 'Community stems', 'Members backup', 'Drive project']) expect(mine).toContain(label);
    expect(mine).toContain('קבצי הפרויקט');

    const community = await page(inside.cookie);
    expect(community).not.toContain('Owner mix');
    expect(community).toContain('Community stems');
    expect(community).toContain('Members backup');

    const signedIn = await page(outside.cookie);
    expect(signedIn).not.toContain('Community stems');
    expect(signedIn).toContain('Members backup');

    const anon = await page(null);
    expect(anon).not.toContain('Members backup');
    expect(anon).not.toContain('Owner mix');
    expect(anon).toContain('Drive project');
  });

  it('serves uploaded project files as attachments, behind the same rule', async () => {
    const { o, files, inside, outside } = await setup();
    const get = (f, cookie) => req(f.url, cookie ? { headers: { Cookie: cookie } } : {});
    expect((await get(files['mix.cpr'], inside.cookie)).status).toBe(404);
    expect((await get(files['mix.cpr'], o)).status).toBe(200);
    expect((await get(files['stems.zip'], outside.cookie)).status).toBe(404);
    expect((await get(files['stems.zip'])).status).toBe(404);
    const res = await get(files['stems.zip'], inside.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="stems.zip"; filename*=UTF-8''stems.zip`);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toMatch(/private/);
    expect((await get(files['mix.bak'], outside.cookie)).status).toBe(200);
    // Not listed anywhere: owner only.
    expect((await get(files['all.cpr'], inside.cookie)).status).toBe(404);
  });
});

describe('download-only file types', () => {
  it('accepts .cpr, .bak and .zip as opaque downloads and keeps every other type to the safe list', async () => {
    const o = await owner();
    const x = await entry(o, { kind: 'song', title: 'Song' });
    for (const [name, type, kind] of [['a.cpr', '', 'cubase'], ['a.bak', '', 'cubase'], ['a.zip', 'application/x-zip-compressed', 'zip'], ['שיר.CPR', 'application/octet-stream', 'cubase']]) {
      const res = await upload(o, x.id, { name, type });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ type: 'application/octet-stream', kind: 'download', project: kind });
    }
    // A page in disguise is stored and served as bytes to download, never inline.
    const html = await (await upload(o, x.id, { name: 'evil.cpr', type: 'text/html' })).json();
    expect(html.type).toBe('application/octet-stream');
    const served = await req(html.url, { headers: { Cookie: o } });
    expect(served.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(served.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(served.headers.get('Content-Security-Policy')).toMatch(/sandbox/);
    const hebrew = (await (await req(`/api/studio/entries/${x.id}/files`, { headers: { Cookie: o } })).json()).files.find((f) => f.name === 'שיר.CPR');
    expect((await req(hebrew.url, { headers: { Cookie: o } })).headers.get('Content-Disposition')).toBe(`attachment; filename="___.CPR"; filename*=UTF-8''${encodeURIComponent('שיר.CPR')}`);

    for (const [name, type] of [['a.exe', 'application/octet-stream'], ['a.html', 'text/html'], ['a.svg', 'image/svg+xml'], ['a.cpr.txt', 'text/plain'], ['cpr', '']]) {
      expect((await upload(o, x.id, { name, type })).status).toBe(400);
    }
    // Media keeps its inline, typed serving.
    const png = await (await upload(o, x.id, { name: 'a.png', type: 'image/png' })).json();
    expect(png.kind).toBe('image');
    expect((await req(png.url, { headers: { Cookie: o } })).headers.get('Content-Disposition')).toBe('inline');
  });

  it('keeps the 95 MB cap for project files', async () => {
    const o = await owner();
    const x = await entry(o, { kind: 'song', title: 'Song' });
    expect((await upload(o, x.id, { name: 'big.cpr', size: 95 * 1024 * 1024 + 1 })).status).toBe(413);
  });
});

describe('studio link info', () => {
  it('reads titles of shared Drive files and YouTube videos, and never fails the batch', async () => {
    const o = await owner();
    const seen = [];
    vi.stubGlobal('fetch', async (url) => {
      seen.push(String(url));
      if (String(url).includes('youtube.com/oembed')) return Response.json({ title: 'Live at home' });
      if (String(url).includes('/file/d/sharedfile1234/')) return new Response('<html><head><meta property="og:title" content="Niggun &amp; drums.mp3"><title>Niggun &amp; drums.mp3 - Google Drive</title></head></html>');
      if (String(url).includes('/file/d/privatefile123/')) return new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/' } });
      throw new Error('network down');
    });
    const urls = [
      'https://drive.google.com/file/d/sharedfile1234/view?usp=sharing',
      'https://youtu.be/abcDEF12345',
      'https://drive.google.com/file/d/privatefile123/view?usp=drive_link',
      'https://drive.google.com/file/d/brokenfile1234/view',
      'https://drive.google.com/drive/folders/folder123456',
      'not a link',
    ];
    const res = await call(o, '/api/studio/link-info', 'POST', { urls });
    expect(res.status).toBe(200);
    const { links } = await res.json();
    expect(links).toHaveLength(6);
    expect(links[0]).toMatchObject({ source: 'drive', title: 'Niggun & drums', name: 'Niggun & drums.mp3', kind: 'audio' });
    expect(links[1]).toMatchObject({ source: 'youtube', title: 'Live at home', kind: 'video' });
    expect(links[2]).toMatchObject({ source: 'drive', title: null, private: true });
    expect(links[3]).toMatchObject({ source: 'drive', title: null });
    expect(links[4]).toMatchObject({ source: 'drive-folder' });
    expect(links[5]).toMatchObject({ source: null, title: null });
    expect(seen.some((u) => u.includes('folder123456'))).toBe(false);

    expect((await call(null, '/api/studio/link-info', 'POST', { urls })).status).toBe(401);
  });
});

describe('studio page preview', () => {
  it('renders unsaved changes as the chosen visitor would see them', async () => {
    const o = await owner();
    const x = await entry(o, { kind: 'song', title: 'Saved title' });
    const fans = (await (await call(o, '/api/studio/communities', 'POST', { title: 'Fans' })).json());
    const body = {
      id: x.id,
      communities: [fans.id],
      kind: 'song',
      spaceId: 'music',
      title: 'Unsaved title',
      body: '[Am]la la',
      visibility: 'public',
      meta: {
        versions: [{ label: 'Demo', url: 'https://youtu.be/abcDEF12345', visibility: 'community' }],
        projects: [{ label: 'Session', url: 'https://drive.google.com/file/d/abcdefghijk12345/view', kind: 'cubase', visibility: 'community' }],
      },
    };
    const mine = (await (await call(o, '/api/studio/preview-page', 'POST', body)).json()).html;
    expect(mine).toContain('Unsaved title');
    expect(mine).toContain('youtube-nocookie.com/embed/abcDEF12345');
    expect(mine).toContain('Session');
    const anon = (await (await call(o, '/api/studio/preview-page', 'POST', { ...body, as: 'public' })).json()).html;
    expect(anon).toContain('הגרסה הזאת פתוחה רק לקהילה');
    expect(anon).not.toContain('Session');
    const community = (await (await call(o, '/api/studio/preview-page', 'POST', { ...body, as: 'community' })).json()).html;
    expect(community).toContain('youtube-nocookie.com/embed/abcDEF12345');
    expect(community).toContain('Session');
    expect((await call(null, '/api/studio/preview-page', 'POST', body)).status).toBe(401);
  });
});
