import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { renderChords, hasChords } from '../src/chords.js';
import { mediaEmbed, youtubeId, driveId } from '../src/media.js';

const ORIGIN = 'https://site.test';
let env;

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`, { status: new URL(r.url).pathname === '/404.html' ? 200 : 200 }) },
  };
});

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));
const page = async (path, cookie) => {
  const res = await call(cookie, path);
  return { status: res.status, text: await res.text(), res };
};
async function entry(o, body) {
  const res = await call(o, '/api/studio/entries', 'POST', { status: 'published', visibility: 'public', ...body });
  expect(res.status).toBe(201);
  return res.json();
}
async function space(o, body) {
  const res = await call(o, '/api/studio/spaces', 'POST', body);
  expect(res.status).toBe(201);
  return res.json();
}
async function member(o, username) {
  const { code } = await (await call(o, '/api/studio/invites', 'POST', {})).json();
  const res = await call(null, '/api/member/join', 'POST', { code, username, password: 'longenough' });
  const cookie = cookieOf(res);
  return { cookie, id: (await (await call(cookie, '/api/member/me')).json()).id };
}

describe('addresses', () => {
  it('serves the platform at / and the CV at /cv', async () => {
    const home = await page('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('האגפים');
    expect(home.text).toContain('href="/music"');
    expect((await page('/cv')).text).toBe('asset:/index.html');
    expect((await req('/cv/')).headers.get('Location')).toBe(`${ORIGIN}/cv`);
  });

  it('sends the old addresses to the new ones', async () => {
    expect((await req('/writing')).headers.get('Location')).toBe(`${ORIGIN}/articles`);
    expect((await req('/writing/x')).headers.get('Location')).toBe(`${ORIGIN}/articles/x`);
    expect((await req('/work/chess')).headers.get('Location')).toBe(`${ORIGIN}/software/chess`);
  });

  it('answers 404 for unknown items and leaves other paths to the static site', async () => {
    expect((await page('/music/nothing')).text).toBe('asset:/404.html');
    expect((await page('/styles.css')).text).toBe('asset:/styles.css');
  });
});

describe('a wing', () => {
  it('lists its items and says what stays closed', async () => {
    const o = await owner();
    await entry(o, { kind: 'song', title: 'Open song', body: '[Am]la la' });
    await entry(o, { kind: 'song', title: 'Demo only', visibility: 'community' });
    const anon = await page('/music');
    expect(anon.text).toContain('Open song');
    expect(anon.text).not.toContain('Demo only');
    expect(anon.text).toContain('עוד 1 פריטים פתוחים רק לקהילה');
    expect(anon.text).toContain('/join?space=music');
    expect(anon.res.headers.get('Cache-Control')).toBe('public, max-age=60');

    const m = await member(o, 'dana');
    expect((await page('/music', m.cookie)).text).toContain('data-join="music"');
    await call(o, '/api/studio/spaces/music/members', 'PATCH', { userId: m.id, status: 'active' });
    const inside = await page('/music', m.cookie);
    expect(inside.text).toContain('Demo only');
    expect(inside.res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('is hidden when the owner makes it private', async () => {
    const o = await owner();
    await call(o, '/api/studio/spaces/humor', 'PATCH', { visibility: 'private' });
    expect((await page('/humor')).text).toBe('asset:/404.html');
    expect((await page('/')).text).not.toContain('href="/humor"');
    expect((await page('/humor', o)).status).toBe(200);
  });
});

describe('a book', () => {
  it('shows open chapters, counts the closed ones, and opens them to beta readers', async () => {
    const o = await owner();
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Gargamitz', visibility: 'public', summary: 'A story' });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'One', body: 'First words', meta: { order: 1 } });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'Two', body: 'Secret words', visibility: 'community', meta: { order: 2 } });

    const anon = await page('/books/gargamitz');
    expect(anon.text).toContain('Gargamitz');
    expect(anon.text).toContain('href="/books/gargamitz/one"');
    expect(anon.text).not.toContain('/books/gargamitz/two');
    expect(anon.text).toContain('עוד 1 פרקים');
    expect((await page('/books/gargamitz/two')).text).toBe('asset:/404.html');

    const reader = await member(o, 'reader');
    await call(o, `/api/studio/spaces/${book.id}/members`, 'PATCH', { userId: reader.id, status: 'active' });
    const two = await page('/books/gargamitz/two', reader.cookie);
    expect(two.status).toBe(200);
    expect(two.text).toContain('Secret words');
    expect(two.text).toContain('href="/books/gargamitz/one"');
    expect(two.text).toContain('noindex');
  });

  it('stays out of sight while private', async () => {
    const o = await owner();
    await space(o, { parentId: 'books', kind: 'book', title: 'Hidden' });
    expect((await page('/books/hidden')).text).toBe('asset:/404.html');
    expect((await page('/books')).text).not.toContain('Hidden');
    expect((await page('/books/hidden', o)).status).toBe(200);
  });
});

describe('a song', () => {
  it('shows the chord sheet and its versions, and keeps community versions locked', async () => {
    const o = await owner();
    await entry(o, {
      kind: 'song',
      title: 'Ma\'aseh',
      body: '{c: בית}\n[Am]שלום [F]עולם\nC   G\nשורה שנייה',
      meta: {
        capo: '2',
        versions: [
          { label: 'הקלטה', url: 'https://drive.google.com/file/d/1AqeoQQOknTv5Zv9Y6j9HkmHIcRbGzDho/view?usp=drivesdk', kind: 'audio' },
          { label: 'סרטון', url: 'https://youtu.be/dQw4w9WgXcQ' },
          { label: 'דמו', url: 'https://youtu.be/abcdefghijk', visibility: 'community' },
        ],
      },
    });
    const { text } = await page('/music/ma-aseh');
    expect(text).toContain('מילים ואקורדים');
    expect(text).toContain('קאפו 2');
    expect(text).toContain('<span class="ch">Am</span>');
    expect(text).toContain('drive.google.com/file/d/1AqeoQQOknTv5Zv9Y6j9HkmHIcRbGzDho/preview');
    expect(text).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(text).not.toContain('abcdefghijk');
    expect(text).toContain('הגרסה הזאת פתוחה רק לקהילה');
    expect((await page('/music/ma-aseh', o)).text).toContain('abcdefghijk');
  });
});

describe('chord sheets', () => {
  it('puts inline chords over their words and keeps chord lines', () => {
    const html = renderChords('[Am]שלום [F]עולם\nC  G/B  Dm7\nמילים <b>');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('<span class="seg"><span class="ch">Am</span><span>שלום </span></span>');
    expect(html).toContain('<div class="line chordline"><span class="ch">C</span>  <span class="ch">G/B</span>  <span class="ch">Dm7</span></div>');
    expect(html).toContain('מילים &lt;b&gt;');
  });

  it('handles choruses and comments, and knows plain lyrics', () => {
    const html = renderChords('{soc}\nla\n{eoc}\n{c: Bridge}');
    expect(html).toContain('<div class="chorus"><div class="line">la</div></div>');
    expect(html).toContain('<div class="comment">Bridge</div>');
    expect(html).toContain('dir="ltr"');
    expect(hasChords('just words\nAnd More')).toBe(false);
    expect(hasChords('Am F\nwords')).toBe(true);
    expect(hasChords('[G]words')).toBe(true);
  });
});

describe('media', () => {
  it('recognizes YouTube and Drive addresses', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=abc123def45')).toBe('abc123def45');
    expect(youtubeId('https://youtube.com/shorts/abc123def45')).toBe('abc123def45');
    expect(driveId('https://drive.google.com/file/d/1AqeoQQOknTv5Zv9Y6j9HkmHIcRbGzDho/view')).toBe('1AqeoQQOknTv5Zv9Y6j9HkmHIcRbGzDho');
    expect(driveId('https://example.com/file/d/xyz')).toBe(null);
  });

  it('plays site files and refuses unsafe addresses', () => {
    expect(mediaEmbed('/files/abc', { kind: 'audio' })).toContain('<audio controls');
    expect(mediaEmbed('https://x.test/a.mp4')).toContain('<video controls');
    expect(mediaEmbed('javascript:alert(1)')).toBe('');
    expect(mediaEmbed('https://x.test/page', { title: '<x>' })).toContain('&lt;x&gt;');
  });
});
