// Portfolio front end: language switch, sections controlled from the admin page,
// project list and the media player.
(() => {
  const STR = {
    he: {
      name: 'יצחק שטרן',
      'hero.avail': 'פנוי לעבודה מדצמבר 2026',
      'hero.lede':
        'בשנתיים האחרונות אני בונה מערכות פרודקשן בחיל האוויר: אימות משתמשים בארכיטקטורה של 8 שירותים, תכנון מחדש של אלגוריתמים ותשתית רגרסיה שמאמתת כ־120,000 מקרים הנדסיים.',
      'hero.cta': 'לפרויקטים',
      'code.title': 'פרויקטים',
      'code.kicker': 'קוד פתוח ב־GitHub, אלא אם צוין אחרת',
      'music.title': 'מוזיקה',
      'voice.title': 'דיבוב',
      'sketches.title': 'מערכונים',
      'writing.title': 'כתיבה',
      'about.title': 'עליי',
      'contact.title': 'יצירת קשר',
      'nav.code': 'קוד',
      'nav.music': 'מוזיקה',
      'nav.voice': 'דיבוב',
      'nav.sketches': 'מערכונים',
      'nav.writing': 'כתיבה',
      'nav.about': 'עליי',
      'nav.contact': 'יצירת קשר',
      'role.code': 'מפתח Full-Stack',
      'role.music': 'מוזיקאי',
      'role.voice': 'מדבב',
      'role.sketches': 'יוצר מערכונים',
      'role.writing': 'כותב',
      count: (n) => (n === 1 ? 'פריט אחד' : `${n} פריטים`),
      play: 'נגן',
      pause: 'השהה',
      'open.pdf': 'לקריאה',
      'open.image': 'לתמונה המלאה',
      'open.video': 'לצפייה',
      'open.link': 'לפתיחה',
      'about.p1':
        'אני מפתח Full-Stack עם ניסיון בפרודקשן ב־TypeScript, React, NestJS, Java ו־PostgreSQL. אני אוהב את החלקים שמתחת למכסה המנוע: אימות והרשאות, אלגוריתמים, ובדיקות שמאפשרות לשנות קוד בלי לפחד.',
      'about.p2': 'אני גם יוצר בעוד תחומים, וכנראה בגלל זה אכפת לי איך דברים מרגישים לאדם שמשתמש בהם.',
      'contact.copy': 'העתקת כתובת',
      'contact.copied': 'הועתק',
      footer: 'נבנה ביד עם HTML, CSS ו־Cloudflare Workers.',
      code: 'קוד',
      live: 'אתר חי',
      playGame: 'לשחק',
      privateCode: 'הקוד פרטי',
    },
    en: {
      name: 'Itschak Shteren',
      'hero.avail': 'Available from December 2026',
      'hero.lede':
        'For the last two years I have built production systems in the Israeli Air Force: authentication across an 8-service architecture, algorithm redesigns, and a regression framework that validates about 120,000 engineering cases.',
      'hero.cta': 'See projects',
      'code.title': 'Projects',
      'code.kicker': 'Open source on GitHub unless noted',
      'music.title': 'Music',
      'voice.title': 'Voice acting',
      'sketches.title': 'Sketches',
      'writing.title': 'Writing',
      'about.title': 'About',
      'contact.title': 'Contact',
      'nav.code': 'Code',
      'nav.music': 'Music',
      'nav.voice': 'Voice',
      'nav.sketches': 'Sketches',
      'nav.writing': 'Writing',
      'nav.about': 'About',
      'nav.contact': 'Contact',
      'role.code': 'Full-stack developer',
      'role.music': 'Musician',
      'role.voice': 'Voice actor',
      'role.sketches': 'Sketch comedy',
      'role.writing': 'Writer',
      count: (n) => (n === 1 ? '1 item' : `${n} items`),
      play: 'Play',
      pause: 'Pause',
      'open.pdf': 'Read',
      'open.image': 'Full image',
      'open.video': 'Watch',
      'open.link': 'Open',
      'about.p1':
        'I am a full-stack developer with production experience in TypeScript, React, NestJS, Java and PostgreSQL. I like the parts under the hood: authentication and permissions, algorithms, and tests that let you change code without fear.',
      'about.p2': 'I also make things in other fields, which is probably why I care about how things feel to the person using them.',
      'contact.copy': 'Copy address',
      'contact.copied': 'Copied',
      footer: 'Hand-built with HTML, CSS and Cloudflare Workers.',
      code: 'Code',
      live: 'Live site',
      playGame: 'Play it',
      privateCode: 'Code is private',
    },
  };

  const PROJECTS = [
    {
      name: { he: 'מנוע שחמט', en: 'Chess engine' },
      tag: { he: 'Java · אלגוריתמים', en: 'Java · Algorithms' },
      text: {
        he: 'משחק שחמט עם מנוע שכתבתי מאפס: ייצוג לוח ב־bitboards, חיפוש alpha-beta ו־10 רמות קושי (העליונות יכולות לעבור ל־Stockfish). משחקים בדפדפן: ה־jar מרים שרת מקומי וממשק React שמדבר איתו ב־WebSocket, עם premoves, רמזים וסקירת מהלכים. הקוד עובר ריפקטור מתועד בשלבים, כשכל שלב מגובה בבדיקות perft, בדיקות אופי ובדיקות דפדפן.',
        en: 'A chess game with an engine written from scratch: bitboards, alpha-beta search and 10 difficulty levels (the top ones can hand off to Stockfish). You play in the browser: the jar starts a local server and a React UI that talks to it over a WebSocket, with premoves, hints and move review. The code is going through a documented, phased refactor, each phase backed by perft, characterization and browser tests.',
      },
      stack: ['Java', 'Maven', 'JUnit', 'React', 'TypeScript', 'WebSocket', 'Playwright'],
      img: 'img/chess.webp',
      links: [{ k: 'code', href: 'https://github.com/IzikStar/izik-star-chess-engine' }],
    },
    {
      name: { he: 'GoldenToasts', en: 'GoldenToasts' },
      tag: { he: 'Full-Stack · Backend', en: 'Full-stack · Backend' },
      text: {
        he: 'אפליקציה למסורת הרמת הכוסית של צוות: תזמון, הזמנות, אישור מנהל ולוח "עבריינים" למי שמבריז. אימות JWT, הרשאות לפי תפקיד, ומונוריפו Nx עם בדיקות ו־CI.',
        en: "An app for a team's toast tradition: scheduling, invites, admin approval and a 'criminals' board for whoever skips. JWT auth, role-based guards, and an Nx monorepo with tests and CI.",
      },
      stack: ['NestJS', 'React', 'PostgreSQL', 'Sequelize', 'Redux Toolkit', 'Nx', 'Jest'],
      facts: [
        { he: 'בדיקות יחידה', en: 'Unit tests', v: '114' },
        { he: 'בדיקות e2e', en: 'E2E tests', v: '8' },
        { he: 'CI', en: 'CI', v: 'GitHub Actions' },
      ],
      links: [{ k: 'code', href: 'https://github.com/IzikStar/golden-toasts' }],
    },
    {
      name: { he: 'סוכן חיפוש עבודה (MCP)', en: 'LinkedIn agent MCP' },
      tag: { he: 'TypeScript · ניסיוני', en: 'TypeScript · Experimental' },
      text: {
        he: 'סוכן לחיפוש עבודה שחשוף כשרת MCP, עם אדם בלולאה: כל פעולה דורשת אישור מחוץ לערוץ. ארכיטקטורה הקסגונלית, כלים מוקלדים ויומן החלטות.',
        en: 'A human-in-the-loop job-search agent exposed as an MCP server: every action needs out-of-band confirmation. Hexagonal architecture, typed tools and a decision log.',
      },
      stack: ['TypeScript', 'MCP', 'Playwright', 'SQLite'],
      facts: [
        { he: 'בדיקות', en: 'Tests', v: '199' },
        { he: 'כל פעולה', en: 'Every action', v: { he: 'דורשת אישור', en: 'confirmed by a human' } },
      ],
      links: [{ k: 'code', href: 'https://github.com/IzikStar/linkedin-agent-mcp' }],
    },
    {
      name: { he: 'Accellent Collect', en: 'Accellent Collect' },
      tag: { he: 'Full-Stack · באוויר', en: 'Full-stack · Live' },
      text: {
        he: 'כלי לאיסוף ודירוג הקלטות של אנגלית במבטא ישראלי, לאימון מאמן הגייה מבוסס AI. עובד מקצה לקצה ומשרת משתמשים אמיתיים.',
        en: 'A tool for crowdsourcing and rating recordings of Israeli-accented English, to train an AI pronunciation coach. Works end to end and serves real users.',
      },
      stack: ['FastAPI', 'Python', 'React', 'TypeScript', 'SQLite'],
      facts: [
        { he: 'סטטוס', en: 'Status', v: { he: 'באוויר', en: 'Live' } },
        { he: 'הקוד', en: 'Code', v: { he: 'פרטי', en: 'Private' } },
      ],
      links: [{ k: 'live', href: 'https://collect.accellent.org' }],
    },
    {
      name: { he: 'MasterMind', en: 'MasterMind' },
      tag: { he: 'TypeScript · אלגוריתמים', en: 'TypeScript · Algorithms' },
      text: {
        he: 'משחק מאסטרמיינד עם פותר מובנה (minimax של Knuth) שמפצח כל קוד ב־5 ניחושים לכל היותר, רמזים, ומצב שבו המחשב מנחש את הקוד שלכם.',
        en: "Mastermind with a built-in solver (Knuth's minimax) that cracks any code in at most 5 guesses, hints, and a mode where the computer guesses your code.",
      },
      stack: ['TypeScript', 'Vite', 'Vitest'],
      img: 'img/mastermind.webp',
      links: [
        { k: 'playGame', href: 'https://izikstar.github.io/MasterMindTS/' },
        { k: 'code', href: 'https://github.com/IzikStar/MasterMindTS' },
      ],
    },
    {
      name: { he: 'סוליטר', en: 'Solitaire' },
      tag: { he: 'React · 2024', en: 'React · 2024' },
      text: {
        he: 'סוליטר קלונדייק עם היסטוריית undo/redo, רמזים, גרירה, סיום אוטומטי כשכל הקלפים גלויים, אנימציות וסאונד. פרויקט לימודי שבניתי עם חבר לכיתה ב־2024 ושופץ ב־2026.',
        en: 'Klondike solitaire with undo/redo history, hints, drag and drop, auto-finish once every card is face up, animations and sound. A learning project built with a classmate in 2024 and polished in 2026.',
      },
      stack: ['React', 'Vite', 'Tailwind', 'react-dnd', 'GSAP'],
      img: 'img/solitaire.webp',
      links: [
        { k: 'playGame', href: 'https://itschakasafreactproject.netlify.app/' },
        { k: 'code', href: 'https://github.com/IzikStar/solitaire_0.1' },
      ],
    },
  ];

  const STACK = ['TypeScript', 'JavaScript', 'Java', 'SQL', 'React', 'Redux Toolkit', 'NestJS', 'Node.js', 'Spring Boot', 'PostgreSQL', 'Redis', 'JWT / OAuth 2.0 / SSO', 'Docker', 'OpenShift'];

  const TIMELINE = [
    {
      when: { he: '2024 עד 2026', en: '2024 to 2026' },
      what: { he: 'מפתח Full-Stack, חיל האוויר', en: 'Full-stack developer, Israeli Air Force' },
      detail: {
        he: 'אימות בארכיטקטורת 8 שירותים, אלגוריתמים, תשתית רגרסיה',
        en: 'Auth across 8 services, algorithms, a regression framework',
      },
    },
    {
      when: { he: 'דצמבר 2026', en: 'December 2026' },
      what: { he: 'פנוי לתפקיד הבא', en: 'Open to the next role' },
      detail: { he: 'Full-Stack או Backend', en: 'Full-stack or backend' },
    },
  ];

  // ---------- language ----------
  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch { /* storage blocked */ }
    },
  };
  const fromUrl = new URLSearchParams(location.search).get('lang');
  let lang = ['he', 'en'].includes(fromUrl) ? fromUrl
    : store.get('lang') ?? ((navigator.language || '').toLowerCase().startsWith('he') ? 'he' : 'en');
  const t = (k) => STR[lang][k] ?? k;
  const pick = (v) => (v && typeof v === 'object' ? v[lang] : v);

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }

  function renderProjects() {
    const root = document.getElementById('projects');
    root.replaceChildren(
      ...PROJECTS.map((p) => {
        const links = el('div', { class: 'links' }, ...p.links.map((l) => el('a', { href: l.href, rel: 'noopener', text: `${t(l.k)} ↗` })));
        if (p.links.every((l) => l.k !== 'code')) links.append(el('span', { text: t('privateCode') }));
        const media = p.img
          ? el('img', { src: p.img, alt: `${pick(p.name)} screenshot`, loading: 'lazy' })
          : el('dl', { class: 'facts' }, ...p.facts.map((f) => el('div', {}, el('dt', { text: f[lang] }), el('dd', { text: pick(f.v) }))));
        return el(
          'article',
          { class: 'project' },
          el(
            'div',
            { class: 'text' },
            el('span', { class: 'tag', text: pick(p.tag) }),
            el('h3', { text: pick(p.name) }),
            el('p', { text: pick(p.text) }),
            el('ul', { class: 'chips' }, ...p.stack.map((s) => el('li', { text: s }))),
            links,
          ),
          el('div', { class: 'media' }, media),
        );
      }),
    );
    document.getElementById('stack').replaceChildren(...STACK.map((s) => el('li', { text: s })));
    document.getElementById('timeline').replaceChildren(
      ...TIMELINE.map((x) => el('li', {}, el('span', { class: 'when', text: pick(x.when) }), el('strong', { text: pick(x.what) }), el('span', { text: pick(x.detail) }))),
    );
  }


  // ---------- sections ----------
  const ORDER = ['code', 'music', 'voice', 'sketches', 'writing', 'about', 'contact'];
  const MEDIA = ['music', 'voice', 'sketches', 'writing'];
  let site = { sections: Object.fromEntries(ORDER.map((s) => [s, true])), intros: {}, items: [] };
  const itemsOf = (s) => site.items.filter((i) => i.section === s);
  // A section shows when it is switched on, and (for media) has something in it.
  const shown = (s) => site.sections[s] !== false && (!MEDIA.includes(s) || itemsOf(s).length > 0);

  function renderLayout() {
    document.querySelectorAll('[data-section]').forEach((n) => (n.hidden = !shown(n.dataset.section)));
    document.getElementById('nav').replaceChildren(
      ...ORDER.filter(shown).map((s) => el('a', { href: `#${s}`, text: t(`nav.${s}`) })),
    );
    // Roles follow the sections that are switched on, even before anything is uploaded.
    document.getElementById('roles').replaceChildren(
      ...['code', 'music', 'writing', 'voice', 'sketches'].filter((s) => site.sections[s] !== false).map((s) => el('span', { text: t(`role.${s}`) })),
    );
    const cta = document.getElementById('hero-cta');
    const first = ORDER.find(shown);
    cta.hidden = !first || first === 'about' || first === 'contact';
    if (first) cta.href = `#${first}`;
  }

  // ---------- media ----------
  const player = document.getElementById('player');
  let current = null;
  const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';
  const fmt = (s) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
  const fileUrl = (i) => `api/file/${i.id}`;

  function playButton(item) {
    const btn = el('button', { class: 'play', type: 'button', 'data-play': item.id });
    btn.addEventListener('click', () => toggle(item));
    return btn;
  }

  function seekBar(item) {
    const seek = el('div', { class: 'seek', 'data-seek': item.id, 'aria-hidden': 'true' }, el('i'));
    seek.addEventListener('click', (e) => {
      if (current !== item.id || !player.duration) return;
      const r = seek.getBoundingClientRect();
      let x = (e.clientX - r.left) / r.width;
      if (getComputedStyle(seek).direction === 'rtl') x = 1 - x;
      player.currentTime = x * player.duration;
    });
    return seek;
  }

  function openLinks(item) {
    const links = el('div', { class: 'links' });
    if (item.hasFile && item.kind !== 'audio' && item.kind !== 'video') {
      links.append(el('a', { href: fileUrl(item), target: '_blank', rel: 'noopener', text: `${t(`open.${item.kind}`)} ↗` }));
    }
    if (item.link) {
      let host = '';
      try { host = new URL(item.link).hostname.replace(/^www\./, ''); } catch { /* shown without host */ }
      links.append(el('a', { href: item.link, target: '_blank', rel: 'noopener', text: `${t('open.link')} ${host} ↗` }));
    }
    return links.childElementCount ? links : null;
  }

  function row(item) {
    const audio = item.kind === 'audio';
    const cover = item.hasCover ? el('img', { class: 'cover', src: `api/cover/${item.id}`, alt: '', loading: 'lazy' }) : null;
    return el(
      'li',
      { class: `row${cover ? '' : ' nocover'}`, 'data-id': item.id },
      audio ? playButton(item) : el('span', { class: 'play ghost', 'aria-hidden': 'true', text: item.kind === 'video' ? '▶' : '↗' }),
      cover,
      el('div', { class: 'info' }, el('span', { class: 'title', dir: 'auto', text: item.title }), item.note ? el('span', { class: 'note', dir: 'auto', text: item.note }) : null, audio ? null : openLinks(item)),
      el('span', { class: 'time', 'data-time': item.id, text: fmt(item.duration) }),
      audio ? seekBar(item) : null,
    );
  }

  function card(item) {
    let media = null;
    if (item.kind === 'video') media = el('video', { src: fileUrl(item), controls: '', preload: 'metadata', playsinline: '', ...(item.hasCover ? { poster: `api/cover/${item.id}` } : {}) });
    else if (item.hasCover) media = el('img', { src: `api/cover/${item.id}`, alt: '', loading: 'lazy' });
    else if (item.kind === 'image') media = el('img', { src: fileUrl(item), alt: item.title, loading: 'lazy' });
    const audio = item.kind === 'audio'
      ? el('div', { class: 'card-audio' }, playButton(item), el('span', { class: 'time', 'data-time': item.id, text: fmt(item.duration) }), seekBar(item))
      : null;
    return el(
      'article',
      { class: 'card', 'data-id': item.id },
      media ? el('div', { class: 'card-media' }, media) : null,
      el('div', { class: 'card-body' }, el('h3', { dir: 'auto', text: item.title }), item.note ? el('p', { dir: 'auto', text: item.note }) : null, audio, openLinks(item)),
    );
  }

  function renderMedia() {
    document.querySelectorAll('.media-section').forEach((sec) => {
      const name = sec.dataset.section;
      const items = itemsOf(name);
      const intro = sec.querySelector('[data-intro]');
      intro.textContent = site.intros[name] || '';
      intro.dir = 'auto';
      intro.hidden = !intro.textContent;
      sec.querySelector('[data-count]').textContent = items.length ? t('count')(items.length) : '';
      sec.querySelector('[data-items]').replaceChildren(...items.map(sec.dataset.layout === 'list' ? row : card));
    });
    syncPlayer();
  }

  function syncPlayer() {
    document.querySelectorAll('[data-play]').forEach((b) => {
      const on = b.dataset.play === current && !player.paused;
      const item = site.items.find((i) => i.id === b.dataset.play);
      b.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
      b.setAttribute('aria-label', `${on ? t('pause') : t('play')}: ${item?.title ?? ''}`);
    });
    document.querySelectorAll('[data-seek]').forEach((s) => s.classList.toggle('on', s.dataset.seek === current));
    document.querySelectorAll('.row, .card').forEach((r) => r.classList.toggle('active', r.dataset.id === current));
  }

  function toggle(item) {
    if (current === item.id) {
      player.paused ? player.play().catch(() => {}) : player.pause();
      return;
    }
    if (current) {
      const prev = site.items.find((i) => i.id === current);
      const time = document.querySelector(`[data-time="${current}"]`);
      if (time) time.textContent = fmt(prev?.duration);
    }
    current = item.id;
    player.src = fileUrl(item);
    player.play().catch(() => {});
    syncPlayer();
  }

  ['play', 'pause'].forEach((ev) => player.addEventListener(ev, syncPlayer));
  player.addEventListener('timeupdate', () => {
    if (!player.duration) return;
    const bar = document.querySelector(`[data-seek="${current}"] i`);
    if (bar) bar.style.width = `${(player.currentTime / player.duration) * 100}%`;
    const time = document.querySelector(`[data-time="${current}"]`);
    if (time) time.textContent = `${fmt(player.currentTime) || '0:00'} / ${fmt(player.duration)}`;
  });
  player.addEventListener('ended', () => {
    const playlist = site.items.filter((i) => i.kind === 'audio' && shown(i.section));
    const i = playlist.findIndex((x) => x.id === current);
    if (i >= 0 && i < playlist.length - 1) toggle(playlist[i + 1]);
    else syncPlayer();
  });
  // One sound at a time: starting a video pauses the music and vice versa.
  document.addEventListener('play', (e) => {
    if (e.target instanceof HTMLVideoElement) player.pause();
    else if (e.target === player) document.querySelectorAll('video').forEach((v) => v.pause());
  }, true);

  // ---------- page ----------
  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((n) => {
      n.textContent = t(n.dataset.i18n);
    });
    document.getElementById('lang-toggle').textContent = lang === 'he' ? 'EN' : 'עב';
    document.title = lang === 'he' ? 'יצחק שטרן' : 'Itschak Shteren';
    renderProjects();
    renderLayout();
    renderMedia();
  }

  document.getElementById('lang-toggle').addEventListener('click', () => {
    lang = lang === 'he' ? 'en' : 'he';
    store.set('lang', lang);
    applyLang();
  });

  document.getElementById('copy-email').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText('itschakme@gmail.com');
      btn.textContent = t('contact.copied');
      setTimeout(() => (btn.textContent = t('contact.copy')), 1800);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.contact .email'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });

  async function load() {
    try {
      const res = await fetch('api/site', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      site = await res.json();
    } catch {
      // Without the API the portfolio still shows; creative sections stay hidden.
    }
    renderLayout();
    renderMedia();
  }

  applyLang();
  load();
})();
