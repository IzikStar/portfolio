import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker.js';
import { FakeD1 } from './fake-d1.js';
import { sanitizeHtml, richLook } from '../src/rich.js';
import { excerpt } from '../src/markdown.js';

describe('sanitizeHtml', () => {
  it('keeps the look Word gave the text', () => {
    const html = '<p style="text-align:center;margin-inline-end:36pt;text-indent:-18pt"><span style="font-size:1.5em;color:#c00000"><strong>כותרת</strong></span><sup class="dx-note"><a href="#n-1" id="r-1">1</a></sup></p>';
    expect(sanitizeHtml(html)).toBe(html);
    expect(sanitizeHtml('<p class="dx-figure"><img src="/files/ab-12" alt="" width="100" height="50" style="width:100px"></p>')).toBe(
      '<p class="dx-figure"><img src="/files/ab-12" alt="" width="100" height="50" style="width:100px" loading="lazy"></p>',
    );
  });

  it('keeps a Word group in place and nothing that would move it out of its box', () => {
    const group = '<div class="dx-figure"><div class="dx-group" style="width:200px;aspect-ratio:200 / 100;--dx-w:200;--dx-fs:16"><div class="dx-at" style="left:50%;top:-2.5%;width:25%;height:25%;transform:rotate(-12.5deg) scaleX(-1)"><img class="dx-cropped" src="/files/a" alt="" style="left:-50%;top:0%;width:200%;height:100%" loading="lazy"></div></div></div>';
    expect(sanitizeHtml(group)).toBe(group);
    expect(sanitizeHtml('<div style="position:fixed;left:0px;top:calc(1px);height:100vh;transform:translate(9px);--dx-w:a;aspect-ratio:1/1">x</div>')).toBe('<div>x</div>');
  });

  it('drops anything that could run, and styles it does not know', () => {
    expect(sanitizeHtml('<p onclick="x()" style="position:fixed;color:red;background:url(x)">a</p><script>alert(1)</script>b')).toBe('<p>a</p>b');
    expect(sanitizeHtml('<img src="javascript:alert(1)"><img src=x onerror=alert(1)>')).toBe('');
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="https://e.com/">x</a>')).toBe('<a href="https://e.com/" rel="noopener nofollow">x</a>');
    expect(sanitizeHtml('<iframe src="https://e.com"></iframe><style>p{}</style><p class="evil dx-gap">x</p>')).toBe('<p class="dx-gap">x</p>');
    expect(sanitizeHtml('<p>1 < 2 & "3"</p>')).toBe('<p>1 &lt; 2 &amp; &quot;3&quot;</p>');
  });

  it('closes what is left open and ignores stray closing tags', () => {
    expect(sanitizeHtml('<p><strong>a</p></em>b')).toBe('<p><strong>a</strong></p>b');
  });

  it('turns the chapter look into a style with sane bounds', () => {
    expect(richLook({ align: 'justify', gap: 6, line: 1.44 })).toBe(' style="text-align:justify;--dx-gap:6pt;--dx-line:1.44"');
    expect(richLook({ align: 'x;color:red', gap: 'a', line: 9 })).toBe(' style="--dx-line:2.6"');
    expect(richLook(null)).toBe('');
  });

  it('gives excerpts without tags', () => {
    expect(excerpt('<p style="x">שלום &amp; <strong>עולם</strong></p>')).toBe('שלום & עולם');
  });
});

const ORIGIN = 'https://site.test';
let env;
beforeEach(() => {
  env = {
    DB: new FakeD1(),
    MEDIA: { get: async () => null },
    ADMIN_PASSWORD: 'correct horse battery staple',
    ASSETS: { fetch: async () => new Response('asset') },
  };
});
const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0];
const call = (cookie, path, method = 'GET', body) =>
  req(path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const owner = async () => cookieOf(await call(null, '/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }));

describe('a chapter imported from Word', () => {
  it('shows its own page, and a chapter without an address never links to "null"', async () => {
    const o = await owner();
    const book = await (await call(o, '/api/studio/spaces', 'POST', { wing: 'books', parentId: 'books', kind: 'book', title: 'צביר 2', slug: 'z2', visibility: 'public' })).json();
    const mk = async (body) => (await call(o, '/api/studio/entries', 'POST', { kind: 'chapter', spaceId: book.id, ...body })).json();
    const first = await mk({ title: 'פתיחה', status: 'published', visibility: 'public', body: 'טקסט', meta: { order: 1 } });
    await mk({ title: 'פרק א', body: 'עוד', meta: { order: 2 } }); // a draft
    const third = await mk({ title: 'פרק ב', status: 'published', visibility: 'public', body: 'סוף', meta: { order: 3 } });

    // The import: HTML body, the document's look, and the old text kept as a version.
    const res = await call(o, `/api/studio/entries/${first.id}`, 'PATCH', {
      body: '<p style="text-align:center">♦♦♦</p>\n<p>היה <strong>זה</strong><script>x</script></p>',
      meta: { order: 1, format: 'html', look: { align: 'justify', gap: 0 } },
      keep: 'import',
    });
    expect(res.status).toBe(200);
    const { revisions } = await (await call(o, `/api/studio/entries/${first.id}/revisions`)).json();
    expect(revisions[0]).toMatchObject({ reason: 'import' });

    const page = await (await call(null, '/books/z2/%D7%A4%D7%AA%D7%99%D7%97%D7%94')).text();
    expect(page).toContain('class="paper prose rich" dir="rtl" style="text-align:justify;--dx-gap:0pt"');
    expect(page).toContain('<p style="text-align:center">♦♦♦</p>\n<p>היה <strong>זה</strong></p>');
    expect(page).not.toContain('<script>x');
    // The pager skips the draft between them.
    expect(page).toContain(`href="/books/z2/${encodeURIComponent(third.slug)}"`);

    // A chapter published straight into the database once had no address: no "null" links.
    await env.DB.prepare('UPDATE entries SET slug = NULL WHERE id = ?').bind(third.id).run();
    const toc = await (await call(o, '/books/z2')).text();
    expect(toc).not.toContain('href="null"');
    expect(toc).toContain(`href="/studio#item/${third.id}"><span dir="auto">פרק ב</span>`);
    const pub = await (await call(null, '/books/z2')).text();
    expect(pub).not.toContain('href="null"');
    expect(pub).not.toContain('>פרק ב<');
    const again = await (await call(null, '/books/z2/%D7%A4%D7%AA%D7%99%D7%97%D7%94')).text();
    expect(again).not.toContain('href="null"');
  });

  it('previews HTML in the studio through the same filter', async () => {
    const o = await owner();
    const { html } = await (await call(o, '/api/studio/preview', 'POST', { body: '<p onclick="x">a</p>', mode: 'html' })).json();
    expect(html).toBe('<p>a</p>');
  });
});
