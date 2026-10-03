// Server-rendered public pages of the platform (articles for now). Rendering
// on the server means link previews and search engines see the real text.
import { escapeHtml as e, renderMarkdown } from './markdown.js';
import { card, findVisible, listVisible } from './entries.js';

const SITE = 'https://itschakshteren.com';
const VIS_LABEL = { private: 'פרטי', members: 'לקהילה', public: 'ציבורי' };

const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');

function layout({ title, description = '', path, role, body, noindex = false }) {
  const full = title ? `${title} · יצחק שטרן` : 'יצחק שטרן';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${e(full)}</title>
${description ? `<meta name="description" content="${e(description)}">` : ''}
<meta property="og:title" content="${e(title || 'יצחק שטרן')}">
${description ? `<meta property="og:description" content="${e(description)}">` : ''}
<meta property="og:type" content="article">
<meta property="og:url" content="${SITE}${e(path)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230d6b5f'/%3E%3Ctext x='16' y='23' font-size='19' text-anchor='middle' fill='white' font-family='serif' font-weight='700'%3EI%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@500;700;900&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Hebrew:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/platform.css">
</head>
<body>
<header class="bar">
  <div class="wrap">
    <a class="mark" href="/">יצחק שטרן</a>
    <nav class="always">
      <a href="/writing"${path.startsWith('/writing') ? ' aria-current="page"' : ''}>כתיבה</a>
      <a href="/">קורות חיים</a>
      ${role === 'owner' ? '<a href="/studio">סטודיו</a>' : ''}
    </nav>
  </div>
</header>
<main>
${body}
</main>
<footer><div class="wrap">יצחק שטרן</div></footer>
</body>
</html>`;
}

function html(markup, role, status = 200) {
  return new Response(markup, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': role === 'public' ? 'public, max-age=60' : 'private, no-store',
      Vary: 'Cookie',
    },
  });
}

function badge(entry, role) {
  if (role !== 'owner') return '';
  const draft = entry.status === 'draft' ? '<span class="badge draft">טיוטה</span>' : '';
  return `${draft}<span class="badge vis-${e(entry.visibility)}">${e(VIS_LABEL[entry.visibility])}</span>`;
}

export async function writingIndex(env, role) {
  const entries = (await listVisible(env, role, 'article')).map(card);
  const list = entries.length
    ? `<ol class="article-list">${entries
        .map(
          (a) => `<li>
  <a href="/writing/${encodeURIComponent(a.slug)}"><h2>${e(a.title)}</h2></a>
  <p>${e(a.summary)}</p>
  <div class="meta"><time datetime="${e(a.publishedAt)}">${e(fmtDate(a.publishedAt))}</time>${role === 'owner' ? `<span class="badge vis-${e(a.visibility)}">${e(VIS_LABEL[a.visibility])}</span>` : ''}</div>
</li>`,
        )
        .join('\n')}</ol>`
    : '<p class="empty">עוד אין כאן מאמרים.</p>';
  const body = `<div class="wrap page">
  <div class="head"><h1>כתיבה</h1></div>
  ${list}
</div>`;
  return html(layout({ title: 'כתיבה', description: 'מאמרים ורשימות של יצחק שטרן.', path: '/writing', role, body }), role);
}

export async function writingPage(env, role, slug) {
  const entry = await findVisible(env, role, 'article', slug);
  if (!entry) return null;
  const path = `/writing/${encodeURIComponent(entry.slug)}`;
  const tags = entry.tags.length ? `<ul class="chips">${entry.tags.map((t) => `<li>${e(t)}</li>`).join('')}</ul>` : '';
  const edit = role === 'owner' ? `<a class="btn" href="/studio#edit/${e(entry.id)}">עריכה</a>` : '';
  const body = `<article class="wrap page article">
  <header>
    <div class="meta"><time datetime="${e(entry.publishedAt ?? '')}">${e(fmtDate(entry.publishedAt || entry.updatedAt))}</time>${badge(entry, role)}${edit}</div>
    <h1 dir="auto">${e(entry.title)}</h1>
    ${entry.summary ? `<p class="lede" dir="auto">${e(entry.summary)}</p>` : ''}
    ${tags}
  </header>
  <div class="prose" dir="auto">${renderMarkdown(entry.body)}</div>
  <p class="back"><a href="/writing">לכל המאמרים</a></p>
</article>`;
  const noindex = entry.visibility !== 'public' || entry.status !== 'published';
  return html(layout({ title: entry.title, description: entry.summary || card(entry).summary, path, role, body, noindex }), role);
}
