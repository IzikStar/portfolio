import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { slugify } from '../src/entries.js';
import { renderMarkdown } from '../src/markdown.js';

const ORIGIN = 'https://site.test';
let env;

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async (r) => new Response(new URL(r.url).pathname === '/404.html' ? 'not found page' : 'asset') },
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

const send = (cookie, path, method, body) =>
  req(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function create(cookie, body) {
  const res = await send(cookie, '/api/studio/entries', 'POST', body);
  expect(res.status).toBe(201);
  return res.json();
}

describe('owner session', () => {
  it('is a site-wide cookie and clears the old /api/admin one', async () => {
    const res = await req('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    });
    const cookies = res.headers.getSetCookie();
    expect(cookies[0]).toMatch(/Path=\/;/);
    expect(cookies[0]).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(cookies[1]).toMatch(/Path=\/api\/admin; .*Max-Age=0/);
  });

  it('keeps the studio API closed without a session', async () => {
    expect((await req('/api/studio/entries')).status).toBe(401);
    const res = await req('/api/studio/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"idea","body":"x"}' });
    expect(res.status).toBe(401);
  });

  it('blocks cross-site writes to the studio', async () => {
    const cookie = await login();
    const res = await req('/api/studio/entries', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'idea', body: 'x' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('ideas', () => {
  it('saves, lists, searches, pins and deletes ideas', async () => {
    const cookie = await login();
    const a = await create(cookie, { kind: 'idea', body: 'A song about trains', tags: 'music, #trains, music' });
    expect(a).toMatchObject({ kind: 'idea', visibility: 'private', status: 'draft', tags: ['music', 'trains'] });
    const b = await create(cookie, { kind: 'idea', body: 'Sketch: the 100% honest waiter' });

    let list = await (await req('/api/studio/entries?kind=idea', { headers: { Cookie: cookie } })).json();
    expect(list.entries.map((e) => e.id)).toEqual([b.id, a.id]);

    await send(cookie, `/api/studio/entries/${a.id}`, 'PATCH', { pinned: true });
    list = await (await req('/api/studio/entries?kind=idea', { headers: { Cookie: cookie } })).json();
    expect(list.entries[0].id).toBe(a.id);

    list = await (await req('/api/studio/entries?kind=idea&q=trains', { headers: { Cookie: cookie } })).json();
    expect(list.entries.map((e) => e.id)).toEqual([a.id]);
    // LIKE wildcards in the query are literal
    list = await (await req(`/api/studio/entries?kind=idea&q=${encodeURIComponent('100%')}`, { headers: { Cookie: cookie } })).json();
    expect(list.entries.map((e) => e.id)).toEqual([b.id]);
    list = await (await req(`/api/studio/entries?kind=idea&q=${encodeURIComponent('%')}`, { headers: { Cookie: cookie } })).json();
    expect(list.entries.map((e) => e.id)).toEqual([b.id]);

    expect((await req(`/api/studio/entries/${a.id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN } })).status).toBe(200);
    expect((await req(`/api/studio/entries/${a.id}`, { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it('rejects empty items and unknown kinds', async () => {
    const cookie = await login();
    expect((await send(cookie, '/api/studio/entries', 'POST', { kind: 'idea', body: '   ' })).status).toBe(400);
    expect((await send(cookie, '/api/studio/entries', 'POST', { kind: 'spaceship', body: 'x' })).status).toBe(400);
    expect((await send(cookie, '/api/studio/entries', 'POST', { body: 'x' })).status).toBe(400);
  });

  it('never shows ideas to visitors', async () => {
    const cookie = await login();
    await create(cookie, { kind: 'idea', body: 'secret', visibility: 'public', status: 'published', title: 'Secret' });
    expect((await req('/api/entries?kind=idea')).status).toBe(400);
  });
});

describe('articles', () => {
  it('turns an idea into an article and publishes it with a slug from the title', async () => {
    const cookie = await login();
    const idea = await create(cookie, { kind: 'idea', body: 'First thoughts' });
    const res = await send(cookie, `/api/studio/entries/${idea.id}`, 'PATCH', { kind: 'article', title: 'שיר על רכבות', status: 'published', visibility: 'public' });
    const article = await res.json();
    expect(article).toMatchObject({ kind: 'article', slug: 'שיר-על-רכבות', status: 'published' });
    expect(article.publishedAt).toBeTruthy();
  });

  it('refuses to publish without a title', async () => {
    const cookie = await login();
    const a = await create(cookie, { kind: 'article', body: 'text only' });
    expect((await send(cookie, `/api/studio/entries/${a.id}`, 'PATCH', { status: 'published' })).status).toBe(400);
  });

  it('keeps slugs unique per kind', async () => {
    const cookie = await login();
    await create(cookie, { kind: 'article', title: 'Hello', slug: 'hello' });
    expect((await send(cookie, '/api/studio/entries', 'POST', { kind: 'article', title: 'Again', slug: 'Hello!' })).status).toBe(409);
    expect((await send(cookie, '/api/studio/entries', 'POST', { kind: 'project', title: 'Hello', slug: 'hello' })).status).toBe(201);
  });

  it('numbers a slug made from a title that is already taken', async () => {
    const cookie = await login();
    const one = await create(cookie, { kind: 'article', title: 'Same title', status: 'published' });
    const two = await create(cookie, { kind: 'article', title: 'Same title', status: 'published' });
    expect([one.slug, two.slug]).toEqual(['same-title', 'same-title-2']);
  });

  it('refuses to overwrite a newer save', async () => {
    const cookie = await login();
    const a = await create(cookie, { kind: 'article', title: 'Draft' });
    expect((await send(cookie, `/api/studio/entries/${a.id}`, 'PATCH', { body: 'one', baseUpdatedAt: a.updatedAt })).status).toBe(200);
    const res = await send(cookie, `/api/studio/entries/${a.id}`, 'PATCH', { body: 'stale', baseUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect((await (await req(`/api/studio/entries/${a.id}`, { headers: { Cookie: cookie } })).json()).body).toBe('one');
  });

  it('shows each visitor only what they may see', async () => {
    const cookie = await login();
    const pub = await create(cookie, { kind: 'article', title: 'Public one', body: '**hi**', visibility: 'public', status: 'published' });
    await create(cookie, { kind: 'article', title: 'Members one', visibility: 'members', status: 'published' });
    await create(cookie, { kind: 'article', title: 'Private one', visibility: 'private', status: 'published' });
    await create(cookie, { kind: 'article', title: 'Draft one', visibility: 'public' });

    const anon = await (await req('/api/entries?kind=article')).json();
    expect(anon.entries.map((e) => e.title)).toEqual(['Public one']);
    expect(anon.entries[0].summary).toBe('hi');
    expect(anon.entries[0].body).toBeUndefined();

    const owner = await (await req('/api/entries?kind=article', { headers: { Cookie: cookie } })).json();
    expect(owner.entries).toHaveLength(3);

    const page = await req(`/articles/${encodeURIComponent(pub.slug)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toMatch(/text\/html/);
    const text = await page.text();
    expect(text).toContain('<strong>hi</strong>');
    expect(text).not.toContain('noindex');

    expect((await req('/articles/members-one')).status).toBe(404);
    expect((await req('/articles/private-one')).status).toBe(404);
    expect((await req('/articles/draft-one')).status).toBe(404);
    const ownerView = await req('/articles/private-one', { headers: { Cookie: cookie } });
    expect(ownerView.status).toBe(200);
    expect(await ownerView.text()).toContain('noindex');

    const index = await (await req('/articles')).text();
    expect(index).toContain('Public one');
    expect(index).not.toContain('Members one');
    expect(index).not.toContain('Private one');
  });

  it('escapes titles on the public pages', async () => {
    const cookie = await login();
    const a = await create(cookie, { kind: 'article', title: '<script>alert(1)</script>', slug: 'x', visibility: 'public', status: 'published' });
    const text = await (await req(`/articles/${a.slug}`)).text();
    expect(text).not.toContain('<script>alert(1)</script>');
    expect(text).toContain('&lt;script&gt;');
  });

  it('renders a preview for the editor', async () => {
    const cookie = await login();
    const res = await send(cookie, '/api/studio/preview', 'POST', { body: '## Title' });
    expect((await res.json()).html).toContain('<h2');
  });
});

describe('markdown safety', () => {
  it('shows raw HTML as text', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops javascript: links and images but keeps safe ones', () => {
    const html = renderMarkdown('[a](javascript:alert(1)) [b](https://example.com) [c](/writing) ![d](javascript:x) ![e](data:image/png;base64,AAA)');
    expect(html).not.toMatch(/javascript:|data:/);
    expect(html).toContain('href="https://example.com/" rel="noopener nofollow"');
    expect(html).toContain('href="/writing"');
  });

  it('escapes quotes in link attributes', () => {
    const html = renderMarkdown('[x](https://example.com/" onmouseover="alert(1) "t")');
    expect(html).not.toContain('" onmouseover="');
  });
});

describe('slugify', () => {
  it('keeps letters in any script and joins words with dashes', () => {
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
    expect(slugify('מאמר ראשון: על רעיונות')).toBe('מאמר-ראשון-על-רעיונות');
    expect(slugify('!!!')).toBe('');
  });
});
