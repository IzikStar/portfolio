import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    const cv = await page('/cv');
    expect(cv.status).toBe(200);
    expect(cv.text).toContain('<h1>יצחק שטרן</h1>');
    expect((await req('/cv/')).headers.get('Location')).toBe(`${ORIGIN}/cv`);
    expect((await req('/admin')).headers.get('Location')).toBe(`${ORIGIN}/studio#cv`);
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
    const fans = (await (await call(o, '/api/studio/communities', 'POST', { title: 'Fans' })).json());
    await entry(o, { kind: 'song', title: 'Demo only', visibility: 'community', communities: [fans.id] });
    const anon = await page('/music');
    expect(anon.text).toContain('Open song');
    expect(anon.text).not.toContain('Demo only');
    expect(anon.text).toContain('עוד פריט אחד פתוח רק לקהילות');
    expect(anon.text).toContain(`/join?community=${fans.id}`);
    expect(anon.res.headers.get('Cache-Control')).toBe('public, max-age=60');

    const m = await member(o, 'dana');
    expect((await page('/music', m.cookie)).text).toContain(`data-join="${fans.id}"`);
    await call(o, `/api/studio/communities/${fans.id}/members`, 'PATCH', { userId: m.id, status: 'active' });
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
    const fans = (await (await call(o, '/api/studio/communities', 'POST', { title: 'Fans' })).json());
    const book = await space(o, { parentId: 'books', kind: 'book', title: 'Gargamitz', visibility: 'public', summary: 'A story', communities: [fans.id] });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'One', body: 'First words', meta: { order: 1 } });
    await entry(o, { kind: 'chapter', spaceId: book.id, title: 'Two', body: 'Secret words', visibility: 'community', meta: { order: 2 } });

    const anon = await page('/books/gargamitz');
    expect(anon.text).toContain('Gargamitz');
    expect(anon.text).toContain('href="/books/gargamitz/one"');
    expect(anon.text).not.toContain('/books/gargamitz/two');
    expect(anon.text).toContain('עוד פרק אחד');
    expect((await page('/books/gargamitz/two')).text).toBe('asset:/404.html');

    const reader = await member(o, 'reader');
    expect((await page('/books/gargamitz', reader.cookie)).text).toContain('קריאת בטא');
    await call(o, `/api/studio/communities/${fans.id}/members`, 'PATCH', { userId: reader.id, status: 'active' });
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
    const fans = (await (await call(o, '/api/studio/communities', 'POST', { title: 'Fans' })).json());
    await entry(o, {
      kind: 'song',
      title: 'Ma\'aseh',
      communities: [fans.id],
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
    expect(text).toContain('<audio controls preload="metadata" src="/media/drive/1AqeoQQOknTv5Zv9Y6j9HkmHIcRbGzDho?k=audio"');
    expect(text).toContain('drive.google.com/file/d/1AqeoQQOknTv5Zv9Y6j9HkmHIcRbGzDho/view');
    expect(text).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(text).not.toContain('abcdefghijk');
    expect(text).toContain('הגרסה הזאת פתוחה רק לקהילה');
    expect((await page('/music/ma-aseh', o)).text).toContain('abcdefghijk');
  });
});

describe('Drive recordings in the site\'s own player', () => {
  const ID = '1AqeoQQOknTv5Zv9Y6j9HkmHIcRbGzDho';
  const LOCKED = '1LockedLockedLockedLocked00';
  let asked;
  beforeEach(() => {
    asked = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      asked.push({ url: String(url), range: init.headers?.Range });
      if (String(url).includes('notshared')) return new Response('<html>sign in</html>', { headers: { 'Content-Type': 'text/html' } });
      return new Response('bytes', {
        status: init.headers?.Range ? 206 : 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="song.mp3"', 'Content-Length': '5', ...(init.headers?.Range ? { 'Content-Range': 'bytes 0-4/5' } : {}) },
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const o = await owner();
    const fans = await (await call(o, '/api/studio/communities', 'POST', { title: 'Fans' })).json();
    await entry(o, {
      kind: 'song',
      title: 'Stream',
      communities: [fans.id],
      meta: { versions: [
        { label: 'הקלטה', url: `https://drive.google.com/file/d/${ID}/view`, kind: 'audio' },
        { label: 'דמו', url: `https://drive.google.com/file/d/${LOCKED}/view`, kind: 'audio', visibility: 'community' },
      ] },
    });
    return o;
  }

  it('passes a shared file through with a type and ranges', async () => {
    await setup();
    const res = await req(`/media/drive/${ID}?k=audio`, { headers: { Range: 'bytes=0-4' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('Content-Range')).toBe('bytes 0-4/5');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(await res.text()).toBe('bytes');
    expect(asked[0]).toEqual({ url: `https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`, range: 'bytes=0-4' });
  });

  it('plays only files a visible version names', async () => {
    const o = await setup();
    expect((await req(`/media/drive/${LOCKED}`)).status).toBe(404);
    expect((await req('/media/drive/1SomeoneElsesFile0000000')).status).toBe(404);
    expect(asked).toHaveLength(0);
    const own = await call(o, `/media/drive/${LOCKED}`);
    expect(own.status).toBe(200);
    expect(own.headers.get('Cache-Control')).toBe('private, max-age=3600');
  });

  it('answers 502 when Drive sends a page instead of the file', async () => {
    const o = await owner();
    expect((await call(o, '/media/drive/notshared0000000')).status).toBe(502);
  });

  it('keeps Drive\'s frame for files that are not audio or video', () => {
    expect(mediaEmbed(`https://drive.google.com/file/d/${ID}/view`, { title: 'doc' })).toContain(`drive.google.com/file/d/${ID}/preview`);
    expect(mediaEmbed(`https://drive.google.com/file/d/${ID}/view`, { kind: 'video' })).toContain(`<video controls preload="metadata" playsinline poster=`);
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

describe('studio preview', () => {
  it('renders chord sheets for songs', async () => {
    const o = await owner();
    const res = await call(o, '/api/studio/preview', 'POST', { body: '[Am]שלום', mode: 'chords' });
    expect((await res.json()).html).toContain('<span class="ch">Am</span>');
  });
});
