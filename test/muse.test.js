import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { MODEL } from '../src/muse.js';

const ORIGIN = 'https://site.test';
let env;
let sent;
let answer;
let stop;
const realFetch = globalThis.fetch;

// An SSE stream the way the Messages API sends it: thinking first, then text.
function sse(text, stopReason) {
  const events = [
    { type: 'message_start', message: { model: MODEL } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ...text.match(/.{1,7}/gsu).map((t) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
    { type: 'message_delta', delta: { stop_reason: stopReason } },
    { type: 'message_stop' },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  // Split mid-event to check the parser joins chunks.
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 53) c.enqueue(bytes.slice(i, i + 53));
      c.close();
    },
  });
}

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null, put: async () => {}, delete: async () => {} },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ANTHROPIC_API_KEY: 'sk-test',
    ASSETS: { fetch: async () => new Response('asset') },
  };
  sent = [];
  answer = 'כיוון ראשון: הרכבת היא בעצם חלום.\nכיוון שני: מערכון.';
  stop = 'end_turn';
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/')) {
      sent.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response(sse(answer, stop), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (u.startsWith('https://www.hebcal.com/')) {
      return Response.json({ items: [{ title: 'Parashat Bereshit', hebrew: 'פרשת בראשית', date: '2026-10-10', category: 'parashat' }] });
    }
    return realFetch(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil() {} });
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => (await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD })).headers.get('Set-Cookie').split(';')[0];
async function capture(cookie, text, wing = '') {
  const form = new FormData();
  form.set('text', text);
  if (wing) form.set('wing', wing);
  return (await req('/api/studio/ideas', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN }, body: form })).json();
}
const ideas = async (cookie) => (await (await call(cookie, '/api/studio/ideas')).json()).ideas;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('the writing partner on one idea', () => {
  it('streams the answer, sends the idea to Fable with fallbacks on, and keeps the answer on the idea', async () => {
    const o = await owner();
    const idea = await capture(o, 'שיר על רכבת לילה', 'music');
    const res = await call(o, `/api/studio/ideas/${idea.id}/muse`, 'POST', { mode: 'directions' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    expect(await res.text()).toBe(answer);
    await settle();

    const [{ headers, body }] = sent;
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(headers['x-api-key']).toBe('sk-test');
    expect(body).toMatchObject({ model: 'claude-fable-5-1', fallbacks: 'default', stream: true, output_config: { effort: 'high' } });
    expect('thinking' in body).toBe(false);
    expect(body.messages[0].content).toContain('שיר על רכבת לילה');
    expect(body.messages[0].content).toContain('מוזיקה');

    const [saved] = await ideas(o);
    expect(saved.meta.muse).toHaveLength(1);
    expect(saved.meta.muse[0]).toMatchObject({ mode: 'directions', text: answer.trim() });
  });

  it('takes his own request, and the next call knows what was already suggested', async () => {
    const o = await owner();
    const idea = await capture(o, 'מערכון על פקיד');
    await (await call(o, `/api/studio/ideas/${idea.id}/muse`, 'POST', { mode: 'ask', ask: 'תהפוך את זה לשיר' })).text();
    await settle();
    expect(sent[0].body.messages[0].content).toContain('תהפוך את זה לשיר');
    await (await call(o, `/api/studio/ideas/${idea.id}/muse`, 'POST', { mode: 'questions' })).text();
    await settle();
    expect(sent[1].body.messages[0].content).toContain('<earlier>');
    expect(sent[1].body.output_config.effort).toBe('medium');
    const [saved] = await ideas(o);
    expect(saved.meta.muse.map((m) => m.mode)).toEqual(['ask', 'questions']);

    const res = await call(o, `/api/studio/ideas/${idea.id}/muse`, 'DELETE', { at: saved.meta.muse[0].at });
    expect((await res.json()).meta.muse.map((m) => m.mode)).toEqual(['questions']);
  });

  it('says so on a refusal and keeps nothing', async () => {
    const o = await owner();
    const idea = await capture(o, 'משהו');
    stop = 'refusal';
    const text = await (await call(o, `/api/studio/ideas/${idea.id}/muse`, 'POST', { mode: 'write' })).text();
    expect(text.endsWith('⟂refusal')).toBe(true);
    await settle();
    expect((await ideas(o))[0].meta.muse).toBeUndefined();
  });

  it('is owner only, and explains the missing key', async () => {
    const o = await owner();
    const idea = await capture(o, 'משהו');
    expect((await call(null, `/api/studio/ideas/${idea.id}/muse`, 'POST', {})).status).toBe(401);
    delete env.ANTHROPIC_API_KEY;
    const res = await call(o, `/api/studio/ideas/${idea.id}/muse`, 'POST', {});
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('ANTHROPIC_API_KEY');
    expect((await (await call(o, '/api/studio/ideas/pulse')).json()).ready).toBe(false);
  });
});

describe('new directions', () => {
  it('reads the new ideas against the old ones and keeps the pulse until it is seen', async () => {
    const o = await owner();
    await capture(o, 'שיר על רכבת', 'music');
    await capture(o, 'דיבוב לחתולים', 'humor');
    let p = await (await call(o, '/api/studio/ideas/pulse')).json();
    expect(p).toMatchObject({ pulse: null, newSince: 2, ready: true });

    expect(await (await call(o, '/api/studio/ideas/pulse', 'POST')).text()).toBe(answer);
    await settle();
    expect(sent[0].body.messages[0].content).toContain('דיבוב לחתולים');
    p = await (await call(o, '/api/studio/ideas/pulse')).json();
    expect(p.pulse).toMatchObject({ text: answer.trim(), count: 2, seen: false });
    expect(p.newSince).toBe(0);

    await call(o, '/api/studio/ideas/pulse/seen', 'POST');
    expect((await (await call(o, '/api/studio/ideas/pulse')).json()).pulse.seen).toBe(true);
  });

  it('runs from the cron only when something new came in', async () => {
    const o = await owner();
    let jobs = [];
    const ctx = { waitUntil: (p) => jobs.push(p) };
    await worker.scheduled({}, env, ctx);
    await Promise.all(jobs);
    // Nothing new: only the weekly draft was written.
    expect(sent).toHaveLength(1);
    expect(sent[0].body.messages[0].content).toContain('פרשת בראשית');

    await capture(o, 'רעיון חדש');
    jobs = [];
    await worker.scheduled({}, env, ctx);
    await Promise.all(jobs);
    expect(sent).toHaveLength(2);
    expect(sent[1].body.messages[0].content).toContain('רעיון חדש');
  });
});

describe("the week's parasha", () => {
  it('lands once a week as a pinned torah idea, and not again after it is deleted', async () => {
    const o = await owner();
    const res = await call(o, '/api/studio/ideas/weekly', 'POST');
    expect(res.status).toBe(201);
    const idea = await res.json();
    expect(idea).toMatchObject({ kind: 'idea', pinned: true, title: 'פרשת בראשית: טיוטה שמחכה לך', body: answer.trim(), tags: ['פרשת שבוע'] });
    expect(idea.meta).toMatchObject({ wing: 'torah', weekly: { parasha: 'Parashat Bereshit', date: '2026-10-10' } });

    expect((await call(o, '/api/studio/ideas/weekly', 'POST')).status).toBe(409);
    await call(o, `/api/studio/entries/${idea.id}`, 'DELETE');
    const jobs = [];
    await worker.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
    await Promise.all(jobs);
    expect(await ideas(o)).toHaveLength(0);
  });
});
