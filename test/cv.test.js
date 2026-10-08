import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { _resetLegacyMemo } from '../src/cv.js';

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
  _resetLegacyMemo();
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
const cvHtml = async (path = '/cv', headers = {}) => (await req(path, { headers })).text();
async function entry(o, body) {
  const res = await call(o, '/api/studio/entries', 'POST', { visibility: 'public', status: 'published', ...body });
  if (res.status !== 201) throw new Error(await res.text());
  return res.json();
}
const studioCv = async (o) => (await call(o, '/api/studio/cv')).json();
const saveCv = (o, cv) => call(o, '/api/studio/cv', 'PUT', { cv });

describe('the CV page', () => {
  it('says what the defaults say until the owner edits it', async () => {
    const res = await req('/cv');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<html lang="he" dir="rtl">');
    expect(html).toContain('<h1>יצחק שטרן</h1>');
    expect(html).toContain('פנוי לעבודה מדצמבר 2026');
    expect(html).toContain('תשתית רגרסיה שבודקת כ־120,000 מקרים הנדסיים');
    // The projects that were written into the old page, until they are imported.
    expect(html).toContain('טובים');
    expect(html).toContain('https://github.com/IzikStar/izik-star-chess-engine');
    expect(html).toContain('mailto:itschakme@gmail.com');
    expect(html).toContain('"@type":"Person"');
    expect(html).toContain('<link rel="canonical" href="https://itschakshteren.com/cv">');
    // Sections with nothing in them stay out.
    expect(html).not.toContain('id="music"');
  });

  it('stands on its own: no links into the platform', async () => {
    const html = await cvHtml();
    const local = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    expect(local.every((h) => /^\/cv(\?lang=(he|en))?$|^\/cv\.css$/.test(h))).toBe(true);
  });

  it('speaks English by query, by cookie and by browser language', async () => {
    expect(await cvHtml('/cv?lang=en')).toContain('<h1>Itschak Shteren</h1>');
    expect(await cvHtml('/cv', { Cookie: 'cv_lang=en' })).toContain('lang="en" dir="ltr"');
    expect(await cvHtml('/cv', { 'Accept-Language': 'en-US,en;q=0.9' })).toContain('Available from December 2026');
    expect(await cvHtml('/cv', { 'Accept-Language': 'he-IL,he;q=0.9' })).toContain('פנוי לעבודה');
    expect(await cvHtml('/cv?lang=he', { Cookie: 'cv_lang=en' })).toContain('lang="he"');
  });
});

