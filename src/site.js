// The frame every server-rendered page shares: head, header with the wings,
// footer with the social links. Plus small helpers the page modules share.
import { escapeHtml as e } from './markdown.js';
import { db, WINGS } from './db.js';

export const SITE = 'https://itschakshteren.com';

// What each wing holds, for the home page tiles and the wing headers.
export const WING_INFO = {
  music: { what: 'שירים שהלחנתי, עם מילים ואקורדים, הקלטות ועיבודים', icon: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  books: { what: 'הספרים שאני כותב, פרק אחרי פרק. קוראי הבטא מגיבים על כל פרק', icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>' },
  sketches: { what: 'מערכונים וסדרות, מסודרים לפי ז\'אנר', icon: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>' },
  humor: { what: 'דיבובים, טקסטים מקוריים ושטויות', icon: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/>' },
  torah: { what: 'דברי תורה ומאמרים תורניים', icon: '<path d="M2 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H2z"/><path d="M22 4h-7a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h8z"/>' },
  articles: { what: 'דברים שרציתי להגיד בכתב', icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
  software: { what: 'פרויקטים שבניתי, רובם בקוד פתוח ב־GitHub', icon: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>' },
  videos: { what: 'קליפים ומאחורי הקלעים', icon: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3"/>' },
};

export const KIND_LABEL = {
  article: 'מאמר', project: 'פרויקט', work: 'יצירה', song: 'שיר', chapter: 'פרק', torah: 'דבר תורה',
  sketch: 'מערכון', dub: 'דיבוב', humor: 'הומור', video: 'סרטון', idea: 'רעיון',
};
const VIS_LABEL = { private: 'רק אני', community: 'לקהילות', members: 'לחברים', public: 'לכולם' };

export const icon = (paths, size = 34) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const LOCK = icon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 16);

const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');

// The social links in the footer and on the home page. The owner sets them;
// until then only the ones already known from the CV show.
export const DEFAULT_SOCIALS = [
  { label: 'GitHub', href: 'https://github.com/IzikStar' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/itschak-shteren-0b7a59313' },
];

export async function socials(env) {
  try {
    const d = await db(env);
    const row = await d.prepare(`SELECT value FROM settings WHERE key = 'socials'`).first();
    const list = row ? JSON.parse(row.value) : DEFAULT_SOCIALS;
    return list.filter((s) => s && typeof s.label === 'string' && /^https:\/\//.test(s.href ?? ''));
  } catch {
    return DEFAULT_SOCIALS;
  }
}

// The wing a space belongs to and the path of a space or an entry.
export function wingOf(acc, spaceId) {
  let s = acc.byId.get(spaceId);
  for (let hops = 0; s?.parentId && hops < 20; hops++) s = acc.byId.get(s.parentId);
  return s ?? null;
}

export function spacePath(acc, space) {
  if (!space.parentId) return `/${space.id}`;
  return `/${space.wing}/${encodeURIComponent(space.slug)}`;
}

export function entryPath(acc, entry) {
  if (!entry.slug) return null;
  const space = acc.byId.get(entry.spaceId);
  if (!space) return null;
  return `${spacePath(acc, space)}/${encodeURIComponent(entry.slug)}`;
}

export function badge(entry, v) {
  if (v.role === 'member' && (entry.visibility === 'members' || entry.visibility === 'community')) {
    return `<span class="badge vis-${e(entry.visibility)}">${VIS_LABEL[entry.visibility]}</span>`;
  }
  if (v.role !== 'owner') return '';
  const draft = entry.status === 'draft' ? '<span class="badge draft">טיוטה</span>' : '';
  return `${draft}<span class="badge vis-${e(entry.visibility)}">${e(VIS_LABEL[entry.visibility] ?? '')}</span>`;
}

export function html(markup, v, status = 200) {
  return new Response(markup, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': v.role === 'public' ? 'public, max-age=60' : 'private, no-store',
      Vary: 'Cookie',
    },
  });
}

export function layout({ title, description = '', path, v, body, wing = null, noindex = false, links = [], script = false, scripts = [], page = null, studio = '' }) {
  const { role, member, acc } = v;
  const here = (p) => (path === p || path.startsWith(`${p}/`) ? ' aria-current="page"' : '');
  const full = title ? `${title} · יצחק שטרן` : 'יצחק שטרן';
  const wings = WINGS.filter((w) => acc.visible.has(w.id));
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${e(full)}</title>
${description ? `<meta name="description" content="${e(description)}">` : ''}
<meta property="og:title" content="${e(title || 'יצחק שטרן')}">
${description ? `<meta property="og:description" content="${e(description)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}${e(path)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#13110e">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2313110e'/%3E%3Ctext x='16' y='23' font-size='19' text-anchor='middle' fill='%23e9a23b' font-family='sans-serif' font-weight='700'%3E%D7%99%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Secular+One&family=Heebo:wght@300;400;500;700&family=Frank+Ruhl+Libre:wght@400;500&family=IBM+Plex+Mono:wght@500&display=swap">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/creative.css">
${script ? '<script src="/site.js" defer></script>' : ''}
${scripts.map((src) => `<script src="${e(src)}" defer></script>`).join('')}
</head>
<body${wing ? ` data-wing="${e(wing)}"` : ''}${page ? ` data-page="${e(page)}"` : ''}>
<a class="sr-only" href="#main">לתוכן</a>
<header class="bar">
  <div class="wrap">
    <a class="mark" href="/">יצחק שטרן</a>
    <nav aria-label="אגפים">
      ${wings.map((w) => `<a href="/${w.id}"${here(`/${w.id}`)}>${e(w.title)}</a>`).join('\n      ')}
    </nav>
    <div class="who">
      ${role === 'owner' ? `<a class="btn small to-studio" href="/studio${studio ? `#${e(studio)}` : ''}">סטודיו</a>` : ''}
      ${member ? `<a href="/community"${here('/community')}>${e(member.displayName)}</a><a href="/login?logout=1">יציאה</a>` : `<a href="/community"${here('/community')}>קהילות</a>`}
      ${role === 'public' ? `<a class="btn small" href="/login?next=${encodeURIComponent(path)}">כניסה</a>` : ''}
    </div>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-foot">
  <div class="wrap">
    <span>יצחק שטרן · <a href="/cv">קורות חיים</a></span>
    <span class="socials">${links.map((s) => `<a href="${e(s.href)}" rel="me noopener">${e(s.label)}</a>`).join('')}</span>
  </div>
</footer>
</body>
</html>`;
}

export async function render(env, v, opts, status = 200) {
  return html(layout({ ...opts, v, links: await socials(env) }), v, status);
}
