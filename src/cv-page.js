// The CV page's HTML, built on the server in one language (he or en) so it
// arrives complete, indexable and printable. public/cv.js adds the audio
// player, the copy button and the print button; public/cv.css styles it.
import { escapeHtml as esc } from './markdown.js';
import { youtubeId, driveId } from './media.js';
import { SITE } from './site.js';

const STR = {
  he: {
    code: 'קוד', live: 'אתר חי', playGame: 'לשחק', privateCode: 'הקוד פרטי',
    play: 'נגן', copy: 'העתקת הכתובת', copied: 'הועתק', print: 'הדפסה',
    open: 'לפתיחה', watch: 'לצפייה', listen: 'להאזנה', read: 'לקריאה',
    reach: 'אפשר לכתוב לי', skills: 'כלים ושפות', timeline: 'בקצרה', sections: 'מקטעים', kicker: 'קורות חיים', tools: 'כלים שאני עובד איתם', projectsN: 'פרויקטים', toolsN: 'כלים ושפות', write: 'בוא נדבר',
    other: 'English', otherShort: 'EN', skip: 'לתוכן', count: (n) => (n === 1 ? 'פריט אחד' : `${n} פריטים`),
  },
  en: {
    code: 'Code', live: 'Live site', playGame: 'Play it', privateCode: 'Code is private',
    play: 'Play', copy: 'Copy address', copied: 'Copied', print: 'Print',
    open: 'Open', watch: 'Watch', listen: 'Listen', read: 'Read',
    reach: 'Get in touch', skills: 'Tools and languages', timeline: 'In short', sections: 'Sections', kicker: 'Résumé', tools: 'Tools I work with', projectsN: 'projects', toolsN: 'tools and languages', write: "Let's talk",
    other: 'עברית', otherShort: 'עב', skip: 'Skip to content', count: (n) => (n === 1 ? '1 item' : `${n} items`),
  },
};

const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;
const isAudio = (v) => v.kind === 'audio' || (!v.kind && AUDIO_EXT.test(v.url));
const isVideo = (v) => v.kind === 'video' || (!v.kind && (VIDEO_EXT.test(v.url) || Boolean(youtubeId(v.url)) || Boolean(driveId(v.url))));
const external = (href) => /^https?:/.test(href);

// A bilingual value in the asked language, falling back to the other one.
function pick(v, lang) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  return v[lang] || v[lang === 'he' ? 'en' : 'he'] || '';
}