describe('editing the CV in the studio', () => {
  it('is for the owner only', async () => {
    expect((await call(null, '/api/studio/cv')).status).toBe(401);
    expect((await saveCv(null, { name: { he: 'x', en: 'x' } })).status).toBe(401);
    expect((await call(null, '/api/studio/cv/preview', 'POST', { cv: {} })).status).toBe(401);
  });

  it('starts from the defaults and saves every part of the page', async () => {
    const o = await owner();
    const data = await studioCv(o);
    expect(data.cv.name).toEqual({ he: 'יצחק שטרן', en: 'Itschak Shteren' });
    expect(data.cv.sections.map((s) => s.id)).toEqual(['code', 'music', 'voice', 'sketches', 'writing', 'about', 'contact']);
    expect(data.seeded).toBe(true);

    const cv = data.cv;
    cv.avail = { he: 'פנוי מחר', en: 'Free tomorrow' };
    cv.roles = [{ he: 'מפתח Backend', en: 'Backend developer' }];
    cv.buttons = [{ label: { he: 'צרו קשר', en: 'Contact' }, href: '#contact' }];
    cv.skills = ['Go', 'Rust'];
    cv.timeline = [{ when: { he: '2027', en: '2027' }, what: { he: 'משהו חדש', en: 'Something new' }, detail: { he: '', en: '' } }];
    cv.contact = [{ label: { he: 'יוטיוב', en: 'YouTube' }, href: 'https://youtube.com/@x' }];
    // About first, projects hidden.
    cv.sections = [cv.sections.find((s) => s.id === 'about'), ...cv.sections.filter((s) => s.id !== 'about')];
    cv.sections.find((s) => s.id === 'code').show = false;
    cv.sections.find((s) => s.id === 'about').title = { he: 'מי אני', en: '' };
    const res = await saveCv(o, cv);
    expect(res.status).toBe(200);

    const html = await cvHtml();
    expect(html).toContain('פנוי מחר');
    expect(html).toContain('<span>מפתח Backend</span>');
    expect(html).not.toContain('מוזיקאי');
    expect(html).toContain('href="#contact"');
    expect(html).toContain('<li>Rust</li>');
    expect(html).toContain('משהו חדש');
    expect(html).toContain('https://youtube.com/@x');
    expect(html).not.toContain('id="code"');
    expect(html.indexOf('id="about"')).toBeLessThan(html.indexOf('id="contact"'));
    expect(html).toContain('מי אני');
    // An empty English title falls back to the default one.
    expect(await cvHtml('/cv?lang=en')).toContain('>About</h2>');
    // The studio reads back what it saved.
    expect((await studioCv(o)).cv.skills).toEqual(['Go', 'Rust']);
  });

  it('refuses links that could run script or do not parse', async () => {
    const o = await owner();
    expect((await saveCv(o, { buttons: [{ label: { he: 'x', en: 'x' }, href: 'javascript:alert(1)' }] })).status).toBe(400);
    expect((await saveCv(o, { contact: [{ label: { he: 'x', en: 'x' }, href: 'not a link' }] })).status).toBe(400);
    expect((await saveCv(o, { email: 'nope' })).status).toBe(400);
    // A section id it does not know is dropped; a forgotten one comes back at the end.
    await saveCv(o, { sections: [{ id: 'evil', show: true }, { id: 'contact', show: true, title: { he: 'כתבו', en: 'Write' } }] });
    const { cv } = await studioCv(o);
    expect(cv.sections[0].id).toBe('contact');
    expect(cv.sections).toHaveLength(7);
  });

  it('picks and orders the projects, and only public published ones show', async () => {
    const o = await owner();
    const a = await entry(o, { kind: 'project', title: 'Alpha', meta: { cv: { show: true, order: 1 } } });
    const b = await entry(o, { kind: 'project', title: 'Beta', meta: { cv: { show: true, order: 2 } } });
    const c = await entry(o, { kind: 'project', title: 'Gamma', status: 'draft' });
    let data = await studioCv(o);
    expect(data.seeded).toBe(false);
    expect(data.cv.projects).toEqual([a.id, b.id]);
    expect(await cvHtml()).not.toContain('טובים');

    await saveCv(o, { ...data.cv, projects: [b.id, c.id] });
    const html = await cvHtml();
    expect(html).toContain('Beta');
    expect(html).not.toContain('Alpha');
    expect(html).not.toContain('Gamma');
    // The flags live on the entries, where the project editor sees them too.
    const alpha = await (await call(o, `/api/studio/entries/${a.id}`)).json();
    const gamma = await (await call(o, `/api/studio/entries/${c.id}`)).json();
    expect(alpha.meta.cv.show).toBe(false);
    expect(gamma.meta.cv).toEqual({ show: true, order: 2 });
    data = await studioCv(o);
    expect(data.cv.projects).toEqual([b.id, c.id]);
    expect(data.entries.find((e) => e.id === c.id)).toMatchObject({ shows: false, section: 'code' });
  });

  it('fills the creative sections with the picked items, without leading into the platform', async () => {
    const o = await owner();
    const song = await entry(o, {
      kind: 'song',
      title: 'שיר בדיקה',
      summary: 'הוקלט בבית',
      body: 'מילים\n\n[לעמוד אחר באתר](/music/x) [בספוטיפיי](https://open.spotify.com/track/1)',
      meta: { versions: [{ label: 'הקלטה', url: 'https://example.com/song.mp3', kind: 'audio' }, { label: 'לקהילה', url: 'https://example.com/secret.mp3', visibility: 'community' }] },
    });
    const sketch = await entry(o, { kind: 'sketch', title: 'מערכון', meta: { versions: [{ label: 'סרטון', url: 'https://youtu.be/abcdefghijk' }] } });
    const hidden = await entry(o, { kind: 'song', title: 'שיר פרטי', visibility: 'private' });
    const { cv } = await studioCv(o);
    expect(cv.items.music).toEqual([]);
    await saveCv(o, { items: { music: [hidden.id, song.id], sketches: [sketch.id] } });

    const html = await cvHtml();
    expect(html).toContain('id="music"');
    expect(html).toContain('שיר בדיקה');
    expect(html).toContain('data-src="https://example.com/song.mp3"');
    expect(html).not.toContain('secret.mp3');
    expect(html).toContain('https://open.spotify.com/track/1');
    expect(html).not.toContain('href="/music/x"');
    expect(html).not.toContain('שיר פרטי');
    expect(html).toContain('youtube-nocookie.com/embed/abcdefghijk');
    expect((await studioCv(o)).cv.items.music).toEqual([hidden.id, song.id]);
  });

  it('previews an unsaved form without saving it', async () => {
    const o = await owner();
    const { cv } = await studioCv(o);
    cv.name = { he: 'טיוטה', en: 'Draft' };
    const res = await call(o, '/api/studio/cv/preview', 'POST', { cv, lang: 'en' });
    const { html } = await res.json();
    expect(html).toContain('<h1>Draft</h1>');
    expect(html).toContain('noindex');
    expect(await cvHtml()).toContain('<h1>יצחק שטרן</h1>');
  });
});

