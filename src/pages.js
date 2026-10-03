// Server-rendered pages of the platform (articles, community). Rendering
// on the server means link previews and search engines see the real text.
import { escapeHtml as e, renderMarkdown } from './markdown.js';
import { card, findVisible, listFeed, listVisible } from './entries.js';

const SITE = 'https://itschakshteren.com';
const VIS_LABEL = { private: 'פרטי', members: 'לקהילה', public: 'ציבורי' };

const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');

function layout({ title, description = '', path, v, body, noindex = false }) {
  const { role, member } = v;
  const here = (p) => (path === p || path.startsWith(`${p}/`) ? ' aria-current="page"' : '');
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
      <a href="/writing"${here('/writing')}>כתיבה</a>
      <a href="/community"${here('/community')}>קהילה</a>
      <a href="/">קורות חיים</a>
      ${role === 'owner' ? '<a href="/studio">סטודיו</a>' : ''}
      ${member ? `<a href="/login?logout=1" title="יציאה">${e(member.displayName)} · יציאה</a>` : ''}
      ${role === 'public' ? '<a href="/login">כניסה</a>' : ''}
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
  if (role === 'member' && entry.visibility === 'members') return `<span class="badge vis-members">${VIS_LABEL.members}</span>`;
  if (role !== 'owner') return '';
  const draft = entry.status === 'draft' ? '<span class="badge draft">טיוטה</span>' : '';
  return `${draft}<span class="badge vis-${e(entry.visibility)}">${e(VIS_LABEL[entry.visibility])}</span>`;
}

export async function writingIndex(env, v) {
  const { role } = v;
  const entries = (await listVisible(env, role, 'article')).map(card);
  const list = entries.length
    ? `<ol class="article-list">${entries
        .map(
          (a) => `<li>
  <a href="/writing/${encodeURIComponent(a.slug)}"><h2>${e(a.title)}</h2></a>
  <p>${e(a.summary)}</p>
  <div class="meta"><time datetime="${e(a.publishedAt)}">${e(fmtDate(a.publishedAt))}</time>${badge(a, role)}</div>
</li>`,
        )
        .join('\n')}</ol>`
    : '<p class="empty">עוד אין כאן מאמרים.</p>';
  const body = `<div class="wrap page">
  <div class="head"><h1>כתיבה</h1></div>
  ${list}
</div>`;
  return html(layout({ title: 'כתיבה', description: 'מאמרים ורשימות של יצחק שטרן.', path: '/writing', v, body }), role);
}

export async function writingPage(env, v, slug) {
  const { role } = v;
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
  return html(layout({ title: entry.title, description: entry.summary || card(entry).summary, path, v, body, noindex }), role);
}

const KIND_LABEL = { article: 'מאמר', project: 'פרויקט', work: 'יצירה' };

export async function communityPage(env, v) {
  const { role, member } = v;
  if (role === 'public') {
    const body = `<div class="wrap page narrow">
  <div class="head"><h1>קהילה</h1></div>
  <p class="lede">חלק מהדברים שאני כותב ויוצר פתוחים רק לחברי הקהילה. מי שקיבל ממני קישור הזמנה יכול פשוט לפתוח אותו. אפשר גם לבקש להצטרף, ואני מאשר.</p>
  <div class="actions"><a class="btn primary" href="/join">בקשת הצטרפות</a><a class="btn" href="/login">כניסה לחברים</a></div>
</div>`;
    return html(layout({ title: 'קהילה', description: 'הקהילה של יצחק שטרן.', path: '/community', v, body }), role);
  }
  const feed = (await listFeed(env, role)).filter((x) => role === 'owner' || x.visibility === 'members' || x.visibility === 'public');
  const items = feed.length
    ? `<ol class="article-list">${feed
        .map((x) => {
          const c = card(x);
          const title = x.kind === 'article' ? `<a href="/writing/${encodeURIComponent(x.slug)}"><h2 dir="auto">${e(x.title)}</h2></a>` : `<h2 dir="auto">${e(x.title)}</h2>`;
          return `<li>
  ${title}
  <p dir="auto">${e(c.summary)}</p>
  <div class="meta"><span>${e(KIND_LABEL[x.kind] ?? '')}</span><time datetime="${e(x.publishedAt)}">${e(fmtDate(x.publishedAt))}</time>${badge(x, role)}</div>
</li>`;
        })
        .join('\n')}</ol>`
    : '<p class="empty">עוד אין כאן כלום. בקרוב.</p>';
  const hello = member ? `<p class="lede">שלום ${e(member.displayName)}, טוב לראות אותך כאן.</p>` : '';
  const body = `<div class="wrap page">
  <div class="head"><h1>קהילה</h1></div>
  ${hello}
  ${items}
</div>`;
  return html(layout({ title: 'קהילה', path: '/community', v, body, noindex: true }), role);
}
