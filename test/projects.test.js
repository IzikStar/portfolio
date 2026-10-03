import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { CV_PROJECTS } from '../src/cv-seed.js';

const ORIGIN = 'https://site.test';
let env;
let calls;

// A tiny GitHub + web stand-in for fetch.
function fakeFetch(routes) {
  return vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, headers: init.headers ?? {} });
    const hit = routes[url];
    if (!hit) return new Response('nope', { status: 404 });
    const { status = 200, body, type = 'application/json' } = typeof hit === 'function' ? hit(init) : hit;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
  });
}

const REPO = {
  'https://api.github.com/repos/IzikStar/MasterMindTS': {
    body: { name: 'MasterMindTS', description: 'Mastermind with a solver', topics: ['typescript', 'game'], homepage: 'https://izikstar.github.io/MasterMindTS/', html_url: 'https://github.com/IzikStar/MasterMindTS', private: false, stargazers_count: 3, pushed_at: '2026-10-01T10:00:00Z', default_branch: 'main' },
  },
  'https://api.github.com/repos/IzikStar/MasterMindTS/languages': { body: { TypeScript: 100, CSS: 10 } },
  'https://api.github.com/repos/IzikStar/MasterMindTS/readme': { body: '# MasterMind\n\n![shot](docs/shot.png)\n\nSee [LICENSE](LICENSE).', type: 'text/plain' },
  'https://example.com/my-song': {
    body: '<html><head><title>Fallback</title><meta property="og:title" content="My Song &amp; Me"><meta property="og:description" content="A song."><meta property="og:image" content="/cover.jpg"></head></html>',
    type: 'text/html',
  },
};

beforeEach(() => {
  calls = [];
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async () => new Response('not found page') },
  };
  vi.stubGlobal('fetch', fakeFetch(REPO));
});
afterEach(() => vi.unstubAllGlobals());

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
async function owner() {
  const res = await req('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }) });
  return res.headers.get('Set-Cookie').split(';')[0];
}
const studio = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

async function project(cookie, extra = {}) {
  const res = await studio(cookie, '/api/studio/entries', 'POST', {
    kind: 'project',
    title: '',
    visibility: 'public',
    status: 'draft',
    meta: { source: { type: 'github', repo: 'IzikStar/MasterMindTS' }, cv: { show: true, order: 1 } },
    ...extra,
  });
  if (res.status !== 201) throw new Error(await res.text());
  return res.json();
}

describe('syncing from GitHub', () => {
  it('pulls the description, topics, languages, homepage and README', async () => {
    const o = await owner();
    const p = await project(o, { title: 'MasterMind' });
    const res = await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST');
    expect(res.status).toBe(200);
    const s = (await res.json()).meta.synced;
    expect(s).toMatchObject({ description: 'Mastermind with a solver', topics: ['typescript', 'game'], languages: ['TypeScript', 'CSS'], homepage: 'https://izikstar.github.io/MasterMindTS/', stars: 3, branch: 'main' });
    expect(s.readme).toContain('# MasterMind');
    expect(calls[0].headers['User-Agent']).toBeTruthy();
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('sends the token when one is set', async () => {
    env.GITHUB_TOKEN = 'ghp_test';
    const o = await owner();
    const p = await project(o, { title: 'x' });
    await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST');
    expect(calls[0].headers.Authorization).toBe('Bearer ghp_test');
  });

  it('explains a missing or private repo', async () => {
    const o = await owner();
    const p = await project(o, { title: 'x', meta: { source: { type: 'github', repo: 'IzikStar/secret' } } });
    const res = await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/GITHUB_TOKEN/);
  });

  it('explains rate limiting', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'https://api.github.com/repos/IzikStar/MasterMindTS': { status: 403, body: {} } }));
    const o = await owner();
    const p = await project(o, { title: 'x' });
    const res = await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/rate-limiting/);
  });

  it('keeps synced data away from the client and keeps it across saves', async () => {
    const o = await owner();
    const p = await project(o, { title: 'x' });
    const synced = (await (await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST')).json()).meta;
    const res = await studio(o, `/api/studio/entries/${p.id}`, 'PATCH', { meta: { ...synced, synced: { description: 'forged' }, tag: 'Games' } });
    const saved = await res.json();
    expect(saved.meta.tag).toBe('Games');
    expect(saved.meta.synced.description).toBe('Mastermind with a solver');
  });

  it('rejects bad sources', async () => {
    const o = await owner();
    for (const source of [{ type: 'github', repo: '../../etc' }, { type: 'url', url: 'javascript:alert(1)' }, { type: 'ftp', url: 'x' }]) {
      const res = await studio(o, '/api/studio/entries', 'POST', { kind: 'project', title: 'x', meta: { source } });
      expect(res.status).toBe(400);
    }
  });
});