describe('moving off the old admin page', () => {
  async function oldAdmin() {
    await env.MEDIA.put('file:a', new Uint8Array([1, 2, 3]).buffer, { metadata: { type: 'audio/mpeg' } });
    await env.MEDIA.put('items', JSON.stringify([
      { id: 'b', section: 'music', title: 'Second song', kind: 'link', link: 'https://youtu.be/abcdefghijk', hasFile: false, hidden: false, createdAt: '2024-07-01T00:00:00.000Z' },
      { id: 'a', section: 'music', title: 'First song', kind: 'audio', hasFile: true, fileName: 'a.mp3', hidden: false, createdAt: '2024-06-01T00:00:00.000Z' },
      { id: 'h', section: 'voice', title: 'Hidden dub', kind: 'link', link: 'https://youtu.be/abcdefghijk', hasFile: false, hidden: true },
    ]));
    await env.MEDIA.put('settings', JSON.stringify({ sections: { voice: false, sketches: true }, intros: { music: 'שירים שכתבתי' } }));
  }

  it('moves the items once on the first visit, keeps their order on the CV and deletes nothing', async () => {
    await oldAdmin();
    const html = await cvHtml();
    expect(html).toContain('id="music"');
    expect(html).toContain('שירים שכתבתי');
    expect(html.indexOf('Second song')).toBeLessThan(html.indexOf('First song'));
    expect(html).toMatch(/data-src="\/files\/[a-z0-9-]+"/);
    expect(html).not.toContain('Hidden dub');
    // Its section switches carried over: voice was off, so its role went too.
    const o = await owner();
    const data = await studioCv(o);
    expect(data.cv.sections.find((s) => s.id === 'voice').show).toBe(false);
    expect(data.cv.roles.map((r) => r.en)).not.toContain('Voice actor');
    expect(data.legacy).toMatchObject({ state: 'done', created: 3, total: 3 });
    expect((await (await call(o, '/api/studio/settings')).json()).legacy.state).toBe('done');

    // Once only, and the old copies stay.
    _resetLegacyMemo();
    await cvHtml();
    await call(o, '/api/admin/session');
    const { entries } = await (await call(o, '/api/studio/entries?kind=song')).json();
    expect(entries).toHaveLength(2);
    expect(env.MEDIA.data.has('items')).toBe(true);
    expect(env.MEDIA.data.has('file:a')).toBe(true);
    // The manual button still works and finds nothing new.
    expect(await (await call(o, '/api/studio/import-legacy', 'POST', {})).json()).toMatchObject({ created: [], skipped: 3 });
  });

  it('also runs when the owner opens the studio, and gives the claim back if it fails', async () => {
    await oldAdmin();
    const get = env.MEDIA.get.bind(env.MEDIA);
    env.MEDIA.get = async () => {
      throw new Error('KV is down');
    };
    const o = await owner();
    await call(o, '/api/admin/session');
    expect((await studioCv(o)).legacy).toBeNull();
    env.MEDIA.get = get;
    expect((await call(o, '/api/admin/session')).status).toBe(200);
    expect((await studioCv(o)).legacy).toMatchObject({ state: 'done', created: 3 });
  });

  it('runs from the daily cron too', async () => {
    await oldAdmin();
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const o = await owner();
    expect((await studioCv(o)).legacy).toMatchObject({ state: 'done' });
  });
});