function host(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// The address as it reads on paper: host and path, no scheme.
function printable(href) {
  try {
    const u = new URL(href);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
  } catch {
    return '';
  }
}

function link(href, text, cls = '') {
  const ext = external(href);
  return `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}"${ext ? ` rel="noopener" data-url="${esc(printable(href))}"` : ''}>${esc(text)}${ext ? '<span class="arrow" aria-hidden="true">↗</span>' : ''}</a>`;
}

// Which sections show: switched on, and with something in them.
function shownSections(cv, projects, items) {
  return cv.sections.filter((s) => {
    if (!s.show) return false;
    if (s.id === 'code') return projects.length > 0;
    if (s.id === 'about') return Boolean(pick(cv.about, 'he') || cv.timeline?.length || cv.skills?.length);
    if (s.id === 'contact') return Boolean(cv.email || cv.contact?.length);
    return (items[s.id] ?? []).length > 0;
  });
}

export function renderCvPage({ cv, projects = [], items = {}, lang = 'he', preview = false }) {
  const t = STR[lang];
  const p = (v) => pick(v, lang);
  const other = lang === 'he' ? 'en' : 'he';
  const sections = shownSections(cv, projects, items);
  const name = p(cv.name);
  const roles = (cv.roles ?? []).map(p).filter(Boolean);
  const contactLinks = (cv.contact ?? []).filter((l) => l.href && p(l.label));

  // ---------- head ----------
  const title = roles.length ? `${name} · ${roles[0]}` : name;
  const description = [roles.join(', '), p(cv.lede)].filter(Boolean).join('. ').slice(0, 300);
  const canonical = `${SITE}/cv${lang === 'en' ? '?lang=en' : ''}`;
  const person = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name,
    url: `${SITE}/cv`,
    ...(roles[0] ? { jobTitle: roles[0] } : {}),
    ...(cv.email ? { email: `mailto:${cv.email}` } : {}),
    ...(cv.skills?.length ? { knowsAbout: cv.skills } : {}),
    sameAs: contactLinks.map((l) => l.href).filter(external),
  };
  const head = `<!doctype html>
<html lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="he" href="${SITE}/cv">
<link rel="alternate" hreflang="en" href="${SITE}/cv?lang=en">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#f6f4ee" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1513" media="(prefers-color-scheme: dark)">
${preview ? '<meta name="robots" content="noindex">' : ''}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230d6b5f'/%3E%3Ctext x='16' y='23' font-size='19' text-anchor='middle' fill='white' font-family='serif' font-weight='700'%3EI%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@500;700;900&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Hebrew:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/cv.css">
${preview ? '' : "<script>if('IntersectionObserver' in window&&!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('js')</script>"}
<script type="application/ld+json">${JSON.stringify(person).replace(/</g, '\\u003c')}</script>
</head>`;

  // ---------- top bar ----------
  const nav = sections.map((s) => `<a href="#${esc(s.id)}">${esc(p(s.nav) || p(s.title))}</a>`).join('');
  const bar = `<header class="bar">
  <span class="progress" aria-hidden="true"></span>
  <div class="wrap">
    <a class="mark" href="#top">${esc(name)}</a>
    <nav aria-label="${t.sections}">${nav}</nav>
    <div class="tools">
      <button class="tool" type="button" data-print hidden>${t.print}</button>
      <a class="tool lang" href="/cv?lang=${other}" hreflang="${other}" lang="${other}" data-lang="${other}" aria-label="${esc(t.other)}">${t.otherShort}</a>
    </div>
  </div>
</header>`;

  // ---------- hero ----------
  const buttons = (cv.buttons ?? [])
    .filter((x) => x.href && p(x.label))
    .map((x, i) => `<a class="btn${i === 0 ? ' primary' : ''}" href="${esc(x.href)}"${external(x.href) ? ` rel="noopener" data-url="${esc(printable(x.href))}"` : ''}>${esc(p(x.label))}</a>`)
    .join('');
  const card = cv.email || contactLinks.length
    ? `<aside class="reach" aria-label="${esc(t.reach)}">
      <span class="label">${t.reach}</span>
      ${cv.email ? `<a class="email" href="mailto:${esc(cv.email)}">${esc(cv.email)}</a>` : ''}
      ${contactLinks.length ? `<ul>${contactLinks.map((l) => `<li><a href="${esc(l.href)}"${external(l.href) ? ' rel="noopener me"' : ''}><span>${esc(p(l.label))}</span><span class="host">${esc(printable(l.href) || l.href)}</span></a></li>`).join('')}</ul>` : ''}
    </aside>`
    : '';
  const stats = [
    projects.length ? `<li><b>${projects.length}</b><span>${t.projectsN}</span></li>` : '',
    cv.skills?.length ? `<li><b>${cv.skills.length}</b><span>${t.toolsN}</span></li>` : '',
  ].join('');
  const hero = `<section class="hero" id="top">
  <div class="wrap">
    <div class="hero-top">
      ${p(cv.avail) ? `<p class="avail"><span class="pulse" aria-hidden="true"></span>${esc(p(cv.avail))}</p>` : '<span></span>'}
      <span class="kicker" aria-hidden="true">${t.kicker} · ${new Date().getFullYear()}</span>
    </div>
    <h1>${esc(name)}</h1>
    <div class="hero-grid">
      <div class="hero-main">
        ${roles.length ? `<p class="roles">${roles.map((r) => `<span>${esc(r)}</span>`).join('')}</p>` : ''}
        ${p(cv.lede) ? `<p class="lede">${esc(p(cv.lede))}</p>` : ''}
        ${buttons ? `<div class="actions">${buttons}</div>` : ''}
        ${stats ? `<ul class="stats">${stats}</ul>` : ''}
      </div>
      ${card}
    </div>
  </div>
</section>`;

  // The tools, running past as one band under the hero. The copy is for the loop.
  const tools = (cv.skills ?? []).map((s) => `<span>${esc(s)}</span>`).join('<i aria-hidden="true"></i>');
  const marquee = cv.skills?.length
    ? `<div class="marquee" role="region" aria-label="${t.tools}"><div class="track"><div class="run">${tools}<i aria-hidden="true"></i></div><div class="run" aria-hidden="true">${tools}<i></i></div></div></div>`
    : '';

  // ---------- sections ----------
  const headOf = (s, i, extra = '') => `<header class="head" data-reveal>
      <span class="num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
      <h2>${esc(p(s.title))}</h2>${extra}
    </header>${p(s.intro) ? `<p class="intro">${esc(p(s.intro))}</p>` : ''}`;

  const project = (x, i) => {
    const links = x.links.map((l) => link(l.href, t[l.k] ?? l.k)).join('');
    const note = x.note && p(x.note) ? `<span class="note">${esc(p(x.note))}</span>` : x.links.every((l) => l.k !== 'code') ? `<span class="note">${t.privateCode}</span>` : '';
    const media = x.img
      ? `<img src="${esc(x.img)}" alt="${esc(p(x.name))}" loading="lazy" decoding="async">`
      : x.facts?.length
        ? `<dl class="facts">${x.facts.map((f) => `<div><dt>${esc(f[lang] || f.he || '')}</dt><dd>${esc(pick(f.v, lang))}</dd></div>`).join('')}</dl>`
        : '';
    return `<article class="project${media ? '' : ' plain'}" data-reveal>
      <span class="idx" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
      <div class="text">
        ${p(x.tag) ? `<span class="tag">${esc(p(x.tag))}</span>` : ''}
        <h3>${esc(p(x.name))}</h3>
        ${p(x.text) ? `<p>${esc(p(x.text))}</p>` : ''}
        ${x.stack?.length ? `<ul class="chips" aria-label="Stack">${x.stack.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
        ${links || note ? `<div class="links">${links}${note}</div>` : ''}
      </div>
      ${media ? `<div class="media">${media}</div>` : ''}
    </article>`;
  };

  const playBtn = (it, v) => `<button class="play" type="button" data-play="${esc(it.id)}" data-src="${esc(v.url)}" aria-label="${t.play}: ${esc(it.title)}">${ICON_PLAY}</button>`;
  const seek = (it) => `<div class="seek" data-seek="${esc(it.id)}" aria-hidden="true"><i></i></div>`;
  const itemLinks = (it, skip = []) => {
    const out = [];
    for (const v of it.versions) {
      if (skip.includes(v)) continue;
      const label = v.label || (isVideo(v) ? t.watch : isAudio(v) ? t.listen : t.open);
      out.push(link(v.url, `${label}${external(v.url) ? ` · ${host(v.url)}` : ''}`));
    }
    for (const l of it.links) out.push(link(l.href, l.label || t.read));
    return out.length ? `<div class="links">${out.join('')}</div>` : '';
  };

  const row = (it) => {
    const audio = it.versions.find(isAudio);
    const video = !audio && it.versions.find(isVideo);
    return `<li class="row${it.cover ? '' : ' nocover'}" data-id="${esc(it.id)}">
      ${audio ? playBtn(it, audio) : `<span class="play ghost" aria-hidden="true">${video ? '▶' : '↗'}</span>`}
      ${it.cover ? `<img class="cover" src="${esc(it.cover)}" alt="" loading="lazy" decoding="async">` : ''}
      <div class="info">
        <span class="title" dir="auto">${esc(it.title)}</span>
        ${it.summary ? `<span class="note" dir="auto">${esc(it.summary)}</span>` : ''}
        ${itemLinks(it, audio ? [audio] : [])}
      </div>
      <span class="time" data-time="${esc(it.id)}"></span>
      ${audio ? seek(it) : ''}
    </li>`;
  };

  const embed = (v, title) => {
    const yt = youtubeId(v.url);
    if (yt && /^[\w-]+$/.test(yt)) {
      return `<iframe src="https://www.youtube-nocookie.com/embed/${yt}" title="${esc(title)}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    }
    const dr = driveId(v.url);
    if (dr && /^[\w-]+$/.test(dr)) return `<iframe src="https://drive.google.com/file/d/${dr}/preview" title="${esc(title)}" loading="lazy" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
    return `<video controls preload="metadata" playsinline src="${esc(v.url)}"></video>`;
  };

  const tile = (it) => {
    const audio = it.versions.find(isAudio);
    const video = it.versions.find(isVideo);
    const media = video ? embed(video, it.title) : it.cover ? `<img src="${esc(it.cover)}" alt="" loading="lazy" decoding="async">` : '';
    return `<article class="card" data-reveal data-id="${esc(it.id)}">
      ${media ? `<div class="card-media">${media}</div>` : ''}
      <div class="card-body">
        <h3 dir="auto">${esc(it.title)}</h3>
        ${it.summary ? `<p dir="auto">${esc(it.summary)}</p>` : ''}
        ${audio ? `<div class="card-audio">${playBtn(it, audio)}<span class="time" data-time="${esc(it.id)}"></span>${seek(it)}</div>` : ''}
        ${itemLinks(it, [audio, video].filter(Boolean))}
      </div>
    </article>`;
  };

  const about = () => {
    const paras = p(cv.about).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const timeline = cv.timeline?.length
      ? `<div class="side-block" data-reveal><h3>${t.timeline}</h3><ol class="timeline">${cv.timeline
          .map((x) => `<li><span class="when">${esc(p(x.when))}</span><strong>${esc(p(x.what))}</strong>${p(x.detail) ? `<span class="detail">${esc(p(x.detail))}</span>` : ''}</li>`)
          .join('')}</ol></div>`
      : '';
    const skills = cv.skills?.length ? `<div class="side-block" data-reveal><h3>${t.skills}</h3><ul class="chips skills">${cv.skills.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : '';
    return `<div class="about">
      <div class="about-text" data-reveal>${paras.map((x) => `<p>${esc(x).replace(/\n/g, '<br>')}</p>`).join('')}</div>
      ${timeline || skills ? `<div class="about-side">${timeline}${skills}</div>` : ''}
    </div>`;
  };

  const contact = () => `<div class="contact" data-reveal>
      <p class="write" aria-hidden="true">${t.write}</p>
      ${cv.email ? `<a class="email big" href="mailto:${esc(cv.email)}">${esc(cv.email)}</a>
      <button class="btn" type="button" data-copy="${esc(cv.email)}" data-copied="${esc(t.copied)}" hidden>${t.copy}</button>` : ''}
      ${contactLinks.map((l) => `<a class="btn" href="${esc(l.href)}"${external(l.href) ? ` rel="noopener" data-url="${esc(printable(l.href))}"` : ''}>${esc(p(l.label))}</a>`).join('')}
    </div>`;

  const body = sections
    .map((s, i) => {
      let inner;
      let extra = '';
      if (s.id === 'code') inner = `<div class="projects">${projects.map((x, i) => project(x, i)).join('')}</div>`;
      else if (s.id === 'about') inner = about();
      else if (s.id === 'contact') inner = contact();
      else {
        const list = items[s.id] ?? [];
        extra = `<span class="count">${t.count(list.length)}</span>`;
        inner = s.id === 'music' || s.id === 'voice' ? `<ol class="rows">${list.map(row).join('')}</ol>` : `<div class="cards">${list.map(tile).join('')}</div>`;
      }
      return `<section class="block block-${esc(s.id)}" id="${esc(s.id)}" aria-labelledby="h-${esc(s.id)}">
  <div class="wrap">
    ${headOf(s, i, extra).replace('<h2>', `<h2 id="h-${esc(s.id)}">`)}
    ${inner}
  </div>
</section>`;
    })
    .join('\n');

  const footer = `<footer class="foot"><div class="wrap"><span>${esc(name)}</span>${p(cv.footer) ? `<span>${esc(p(cv.footer))}</span>` : ''}</div></footer>`;

  return `${head}
<body>
<a class="skip" href="#main">${t.skip}</a>
${bar}
<main id="main">
${hero}
${marquee}
${body}
</main>
${footer}
<audio id="player" preload="none"></audio>
${preview ? '' : '<script src="/cv.js" defer></script>'}
</body>
</html>`;
}
