import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { DEFAULT_SPARKS } from '../src/ideas.js';

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
    ASSETS: { fetch: async () => new Response('asset') },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => (await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD })).headers.get('Set-Cookie').split(';')[0];

function capture(cookie, fields = {}, file = null) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set('file', new File([new Uint8Array(file.size ?? 50).fill(3)], file.name, { type: file.type }));
  return req('/api/studio/ideas', { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN }, body: form });
}
const ideas = async (cookie) => (await (await call(cookie, '/api/studio/ideas')).json()).ideas;

describe('capturing ideas', () => {
  it('saves text with a wing, tags and the spark it answers, private to the owner', async () => {
    const o = await owner();
    const res = await capture(o, { text: 'שיר על רכבת לילה', wing: 'music', tags: 'שיר, לילה', spark: 'שיר שכולו שאלות' });
    expect(res.status).toBe(201);
    const idea = await res.json();
    expect(idea).toMatchObject({ kind: 'idea', visibility: 'private', status: 'draft', spaceId: null, tags: ['שיר', 'לילה'], files: [] });
    expect(idea.meta).toMatchObject({ wing: 'music', spark: 'שיר שכולו שאלות' });
    expect((await ideas(o)).map((i) => i.id)).toEqual([idea.id]);
  });

  it('saves a voice memo alone, attached to the idea, without the codec in its type', async () => {
    const o = await owner();
    const res = await capture(o, {}, { name: 'memo.webm', type: 'audio/webm;codecs=opus', size: 400 });
    expect(res.status).toBe(201);
    const idea = await res.json();
    expect(idea.body).toBe('');
    expect(idea.files).toHaveLength(1);
    expect(idea.files[0]).toMatchObject({ kind: 'audio', type: 'audio/webm', size: 400, name: 'memo.webm' });
    const [listed] = await ideas(o);
    expect(listed.files.map((f) => f.id)).toEqual([idea.files[0].id]);
    const audio = await req(idea.files[0].url, { headers: { Cookie: o } });
    expect(audio.status).toBe(200);
    expect(audio.headers.get('Content-Type')).toBe('audio/webm');
    // Nobody else hears it.
    expect((await req(idea.files[0].url)).status).toBe(404);
  });

  it('refuses an empty idea, an unknown wing, a bad file and strangers', async () => {
    const o = await owner();
    expect((await capture(o, { text: '   ' })).status).toBe(400);
    expect((await capture(o, { text: 'x', wing: 'cooking' })).status).toBe(400);
    expect((await capture(o, { text: 'x' }, { name: 'a.html', type: 'text/html' })).status).toBe(400);
    expect((await call(o, '/api/studio/ideas', 'POST', { text: 'json, not a form' })).status).toBe(400);
    expect((await capture(null, { text: 'x' })).status).toBe(401);
    expect((await call(null, '/api/studio/ideas')).status).toBe(401);
    expect(await ideas(o)).toEqual([]);
  });

  it('keeps ideas out of the public feed and the wings', async () => {
    const o = await owner();
    await capture(o, { text: 'סוד', wing: 'music' });
    expect(await (await req('/music')).text()).not.toContain('סוד');
  });
});

describe('tending an idea', () => {
  it('sets and clears its wing and adds and drops notes without touching the rest', async () => {
    const o = await owner();
    const idea = await (await capture(o, { text: 'מערכון על תור', spark: 'ראיון עבודה' })).json();
    let res = await call(o, `/api/studio/ideas/${idea.id}`, 'PATCH', { wing: 'sketches', note: 'אולי בדואר' });
    expect(res.status).toBe(200);
    let got = await res.json();
    expect(got.meta.wing).toBe('sketches');
    expect(got.meta.spark).toBe('ראיון עבודה');
    expect(got.meta.notes.map((n) => n.text)).toEqual(['אולי בדואר']);

    got = await (await call(o, `/api/studio/ideas/${idea.id}`, 'PATCH', { note: 'הפקיד יודע הכל' })).json();
    expect(got.meta.notes).toHaveLength(2);
    got = await (await call(o, `/api/studio/ideas/${idea.id}`, 'PATCH', { dropNote: got.meta.notes[0].at, wing: '' })).json();
    expect(got.meta.notes.map((n) => n.text)).toEqual(['הפקיד יודע הכל']);
    expect(got.meta.wing).toBeUndefined();
    expect(got.body).toBe('מערכון על תור');

    expect((await call(o, `/api/studio/ideas/${idea.id}`, 'PATCH', { note: ' ' })).status).toBe(400);
    expect((await call(o, `/api/studio/ideas/${idea.id}`, 'PATCH', { wing: 'cooking' })).status).toBe(400);
    expect((await call(o, `/api/studio/ideas/${idea.id}`, 'PATCH', { dropNote: 'nope' })).status).toBe(404);
    expect((await call(o, '/api/studio/ideas/nope', 'PATCH', { note: 'x' })).status).toBe(404);
  });
});

