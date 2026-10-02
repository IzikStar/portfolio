// Portfolio front end: language switch, project list, music player.
(() => {
  const STR = {
    he: {
      name: 'יצחק שטרן',
      'nav.code': 'קוד',
      'nav.music': 'מוזיקה',
      'nav.about': 'עליי',
      'nav.contact': 'יצירת קשר',
      'hero.avail': 'פנוי לעבודה מדצמבר 2026',
      'hero.role1': 'מפתח Full-Stack',
      'hero.role2': 'מוזיקאי',
      'hero.role3': 'כותב',
      'hero.lede':
        'בשנתיים האחרונות אני בונה מערכות פרודקשן בחיל האוויר: אימות משתמשים בארכיטקטורה של 8 שירותים, תכנון מחדש של אלגוריתמים ותשתית רגרסיה שמאמתת כ־120,000 מקרים הנדסיים. מחוץ לקוד אני מנגן, כותב ומלחין.',
      'hero.cta': 'לפרויקטים',
      'code.title': 'פרויקטים',
      'code.kicker': 'קוד פתוח ב־GitHub, אלא אם צוין אחרת',
      'music.title': 'מוזיקה',
      'music.intro': 'שירים ויצירות שהקלטתי. לחצו על שיר כדי לנגן.',
      'music.empty': 'השירים הראשונים יעלו לכאן בקרוב.',
      'music.count': (n) => (n === 1 ? 'שיר אחד' : `${n} שירים`),
      'music.play': 'נגן',
      'music.pause': 'השהה',
      'about.title': 'עליי',
      'about.p1':
        'אני מפתח Full-Stack עם ניסיון בפרודקשן ב־TypeScript, React, NestJS, Java ו־PostgreSQL. אני אוהב את החלקים שמתחת למכסה המנוע: אימות והרשאות, אלגוריתמים, ובדיקות שמאפשרות לשנות קוד בלי לפחד.',
      'about.p2': 'אני גם מוזיקאי וכותב, וכנראה בגלל זה אכפת לי איך דברים מרגישים לאדם שמשתמש בהם.',
      'contact.title': 'יצירת קשר',
      'contact.copy': 'העתקת כתובת',
      'contact.copied': 'הועתק',
      footer: 'נבנה ביד עם HTML, CSS ו־Cloudflare Workers.',
      code: 'קוד',
      live: 'אתר חי',
      play: 'לשחק',
      privateCode: 'הקוד פרטי',
    },
    en: {
      name: 'Itschak Shteren',
      'nav.code': 'Code',
      'nav.music': 'Music',
      'nav.about': 'About',
      'nav.contact': 'Contact',
      'hero.avail': 'Available from December 2026',
      'hero.role1': 'Full-stack developer',
      'hero.role2': 'Musician',
      'hero.role3': 'Writer',
      'hero.lede':
        'For the last two years I have built production systems in the Israeli Air Force: authentication across an 8-service architecture, algorithm redesigns, and a regression framework that validates about 120,000 engineering cases. Away from code I play, write and compose.',
      'hero.cta': 'See projects',
      'code.title': 'Projects',
      'code.kicker': 'Open source on GitHub unless noted',
      'music.title': 'Music',
      'music.intro': 'Songs and pieces I have recorded. Pick one to play it.',
      'music.empty': 'The first songs will be up here soon.',
      'music.count': (n) => (n === 1 ? '1 track' : `${n} tracks`),
      'music.play': 'Play',
      'music.pause': 'Pause',
      'about.title': 'About',
      'about.p1':
        'I am a full-stack developer with production experience in TypeScript, React, NestJS, Java and PostgreSQL. I like the parts under the hood: authentication and permissions, algorithms, and tests that let you change code without fear.',
      'about.p2': 'I am also a musician and a writer, which is probably why I care about how things feel to the person using them.',
      'contact.title': 'Contact',
      'contact.copy': 'Copy address',
      'contact.copied': 'Copied',
      footer: 'Hand-built with HTML, CSS and Cloudflare Workers.',
      code: 'Code',
      live: 'Live site',
      play: 'Play it',
      privateCode: 'Code is private',
    },
  };

  const PROJECTS = [
    {
      name: { he: 'מנוע שחמט', en: 'Chess engine' },
      tag: { he: 'Java · אלגוריתמים', en: 'Java · Algorithms' },
      text: {
        he: 'משחק שחמט עם מנוע שכתבתי מאפס: ייצוג לוח ב־bitboards וחיפוש alpha-beta, עם אפשרות לשחק מול Stockfish. הקוד עבר ריפקטור מתועד בשלבים, כשכל שלב מגובה בבדיקות.',
        en: 'A chess game with an engine written from scratch: bitboard board representation and alpha-beta search, with optional Stockfish play. The code went through a documented, phased refactor, each phase backed by tests.',
      },
      stack: ['Java', 'Swing', 'Maven', 'JUnit'],
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
        he: 'משחק מאסטרמיינד עם פותר מובנה (minimax של Knuth) שמפצח כל קוד לכל היותר 5 ניחושים, רמזים, ומצב שבו המחשב מנחש את הקוד שלכם.',
        en: "Mastermind with a built-in solver (Knuth's minimax) that cracks any code in at most 5 guesses, hints, and a mode where the computer guesses your code.",
      },
      stack: ['TypeScript', 'Vite', 'Vitest'],
      img: 'img/mastermind.webp',
      links: [
        { k: 'play', href: 'https://izikstar.github.io/MasterMindTS/' },
        { k: 'code', href: 'https://github.com/IzikStar/MasterMindTS' },
      ],
    },
    {
      name: { he: 'סוליטר', en: 'Solitaire' },
      tag: { he: 'React · 2024', en: 'React · 2024' },
      text: {
        he: 'סוליטר קלונדייק עם היסטוריית undo/redo, אנימציות וסאונד. פרויקט לימודי שבניתי עם חבר לכיתה.',
        en: 'Klondike solitaire with undo/redo history, animations and sound. A learning project built with a classmate.',
      },
      stack: ['React', 'Vite', 'GSAP', 'Tailwind'],
      img: 'img/solitaire.webp',
      links: [{ k: 'code', href: 'https://github.com/IzikStar/solitaire_0.1' }],
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

  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((n) => {
      n.textContent = t(n.dataset.i18n);
    });
    document.getElementById('lang-toggle').textContent = lang === 'he' ? 'EN' : 'עב';
    document.title = lang === 'he' ? 'יצחק שטרן' : 'Itschak Shteren';
    renderProjects();
    renderTracks();
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

  // ---------- music ----------
  let tracks = [];
  let current = null;
  const player = document.getElementById('player');
  const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';

  const fmt = (s) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

  function renderTracks() {
    const list = document.getElementById('tracks');
    document.getElementById('tracks-empty').hidden = tracks.length > 0;
    document.getElementById('track-count').textContent = tracks.length ? STR[lang]['music.count'](tracks.length) : '';
    list.replaceChildren(
      ...tracks.map((tr, i) => {
        const playing = current === tr.id && !player.paused;
        const btn = el('button', { class: 'play', type: 'button', 'aria-label': `${playing ? t('music.pause') : t('music.play')}: ${tr.title}` });
        btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
        btn.addEventListener('click', () => toggle(tr));
        const seek = el('div', { class: 'seek', role: 'slider', 'aria-label': tr.title, tabindex: '-1' }, el('i'));
        seek.addEventListener('click', (e) => {
          if (current !== tr.id || !player.duration) return;
          const r = seek.getBoundingClientRect();
          let x = (e.clientX - r.left) / r.width;
          if (getComputedStyle(seek).direction === 'rtl') x = 1 - x;
          player.currentTime = x * player.duration;
        });
        const li = el(
          'li',
          { class: `track${current === tr.id ? ' active' : ''}${tr.hasCover ? '' : ' nocover'}`, 'data-id': tr.id },
          btn,
          tr.hasCover ? el('img', { class: 'cover', src: `api/cover/${tr.id}`, alt: '', loading: 'lazy' }) : null,
          el('div', { class: 'info' }, el('span', { class: 'title', dir: 'auto', text: tr.title }), tr.note ? el('span', { class: 'note', dir: 'auto', text: tr.note }) : null),
          el('span', { class: 'time', text: fmt(tr.duration) }),
          seek,
        );
        li.dataset.n = String(i + 1);
        return li;
      }),
    );
  }

  function toggle(tr) {
    if (current === tr.id) {
      player.paused ? player.play() : player.pause();
      return;
    }
    current = tr.id;
    player.src = `api/audio/${tr.id}`;
    player.play().catch(() => {});
    renderTracks();
  }

  ['play', 'pause', 'ended'].forEach((ev) => player.addEventListener(ev, renderTracks));
  player.addEventListener('timeupdate', () => {
    const bar = document.querySelector(`.track[data-id="${current}"] .seek i`);
    if (bar && player.duration) bar.style.width = `${(player.currentTime / player.duration) * 100}%`;
    const time = document.querySelector(`.track[data-id="${current}"] .time`);
    if (time && player.duration) time.textContent = `${fmt(player.currentTime) || '0:00'} / ${fmt(player.duration)}`;
  });
  player.addEventListener('ended', () => {
    const i = tracks.findIndex((x) => x.id === current);
    if (i >= 0 && i < tracks.length - 1) toggle(tracks[i + 1]);
  });

  async function loadTracks() {
    try {
      const res = await fetch('api/tracks', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      tracks = await res.json();
    } catch {
      tracks = [];
    }
    renderTracks();
  }

  applyLang();
  loadTracks();
})();