describe('syncing from a web page', () => {
  it('reads the Open Graph title, description and image', async () => {
    const o = await owner();
    const p = await project(o, { kind: 'work', title: '', meta: { source: { type: 'url', url: 'https://example.com/my-song' } } });
    const s = (await (await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST')).json()).meta.synced;
    expect(s).toMatchObject({ name: 'My Song & Me', description: 'A song.', image: 'https://example.com/cover.jpg' });
  });
});

describe('what visitors see', () => {
  it('fills empty fields from the source and lets the owner override them', async () => {
    const o = await owner();
    const p = await project(o, { title: 'MasterMind', status: 'published' });
    await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST');

    let { projects } = await (await req('/api/cv-projects')).json();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: { he: 'MasterMind' }, text: { he: 'Mastermind with a solver', en: 'Mastermind with a solver' }, stack: ['typescript', 'game'] });
    expect(projects[0].links).toEqual([
      { k: 'live', href: 'https://izikstar.github.io/MasterMindTS/' },
      { k: 'code', href: 'https://github.com/IzikStar/MasterMindTS' },
    ]);

    const meta = (await (await studio(o, `/api/studio/entries/${p.id}`)).json()).meta;
    await studio(o, `/api/studio/entries/${p.id}`, 'PATCH', { summary: 'משחק עם פותר', tags: ['TypeScript', 'Vite'], meta: { ...meta, en: { summary: 'A game with a solver' } } });
    ({ projects } = await (await req('/api/cv-projects')).json());
    expect(projects[0]).toMatchObject({ text: { he: 'משחק עם פותר', en: 'A game with a solver' }, stack: ['TypeScript', 'Vite'] });
  });

  it('only puts public, published, CV-marked projects on the CV, in order', async () => {
    const o = await owner();
    await project(o, { title: 'Second', status: 'published', meta: { cv: { show: true, order: 2 } } });
    await project(o, { title: 'First', status: 'published', meta: { cv: { show: true, order: 1 } } });
    await project(o, { title: 'Hidden', status: 'published', meta: { cv: { show: false } } });
    await project(o, { title: 'Draft', meta: { cv: { show: true, order: 0 } } });
    await project(o, { title: 'Members', status: 'published', visibility: 'members', meta: { cv: { show: true, order: 0 } } });
    const { projects } = await (await req('/api/cv-projects')).json();
    expect(projects.map((p) => p.name.he)).toEqual(['First', 'Second']);
  });

  it('renders /work and a project page with the README resolved against the repo', async () => {
    const o = await owner();
    const p = await project(o, { title: 'MasterMind', slug: 'mastermind', status: 'published' });
    await studio(o, `/api/studio/entries/${p.id}/sync`, 'POST');
    const index = await (await req('/software')).text();
    expect(index).toContain('MasterMind');
    const page = await (await req('/software/mastermind')).text();
    expect(page).toContain('https://raw.githubusercontent.com/IzikStar/MasterMindTS/main/docs/shot.png');
    expect(page).toContain('https://github.com/IzikStar/MasterMindTS/blob/main/LICENSE');
    expect((await req('/software/nothing-here')).status).toBe(404);
  });

  it('drops unsafe images and links', async () => {
    const o = await owner();
    await project(o, { title: 'Bad', status: 'published', meta: { image: 'javascript:alert(1)', links: [{ k: 'code', href: 'javascript:alert(1)' }], cv: { show: true, order: 1 } } });
    const { projects } = await (await req('/api/cv-projects')).json();
    expect(projects[0].img).toBe('');
    expect(projects[0].links).toEqual([]);
  });
});

describe('importing the CV projects', () => {
  it('creates every CV project once, public and in the CV order', async () => {
    const o = await owner();
    const first = await (await studio(o, '/api/studio/import-cv', 'POST')).json();
    expect(first).toEqual({ created: CV_PROJECTS.length, total: CV_PROJECTS.length });
    expect((await (await studio(o, '/api/studio/import-cv', 'POST')).json()).created).toBe(0);
    const { projects } = await (await req('/api/cv-projects')).json();
    expect(projects.map((p) => p.name.he)).toEqual(CV_PROJECTS.map((p) => p.title));
    expect(projects[0].links.length).toBeGreaterThan(0);
  });

  it('is owner-only', async () => {
    expect((await req('/api/studio/import-cv', { method: 'POST' })).status).toBe(401);
  });
});

describe('daily sync', () => {
  it('refreshes every project with a source and records failures on the item', async () => {
    const o = await owner();
    const good = await project(o, { title: 'Good' });
    const bad = await project(o, { title: 'Bad', meta: { source: { type: 'github', repo: 'IzikStar/gone' } } });
    await project(o, { title: 'No source', meta: {} });
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const g = await (await studio(o, `/api/studio/entries/${good.id}`)).json();
    const b = await (await studio(o, `/api/studio/entries/${bad.id}`)).json();
    expect(g.meta.synced.description).toBe('Mastermind with a solver');
    expect(b.meta.syncError).toMatch(/GitHub has no such/);
  });
});