describe('growing an idea into a draft', () => {
  it('moves text, notes, pictures and recordings into a private draft in the chosen space', async () => {
    const o = await owner();
    const idea = await (await capture(o, { text: 'כשהאור בחדר נגמר\nבית ראשון כאן', wing: 'music', spark: 'שורה ראשונה' }, { name: 'tune.webm', type: 'audio/webm' })).json();
    const form = new FormData();
    form.set('entryId', idea.id);
    form.set('file', new File([new Uint8Array(20)], 'room.jpg', { type: 'image/jpeg' }));
    const pic = await (await req('/api/studio/files', { method: 'POST', headers: { Cookie: o, Origin: ORIGIN }, body: form })).json();
    await call(o, `/api/studio/ideas/${idea.id}`, 'PATCH', { note: 'פזמון בשקט' });
    await call(o, `/api/studio/entries/${idea.id}`, 'PATCH', { pinned: true });

    const res = await call(o, `/api/studio/ideas/${idea.id}/grow`, 'POST', { spaceId: 'music', kind: 'song' });
    expect(res.status).toBe(200);
    const draft = await res.json();
    expect(draft).toMatchObject({ id: idea.id, kind: 'song', spaceId: 'music', title: 'כשהאור בחדר נגמר', status: 'draft', visibility: 'private', pinned: false });
    expect(draft.body).toBe(`בית ראשון כאן\n\nפזמון בשקט\n\n![room.jpg](${pic.url})`);
    expect(draft.meta.versions).toEqual([{ label: 'הקלטה', url: idea.files[0].url, kind: 'audio' }]);
    expect(draft.meta.idea).toEqual({ capturedAt: idea.createdAt, spark: 'שורה ראשונה' });
    expect(draft.meta.wing).toBeUndefined();
    expect(draft.meta.notes).toBeUndefined();
    // It left the notebook and its files went with it.
    expect(await ideas(o)).toEqual([]);
    const files = await (await call(o, `/api/studio/entries/${idea.id}/files`)).json();
    expect(files.files).toHaveLength(2);
  });

  it('names a recording-only idea after the file and keeps a long first line whole', async () => {
    const o = await owner();
    const memo = await (await capture(o, {}, { name: 'הקלטה 3.10.webm', type: 'audio/webm' })).json();
    const a = await (await call(o, `/api/studio/ideas/${memo.id}/grow`, 'POST', { spaceId: 'humor', kind: 'dub' })).json();
    expect(a.title).toBe('הקלטה 3.10');
    expect(a.body).toBe('');

    const long = 'מילה '.repeat(40).trim();
    const idea = await (await capture(o, { text: long })).json();
    const b = await (await call(o, `/api/studio/ideas/${idea.id}/grow`, 'POST', { spaceId: 'articles', kind: 'article' })).json();
    expect(b.title.endsWith('...')).toBe(true);
    expect(b.title.length).toBeLessThanOrEqual(83);
    expect(b.body).toBe(long);
  });

  it('refuses an unknown kind or space, and anything that is not an idea', async () => {
    const o = await owner();
    const idea = await (await capture(o, { text: 'x' })).json();
    expect((await call(o, `/api/studio/ideas/${idea.id}/grow`, 'POST', { spaceId: 'music', kind: 'poem' })).status).toBe(400);
    expect((await call(o, `/api/studio/ideas/${idea.id}/grow`, 'POST', { spaceId: 'music', kind: 'idea' })).status).toBe(400);
    expect((await call(o, `/api/studio/ideas/${idea.id}/grow`, 'POST', { spaceId: 'nowhere', kind: 'song' })).status).toBe(400);
    const article = await (await call(o, '/api/studio/entries', 'POST', { kind: 'article', title: 'T' })).json();
    expect((await call(o, `/api/studio/ideas/${article.id}/grow`, 'POST', { spaceId: 'articles', kind: 'article' })).status).toBe(404);
    expect((await call(o, `/api/studio/ideas/${article.id}`, 'PATCH', { note: 'x' })).status).toBe(404);
    expect((await call(null, `/api/studio/ideas/${idea.id}/grow`, 'POST', { spaceId: 'music', kind: 'song' })).status).toBe(401);
  });
});

describe('sparks', () => {
  it('starts from the defaults, saves the owner list in settings and resets', async () => {
    const o = await owner();
    let got = await (await call(o, '/api/studio/sparks')).json();
    expect(got).toEqual({ sparks: DEFAULT_SPARKS, own: false });
    for (const wing of ['music', 'books', 'sketches', 'humor', 'torah']) expect(DEFAULT_SPARKS.some((s) => s.wing === wing)).toBe(true);

    const res = await call(o, '/api/studio/sparks', 'PUT', { sparks: [{ wing: 'torah', text: ' שאלה על הפרשה ' }, { text: 'בלי אגף' }, { wing: 'music', text: '' }] });
    expect(res.status).toBe(200);
    got = await (await call(o, '/api/studio/sparks')).json();
    expect(got).toEqual({ own: true, sparks: [{ wing: 'torah', text: 'שאלה על הפרשה' }, { wing: 'any', text: 'בלי אגף' }] });

    expect((await call(o, '/api/studio/sparks', 'PUT', { sparks: [{ wing: 'cooking', text: 'x' }] })).status).toBe(400);
    expect((await call(o, '/api/studio/sparks', 'PUT', { sparks: 'x' })).status).toBe(400);
    expect((await call(null, '/api/studio/sparks', 'PUT', { sparks: [] })).status).toBe(401);

    got = await (await call(o, '/api/studio/sparks', 'PUT', { sparks: [] })).json();
    expect(got.own).toBe(false);
    expect((await (await call(o, '/api/studio/sparks')).json()).sparks).toEqual(DEFAULT_SPARKS);
  });
});
