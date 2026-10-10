// Studio: the owner's private workspace. Idea notebook, a studio per wing,
// the item editor, projects, comments and the community.
// Routes (hash): #ideas, #wing/<wing>, #space/<id>, #item/<id>, #new/<spaceId>/<kind>,
// #projects, #project/<id>, #project-new, #cv (studio-cv.js), #comments, #blog, #community, #trash, #settings. (#edit/<id> and #articles still work.)
(() => {
  const $ = (id) => document.getElementById(id);
  const VIS = { private: 'רק אני', community: 'לקהילות', members: 'לחברים', public: 'לכולם' };
  const KIND = {
    song: 'שיר', chapter: 'פרק', sketch: 'מערכון', dub: 'דיבוב', humor: 'הומור', torah: 'דבר תורה',
    article: 'מאמר', project: 'פרויקט', work: 'יצירה', video: 'סרטון', idea: 'רעיון',
  };
  // What each wing holds; the first kind is the default for a new item.
  const WING_KINDS = {
    music: ['song', 'video'], books: ['chapter'], sketches: ['sketch', 'video'], humor: ['dub', 'humor', 'video'],
    torah: ['torah'], articles: ['article'], software: ['project'], videos: ['video'],
  };
  const SPACE_KIND = { book: 'ספר', series: 'סדרה', genre: 'ז\'אנר', collection: 'אוסף' };
  const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmt = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');

  function h(tag, props = {}, ...kids) {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null && k !== false) n.append(k);
    return n;
  }
  function say(id, text, kind = '') {
    $(id).textContent = text;
    $(id).className = `msg ${kind}`;
  }
  const debounce = (fn, ms) => {
    let t;
    const d = (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
    d.cancel = () => clearTimeout(t);
    return d;
  };

  // ---------- on a phone ----------
  // The sidebar is a bar with a menu button; the button names where you are
  // and adds up the sidebar's counts. Long forms fold their details away.
  const phone = matchMedia('(max-width: 700px)');
  function setNav(open) {
    document.querySelector('.studio-side').classList.toggle('open', open);
    document.body.classList.toggle('nav-open', open);
    document.getElementById('nav-toggle').setAttribute('aria-expanded', String(open));
  }
  function showNavCurrent() {
    const a = document.querySelector('.studio-side [aria-current="page"]');
    const name = a ? [...a.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim() : '';
    document.getElementById('nav-current').textContent = name || 'תפריט';
  }
  function showNavBadge() {
    // What waits for you: comments, join requests, members to approve.
    const n = ['comment-count', 'request-count', 'pending-count'].map((id) => document.getElementById(id)).reduce((sum, c) => sum + (parseInt(c.textContent.replace(/\D/g, ''), 10) || 0), 0);
    const badge = document.getElementById('nav-badge');
    // Only on a change: this runs from an observer on the sidebar itself.
    if (badge.textContent !== String(n || '')) badge.textContent = n || '';
  }
  document.getElementById('nav-toggle').addEventListener('click', () => setNav(!document.querySelector('.studio-side').classList.contains('open')));
  document.querySelector('.studio-side').addEventListener('click', (e) => {
    if (e.target.closest('a')) setNav(false);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setNav(false));
  phone.addEventListener('change', () => setNav(false));
  new MutationObserver(showNavBadge).observe(document.querySelector('.studio-side'), { subtree: true, childList: true, characterData: true });
  for (const [btn, box] of [['ed-more-toggle', 'ed-more'], ['s-more-toggle', 's-more']]) {
    document.getElementById(btn).addEventListener('click', () => foldOpen(btn, box, !document.getElementById(box).classList.contains('open')));
  }
  function foldOpen(btn, box, open) {
    document.getElementById(box).classList.toggle('open', open);
    document.getElementById(btn).setAttribute('aria-expanded', String(open));
  }

  class AuthError extends Error {}
  async function call(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.endsWith('/login')) {
      showLogin('הכניסה פגה. צריך להיכנס שוב.');
      throw new AuthError();
    }
    if (!res.ok) throw Object.assign(new Error(data.error || `שגיאה ${res.status}`), { data, status: res.status });
    return data;
  }
  const send = (path, method, body) => call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  // The writing partner answers as a stream of plain text (src/muse.js). The
  // text shows as it arrives; a last line starting with ⟂ says how it ended.
  async function stream(path, body, onText) {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        showLogin('הכניסה פגה. צריך להיכנס שוב.');
        throw new AuthError();
      }
      throw new Error(data.error || `שגיאה ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
      onText(text.split('\n\n⟂')[0]);
    }
    const [answer, end = ''] = text.split('\n\n⟂');
    if (end.startsWith('refusal')) throw new Error('העוזר לא הסכים לענות על זה. אפשר לנסח אחרת.');
    if (end.startsWith('error')) throw new Error(end.slice(6) || 'העוזר נתקע באמצע.');
    return { text: answer.trim(), cut: end.startsWith('cut') };
  }
  const report = (id) => (err) => {
    if (!(err instanceof AuthError)) say(id, err.message, 'err');
  };
  // The CV view lives in studio-cv.js.
  const cvView = window.studioCv({ call, send, h, AuthError, wingOf: (id) => wingOf(id) });

  // ---------- login ----------
  function showLogin(message = '') {
    $('app').hidden = true;
    $('login').hidden = false;
    say('login-msg', message, message ? 'err' : '');
    $('password').focus();
  }
  $('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('login-msg', 'בודק...');
    try {
      await send('/api/admin/login', 'POST', { password: $('password').value });
      $('password').value = '';
      start();
    } catch (err) {
      say('login-msg', err.message === 'Wrong password.' ? 'סיסמה שגויה.' : err.message, 'err');
    }
  });
  $('logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------- spaces (wings and what is inside them) and communities ----------
  const state = { spaces: [], byId: new Map(), comms: [], commById: new Map() };
  async function loadSpaces() {
    const [{ spaces }] = await Promise.all([call('/api/studio/spaces'), loadComms()]);
    state.spaces = spaces;
    state.byId = new Map(spaces.map((x) => [x.id, x]));
    return spaces;
  }
  async function loadComms() {
    const { communities } = await call('/api/studio/communities');
    state.comms = communities;
    state.commById = new Map(communities.map((c) => [c.id, c]));
    // Join requests waiting, counted on the sidebar.
    const n = communities.reduce((sum, c) => sum + c.requests, 0);
    $('request-count').textContent = n || '';
    return communities;
  }

  // A row of checkboxes, one per community, inside a fieldset with a .picks div.
  function pickComms(box, chosen = [], onchange = null) {
    const picks = box.querySelector('.picks');
    picks.replaceChildren(
      ...state.comms.map((c) =>
        h(
          'label',
          { className: 'pick' },
          h('input', { type: 'checkbox', value: c.id, checked: chosen.includes(c.id), onchange }),
          h('span', { dir: 'auto', textContent: c.title }),
          c.hidden ? h('small', { textContent: ' (נסתרת)' }) : null,
        ),
      ),
      ...(state.comms.length ? [] : [h('a', { href: '#communities', textContent: 'עוד אין קהילות. ליצירת קהילה' })]),
    );
  }
  const pickedComms = (box) => [...box.querySelectorAll('.picks input:checked')].map((i) => i.value);
  const wingOf = (id) => {
    let x = state.byId.get(id);
    while (x?.parentId) x = state.byId.get(x.parentId);
    return x;
  };
  const spaceLabel = (x) => (x.parentId ? `${x.title}` : `${x.title} (האגף עצמו)`);
  const pathOf = (x) => (x.parentId ? `/${x.wing}/${encodeURIComponent(x.slug)}` : `/${x.id}`);
  const itemPath = (e) => {
    const x = state.byId.get(e.spaceId);
    return x && e.slug ? `${pathOf(x)}/${encodeURIComponent(e.slug)}` : null;
  };
  const inside = (rootId) => {
    const ids = [rootId];
    for (let i = 0; i < ids.length; i++) for (const x of state.spaces) if (x.parentId === ids[i]) ids.push(x.id);
    return ids;
  };

  // ---------- routing ----------
  // "לאתר" (the sidebar's foot, and the bar on a phone) leads to the site page
  // of whatever is open here; views that know their page set it when they load.
  const SITE_FOR = { community: '/community', person: '/community', communities: '/community', group: '/community', blog: '/community', comments: '/community', cv: '/cv', projects: '/software', project: '/software' };
  function siteHere(path) {
    for (const a of document.querySelectorAll('.to-site')) a.href = path || '/';
  }

  async function route() {
    const hash = location.hash.slice(1) || 'ideas';
    const [view, id, extra] = hash.split('/');
    if (view === 'articles') return void (location.hash = '#wing/articles');
    if (view === 'edit' && id) return void (location.hash = `#item/${id}`);
    if (!state.spaces.length) await loadSpaces().catch(() => {});
    let tab = view;
    if (view === 'wing' || (view === 'ideas' && WING_KINDS[id])) tab = `wing/${id}`;
    else if (view === 'space' || view === 'new') tab = `wing/${wingOf(id)?.id}`;
    else if (view === 'project' || view === 'project-new') tab = 'projects';
    else if (view === 'group') tab = 'communities';
    else if (view === 'person') tab = 'community';
    for (const a of document.querySelectorAll('.studio-side [data-tab]')) {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    showNavCurrent();
    $('view-ideas').hidden = view !== 'ideas';
    $('view-wing').hidden = view !== 'wing';
    $('view-space').hidden = view !== 'space';
    $('view-community').hidden = view !== 'community';
    $('view-person').hidden = view !== 'person';
    $('view-communities').hidden = view !== 'communities';
    $('view-group').hidden = view !== 'group';
    $('view-comments').hidden = view !== 'comments';
    $('view-blog').hidden = view !== 'blog';
    $('view-settings').hidden = view !== 'settings';
    $('view-trash').hidden = view !== 'trash';
    $('view-cv').hidden = view !== 'cv';
    $('view-projects').hidden = view !== 'projects';
    $('view-project').hidden = view !== 'project' && view !== 'project-new';
    $('view-edit').hidden = view !== 'item' && view !== 'new';
    siteHere(SITE_FOR[view] ?? '/');
    if (view !== 'person') personView.id = null;
    if (view === 'ideas') openNotebook(WING_KINDS[id] ? id : '');
    else if (view === 'wing' && WING_KINDS[id]) openWing(id);
    else if (view === 'space' && id) openSpace(id);
    else if (view === 'community') loadCommunity();
    else if (view === 'person' && id) openPerson(id);
    else if (view === 'communities') loadGroups();
    else if (view === 'group' && id) openGroup(id);
    else if (view === 'comments') loadComments();
    else if (view === 'blog') loadBlog();
    else if (view === 'settings') loadSettings();
    else if (view === 'trash') loadTrash();
    else if (view === 'cv') cvView.open();
    else if (view === 'projects') loadProjects();
    else if (view === 'project-new') openProject(null);
    else if (view === 'project' && id) openProject(id);
    else if (view === 'new' && id) openEditor(null, { spaceId: id, kind: extra });
    else if (view === 'item' && id) openEditor(id);
    else location.hash = '#ideas';
  }
  let current = location.hash;
  window.addEventListener('hashchange', () => {
    if ((editor.dirty || project.dirty || (cvView.dirty() && $('view-cv').hidden === false)) && !confirm('יש שינויים שלא נשמרו. לצאת בכל זאת?')) {
      history.replaceState(null, '', current);
      return;
    }
    editor.flush.cancel();
    editor.dirty = false;
    project.dirty = false;
    cvView.clean();
    current = location.hash;
    route();
  });

  // ---------- ideas ----------
  // The notebook: one-tap capture (text, a voice memo, a photo), a spark to
  // start from, an old idea that comes back, and every idea by wing or tag.
  // The whole list is loaded once and filtered here, so it stays quick on a phone.
  const WING_NAME = {
    music: 'מוזיקה', books: 'ספרים', sketches: 'מערכונים', humor: 'דיבובים והומור',
    torah: 'דברי תורה', articles: 'מאמרים', software: 'תוכנה', videos: 'סרטונים',
  };
  const WING_IDS = Object.keys(WING_NAME);
  const DAY = 86_400_000;
  const SAVED = ['נשמר.', 'נכנס למחברת.', 'תפוס.', 'רשום.'];
  // open: the ideas unfolded on this visit. Every card starts folded.
  const ideasView = { list: [], sparks: null, wing: '', tag: '', spark: null, oldId: null, pending: null, answering: '', scope: '', open: new Set() };
  const shortDate = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' });
  const longDate = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
  const when = (iso) => (new Date(iso).getFullYear() === new Date().getFullYear() ? shortDate : longDate).format(new Date(iso));
  const pickOne = (list, not) => {
    const pool = list.length > 1 ? list.filter((x) => x !== not) : list;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  };
  const pressed = (n, on) => {
    n.setAttribute('aria-pressed', String(Boolean(on)));
    return n;
  };
  const wingOptions = (sel, first) =>
    sel.replaceChildren(h('option', { value: '', textContent: first }), ...WING_IDS.map((w) => h('option', { value: w, textContent: WING_NAME[w] })));
  wingOptions($('capture-wing'), 'לאיזה אגף? (לא חייב)');
  wingOptions($('spark-wing'), 'מכל האגפים');

  // "לפני שבועיים", "לפני 3 חודשים": how long an idea has been waiting.
  function ago(iso) {
    const days = Math.floor((Date.now() - Date.parse(iso)) / DAY);
    if (days < 1) return 'היום';
    if (days < 2) return 'אתמול';
    if (days < 14) return `לפני ${days} ימים`;
    if (days < 56) {
      const w = Math.round(days / 7);
      return w === 2 ? 'לפני שבועיים' : `לפני ${w} שבועות`;
    }
    if (days < 345) {
      const m = Math.round(days / 30.4);
      return m === 2 ? 'לפני חודשיים' : `לפני ${m} חודשים`;
    }
    const y = Math.max(1, Math.round(days / 365));
    return y === 1 ? 'לפני שנה' : y === 2 ? 'לפני שנתיים' : `לפני ${y} שנים`;
  }

  // A wing's notebook (#ideas/<wing>) is the same page kept to that wing:
  // what is written there belongs to it, its sparks, its own writing helpers.
  const PLACEHOLDER = {
    '': 'מה עובר לך בראש?',
    music: 'שורה, לחן, אקורד שתפס...',
    books: 'סצנה, דמות, חור בעלילה...',
    sketches: 'מצב מצחיק, דמות, שורת סיום...',
    humor: 'קטע לדבב, קול, שורה...',
    torah: 'פסוק שהפריע, קושיה...',
    articles: 'טענה, משהו שמציק לך...',
    software: 'כלי שהיית רוצה שיהיה...',
    videos: 'הוק, שוט, משהו שרק מצלמה יכולה להראות...',
  };
  function openNotebook(scope) {
    ideasView.scope = scope;
    ideasView.wing = '';
    const page = $('view-ideas');
    if (scope) page.dataset.wing = scope;
    else delete page.dataset.wing;
    $('ideas-title').textContent = scope ? `המחברת של ${WING_NAME[scope]}` : 'רעיונות';
    $('ideas-wing-link').hidden = !scope;
    $('ideas-wing-link').href = `#wing/${scope}`;
    $('capture-text').placeholder = PLACEHOLDER[scope] ?? PLACEHOLDER[''];
    $('capture-wing').value = scope;
    $('capture-wing').hidden = Boolean(scope);
    $('spark-wing').value = scope;
    $('spark-wing').hidden = Boolean(scope);
    $('idea-wings').hidden = Boolean(scope);
    $('ideas-empty').textContent = scope ? `המחברת של ${WING_NAME[scope]} ריקה. הניצוץ למעלה מחכה.` : 'עוד אין כאן כלום. מה שתזרוק למעלה נשמר כאן, רק אצלך.';
    ideasView.spark = null;
    ideasView.oldId = null;
    loadIdeas();
  }
  // The ideas this page shows: all of them, or the wing's.
  const scoped = () => (ideasView.scope ? ideasView.list.filter((i) => i.meta.wing === ideasView.scope) : ideasView.list);

  async function loadIdeas() {
    try {
      const [{ ideas }] = await Promise.all([call('/api/studio/ideas'), ideasView.sparks ? null : loadSparks(), loadMuse()]);
      ideasView.list = ideas;
      if (!ideasView.spark) nextSpark();
      if (!scoped().some((i) => i.id === ideasView.oldId)) nextOld();
      drawIdeas();
    } catch (err) {
      report('capture-msg')(err);
    }
  }

  // Server answers carry no files; keep the ones we already have.
  function replaceIdea(idea) {
    const i = ideasView.list.findIndex((x) => x.id === idea.id);
    if (i >= 0) ideasView.list[i] = { files: ideasView.list[i].files, ...idea };
    drawIdeas();
  }
  function dropIdea(id) {
    ideasView.list = ideasView.list.filter((x) => x.id !== id);
    if (ideasView.oldId === id) nextOld();
    drawIdeas();
  }

  const haystack = (i) => [i.title, i.body, i.meta.spark, ...i.tags, ...(i.meta.notes ?? []).map((n) => n.text)].join('\n').toLowerCase();

  function drawIdeas() {
    // Same order as the server: pinned first, then whatever was touched last.
    ideasView.list.sort((a, b) => b.pinned - a.pinned || b.updatedAt.localeCompare(a.updatedAt));
    const all = scoped();
    drawPulse(all);
    drawFilters(all);
    const q = $('idea-search').value.trim().toLowerCase();
    const { wing, tag } = ideasView;
    const shown = all.filter(
      (i) =>
        (!wing || (wing === 'none' ? !i.meta.wing : wing === 'pinned' ? i.pinned : i.meta.wing === wing)) &&
        (!tag || i.tags.includes(tag)) &&
        (!q || haystack(i).includes(q)),
    );
    $('ideas').replaceChildren(...shown.map((i) => ideaCard(i)));
    if (all.length && !shown.length) $('ideas').append(h('p', { className: 'empty', textContent: 'עם הסינון הזה אין כלום.' }));
    $('ideas-empty').hidden = all.length > 0;
    drawOld();
  }

  // This week (from Sunday), one dot per day. Counts, never a streak.
  function drawPulse(all) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const days = Array(7).fill(0);
    for (const i of all) {
      const d = new Date(i.createdAt);
      if (d >= start) days[d.getDay()]++;
    }
    const n = days.reduce((a, b) => a + b, 0);
    $('pulse').hidden = !all.length;
    $('pulse-text').textContent = n === 0 ? 'שבוע חדש, הדף פתוח.' : n === 1 ? 'השבוע זרקת לכאן רעיון אחד.' : `השבוע זרקת לכאן ${n} רעיונות.`;
    $('pulse-week').replaceChildren(
      ...days.map((c, d) => h('span', { className: [c ? 'on' : '', d === now.getDay() ? 'today' : '', d > now.getDay() ? 'later' : ''].join(' ').trim(), textContent: 'אבגדהוש'[d] })),
    );
  }

  function drawFilters(all) {
    const chip = (label, n, on, onclick, wing) => {
      const b = pressed(h('button', { type: 'button', onclick }, label, h('span', { className: 'n', textContent: String(n) })), on);
      if (wing) b.dataset.wing = wing;
      return b;
    };
    const pick = (value) => () => {
      ideasView.wing = ideasView.wing === value ? '' : value;
      drawIdeas();
    };
    const count = (f) => all.filter(f).length;
    const wings = [chip('הכל', all.length, !ideasView.wing, pick(''))];
    const pins = count((i) => i.pinned);
    if (pins) wings.push(chip('נעוצים', pins, ideasView.wing === 'pinned', pick('pinned')));
    for (const w of WING_IDS) {
      const n = count((i) => i.meta.wing === w);
      if (n || ideasView.wing === w) wings.push(chip(WING_NAME[w], n, ideasView.wing === w, pick(w), w));
    }
    const loose = count((i) => !i.meta.wing);
    if (loose && loose < all.length) wings.push(chip('בלי אגף', loose, ideasView.wing === 'none', pick('none')));
    $('idea-wings').replaceChildren(...(all.length ? wings : []));

    const tags = new Map();
    for (const i of all) for (const t of i.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    if (ideasView.tag && !tags.has(ideasView.tag)) ideasView.tag = '';
    const top = [...tags].sort((a, b) => b[1] - a[1]).slice(0, 24);
    $('idea-tags').replaceChildren(
      ...top.map(([t, n]) =>
        chip(`#${t}`, n, ideasView.tag === t, () => {
          ideasView.tag = ideasView.tag === t ? '' : t;
          drawIdeas();
        }),
      ),
    );
  }
  $('idea-search').addEventListener('input', debounce(drawIdeas, 120));

  function fileView(f) {
    if (f.kind === 'audio') return h('audio', { controls: true, preload: 'none', src: f.url });
    if (f.kind === 'video') return h('video', { controls: true, preload: 'none', src: f.url });
    if (f.kind === 'image') return h('a', { href: f.url, target: '_blank' }, h('img', { src: f.url, alt: f.name, loading: 'lazy' }));
    return h('a', { href: f.url, target: '_blank', dir: 'auto', textContent: f.name });
  }

  function ideaCard(idea) {
    const wing = idea.meta.wing;
    const node = h('article', { className: `idea${idea.pinned ? ' pinned' : ''}` });
    if (wing) node.dataset.wing = wing;
    // Folded, a card shows its title, a few lines and what is inside it;
    // a click on it unfolds the rest.
    const unfold = (on) => {
      node.classList.toggle('folded', !on);
      toggle.textContent = on ? 'קיפול' : 'פתיחה';
      toggle.setAttribute('aria-expanded', String(on));
      if (on) ideasView.open.add(idea.id);
      else ideasView.open.delete(idea.id);
    };
    const toggle = h('button', { className: 'quiet fold-toggle', type: 'button', onclick: () => unfold(node.classList.contains('folded')) });
    node.addEventListener('click', (e) => {
      if (node.classList.contains('folded') && !e.target.closest('a, button, select, input, textarea, audio, video, summary')) unfold(true);
    });
    const msg = h('small', { className: 'msg' });
    const panel = h('div', { className: 'panel' });
    const act = (label, fn, cls = '') => h('button', { className: `btn small ${cls}`, type: 'button', textContent: label, onclick: fn });
    const fail = (err) => {
      if (!(err instanceof AuthError)) {
        msg.textContent = err.message;
        msg.className = 'msg err';
      }
    };
    const tend = (body) => send(`/api/studio/ideas/${idea.id}`, 'PATCH', body).then(replaceIdea, fail);
    const close = () => panel.replaceChildren();

    const wingPick = h('select', { className: 'wing-pick', title: 'לאיזה אגף זה הולך' }, h('option', { value: '', textContent: 'בלי אגף' }), ...WING_IDS.map((w) => h('option', { value: w, textContent: WING_NAME[w] })));
    wingPick.value = wing ?? '';
    wingPick.addEventListener('change', () => tend({ wing: wingPick.value }));
    const pin = pressed(
      h('button', {
        className: 'quiet pin-toggle',
        type: 'button',
        textContent: idea.pinned ? '★' : '☆',
        title: idea.pinned ? 'נעוץ למעלה. ללחוץ כדי לשחרר' : 'לנעוץ למעלה',
        ariaLabel: 'נעוץ למעלה',
        onclick: () => send(`/api/studio/entries/${idea.id}`, 'PATCH', { pinned: !idea.pinned }).then(replaceIdea, fail),
      }),
      idea.pinned,
    );

    const addNote = () => {
      const area = h('textarea', { dir: 'auto', rows: 3, placeholder: 'מה עוד חשבת על זה?', ariaLabel: 'מחשבה נוספת' });
      const add = act('להוסיף', () => (area.value.trim() ? tend({ note: area.value }) : area.focus()), 'primary');
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add.click();
      });
      panel.replaceChildren(area, h('div', { className: 'actions' }, add, act('ביטול', close)));
      area.focus();
    };

    const grow = () => {
      const wingSel = h('select', {}, ...WING_IDS.map((w) => h('option', { value: w, textContent: WING_NAME[w] })));
      wingSel.value = wing ?? 'articles';
      const spaceSel = h('select');
      const kindSel = h('select');
      const fill = () => {
        const w = wingSel.value;
        const spaces = inside(w).map((id) => state.byId.get(id)).filter(Boolean);
        if (!spaces.length) spaces.push({ id: w, parentId: null });
        spaceSel.replaceChildren(...spaces.map((x) => h('option', { value: x.id, textContent: x.parentId ? x.title : 'האגף עצמו' })));
        kindSel.replaceChildren(...WING_KINDS[w].map((k) => h('option', { value: k, textContent: KIND[k] })));
      };
      wingSel.addEventListener('change', fill);
      fill();
      // Came back from being an item: start from where it was.
      const was = idea.meta.was;
      if (was && [...spaceSel.options].some((o) => o.value === was.spaceId)) spaceSel.value = was.spaceId;
      if (was && [...kindSel.options].some((o) => o.value === was.kind)) kindSel.value = was.kind;
      const field = (label, input) => h('label', { className: 'field' }, label, input);
      const go = act('לפתוח טיוטה', async () => {
        try {
          const e = await send(`/api/studio/ideas/${idea.id}/grow`, 'POST', { spaceId: spaceSel.value, kind: kindSel.value });
          window.scrollTo(0, 0);
          location.hash = e.kind === 'project' || e.kind === 'work' ? `#project/${e.id}` : `#item/${e.id}`;
        } catch (err) {
          fail(err);
        }
      }, 'accent');
      panel.replaceChildren(
        h('p', { className: 'hint', textContent: 'הרעיון יוצא מהמחברת ונהיה טיוטה פרטית, עם הטקסט, המחשבות, התמונות וההקלטות שלו.' }),
        h('div', { className: 'grow-fields' }, field('אגף', wingSel), field('איפה בתוכו', spaceSel), field('מה זה יהיה', kindSel)),
        h('div', { className: 'actions' }, go, act('ביטול', close)),
      );
    };

    const edit = () => {
      unfold(true);
      const area = h('textarea', { value: idea.body, dir: 'auto', ariaLabel: 'הרעיון' });
      const tagInput = h('input', { type: 'text', value: idea.tags.join(', '), dir: 'auto', placeholder: 'תגיות, מופרדות בפסיק', ariaLabel: 'תגיות' });
      const fileInput = h('input', { type: 'file', accept: 'image/*,audio/*,video/*,application/pdf,.cpr,.bak,.zip', hidden: true });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        msg.textContent = `מעלה את ${file.name}...`;
        msg.className = 'msg';
        try {
          const f = await upload(idea.id, await shrink(file));
          replaceIdea({ ...idea, files: [...idea.files, f] });
        } catch (err) {
          fail(err);
        }
      });
      const removeFile = (f) => async () => {
        if (!confirm(`להסיר את ${f.name}?`)) return;
        try {
          await call(`/api/studio/files/${f.id}`, { method: 'DELETE' });
          replaceIdea({ ...idea, files: idea.files.filter((x) => x.id !== f.id) });
        } catch (err) {
          fail(err);
        }
      };
      const rows = [
        ...idea.files.map((f) => h('li', {}, h('span', { dir: 'auto', textContent: f.name }), act('הסרה', removeFile(f), 'danger'))),
        ...(idea.meta.notes ?? []).map((n) => h('li', {}, h('span', { dir: 'auto', textContent: n.text }), act('הסרה', () => confirm('להסיר את המחשבה הזאת?') && tend({ dropNote: n.at }), 'danger'))),
      ];
      const save = act('שמירה', () => send(`/api/studio/entries/${idea.id}`, 'PATCH', { body: area.value, tags: tagInput.value }).then(replaceIdea, fail), 'primary');
      const del = act('מחיקה', () => confirm('להעביר את הרעיון לסל המחזור? אפשר להחזיר אותו משם עד 30 יום.') && call(`/api/studio/entries/${idea.id}`, { method: 'DELETE' }).then(() => { dropIdea(idea.id); refreshTrashCount(); }, fail), 'danger');
      node.replaceChildren(
        area,
        tagInput,
        rows.length ? h('ul', { className: 'edit-list' }, ...rows) : null,
        h('div', { className: 'actions' }, save, act('לצרף קובץ', () => fileInput.click()), act('ביטול', drawIdeas), del),
        fileInput,
        msg,
      );
      area.focus();
    };

    // The writing partner on this idea: new directions, writing the next part,
    // questions; or his own request. The answer stays on the idea.
    const MUSE = { ...(museView.modes ?? { directions: 'כיוונים חדשים', write: 'תכתוב איתי', questions: 'שאלות שיקדמו' }), ...(museView.wingModes?.[wing] ?? {}) };
    const muse = () => {
      const out = h('div', { className: 'muse-out', dir: 'auto' });
      const askInput = h('input', { type: 'text', dir: 'auto', placeholder: 'או לבקש משהו משלך (למשל: תהפוך את זה לפזמון)', ariaLabel: 'בקשה לעוזר' });
      const modelSel = modelPick(museView.model);
      const buttons = [];
      const run = async (mode) => {
        buttons.forEach((b) => (b.disabled = true));
        msg.textContent = 'חושב...';
        msg.className = 'msg';
        out.textContent = '';
        try {
          const { cut } = await stream(`/api/studio/ideas/${idea.id}/muse`, { mode, ask: askInput.value, model: modelSel.value }, (t) => {
            out.textContent = t;
            if (t) msg.textContent = '';
          });
          msg.textContent = cut ? 'התשובה נקטעה באמצע. מה שהגיע נשמר.' : '';
          const fresh = (await call('/api/studio/ideas')).ideas.find((x) => x.id === idea.id);
          if (fresh) replaceIdea(fresh);
        } catch (err) {
          fail(err);
          buttons.forEach((b) => (b.disabled = false));
        }
      };
      for (const [mode, label] of Object.entries(MUSE)) buttons.push(act(label, () => run(mode), mode === 'directions' ? 'accent' : ''));
      const go = act('לשלוח', () => (askInput.value.trim() ? run('ask') : askInput.focus()), 'primary');
      buttons.push(go);
      askInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go.click();
      });
      panel.replaceChildren(
        h('div', { className: 'muse-modes' }, ...buttons.filter((b) => b !== go)),
        h('div', { className: 'muse-ask' }, askInput, go),
        h('label', { className: 'muse-model' }, 'מודל', modelSel),
        out,
        h('div', { className: 'actions' }, act('סגירה', close)),
      );
    };
    const saved = (idea.meta.muse ?? []).slice().reverse();
    const savedBox = saved.length
      ? h(
          'div',
          { className: 'muse-saved' },
          ...saved.map((m, i) => {
            const d = h(
              'details',
              {},
              h('summary', { textContent: `${MUSE[m.mode] ?? m.ask ?? 'בקשה'} · ${when(m.at)}` }),
              m.ask && m.mode !== 'ask' ? h('p', { className: 'hint', dir: 'auto', textContent: m.ask }) : null,
              h('div', { className: 'say', dir: 'auto', textContent: m.text }),
              h(
                'div',
                { className: 'actions' },
                act('להוסיף כמחשבה', () => tend({ note: m.text })),
                act('לרעיון חדש', async () => {
                  const form = new FormData();
                  form.set('text', m.text);
                  form.set('wing', wing ?? '');
                  form.set('spark', (idea.title || idea.body).split('\n')[0].slice(0, 200));
                  try {
                    const fresh = await call('/api/studio/ideas', { method: 'POST', body: form });
                    ideasView.list.splice(Math.max(0, ideasView.list.findIndex((x) => !x.pinned)), 0, fresh);
                    drawIdeas();
                  } catch (err) {
                    fail(err);
                  }
                }),
                act('הסרה', () => confirm('להסיר את התשובה הזאת?') && send(`/api/studio/ideas/${idea.id}/muse`, 'DELETE', { at: m.at }).then(replaceIdea, fail), 'danger'),
              ),
            );
            if (m.mode === 'ask') d.querySelector('summary').textContent = `${m.ask.slice(0, 60)} · ${when(m.at)}`;
            d.open = i === 0 && Date.now() - Date.parse(m.at) < 10 * 60_000;
            return d;
          }),
        )
      : null;
    const was = idea.meta.was
      ? h('p', { className: 'from-spark', dir: 'auto', textContent: `היה ${KIND[idea.meta.was.kind] ?? ''}${state.byId.get(idea.meta.was.spaceId) ? ` ב${state.byId.get(idea.meta.was.spaceId).title}` : ''} · חזר למחברת ${when(idea.meta.was.at)}` })
      : null;
    const weekly = idea.meta.weekly
      ? h('p', { className: 'weekly', dir: 'auto', textContent: `טיוטה שבועית ל${idea.meta.weekly.hebrew}. מחכה שתשלים אותה לפני שבת, ואז "לפתח לטיוטה" שולח אותה לדברי תורה.` })
      : null;

    const notes = idea.meta.notes ?? [];
    const holds = [
      idea.files.length ? (idea.files.length === 1 ? 'קובץ' : `${idea.files.length} קבצים`) : '',
      notes.length ? (notes.length === 1 ? 'מחשבה' : `${notes.length} מחשבות`) : '',
      saved.length ? (saved.length === 1 ? 'תשובה מהעוזר' : `${saved.length} תשובות מהעוזר`) : '',
    ].filter(Boolean);
    node.append(
      ...[
        h('div', { className: 'idea-top' }, wingPick, wing && !ideasView.scope ? h('a', { className: 'to-notebook', href: `#ideas/${wing}`, textContent: 'למחברת ←' }) : null, h('time', { dateTime: idea.createdAt, textContent: when(idea.createdAt) }), pin, h('button', { className: 'quiet edit', type: 'button', textContent: 'עריכה', onclick: edit })),
        idea.title ? h('h3', { dir: 'auto', textContent: idea.title }) : null,
        weekly,
        idea.body.trim() ? h('div', { className: 'text', dir: 'auto', textContent: idea.body }) : null,
        idea.files.length ? h('div', { className: 'files' }, ...idea.files.map(fileView)) : null,
        idea.meta.spark ? h('p', { className: 'from-spark', dir: 'auto', textContent: `מתוך ניצוץ: ${idea.meta.spark}` }) : null,
        was,
        notes.length ? h('ul', { className: 'notes' }, ...notes.map((n) => h('li', { dir: 'auto' }, n.text, h('time', { dateTime: n.at, textContent: when(n.at) })))) : null,
        idea.tags.length ? h('ul', { className: 'chips' }, ...idea.tags.map((t) => h('li', { textContent: `#${t}` }))) : null,
        savedBox,
        h('div', { className: 'actions' }, act('עוד מחשבה', addNote), act('עוזר כתיבה', muse), act('לפתח לטיוטה', grow)),
        panel,
        msg,
        h('div', { className: 'idea-foot' }, holds.length ? h('span', { className: 'holds', textContent: holds.join(' · ') }) : null, toggle),
      ].filter(Boolean),
    );
    unfold(ideasView.open.has(idea.id));
    return node;
  }

  // ---------- new directions (the writing partner reads the notebook) ----------
  const museView = { pulse: null, newSince: 0, ready: false, model: '', models: [] };
  const modelPick = (value) => {
    const sel = h('select', { ariaLabel: 'מודל' }, ...museView.models.map((m) => h('option', { value: m.id, textContent: `${m.label} · ${m.note}` })));
    sel.value = value;
    return sel;
  };
  async function loadMuse() {
    try {
      Object.assign(museView, await call('/api/studio/ideas/pulse'));
    } catch {
      return;
    }
    drawMuse();
  }
  function drawMuse() {
    const { pulse, newSince, ready } = museView;
    $('muse-board').hidden = Boolean(ideasView.scope);
    $('muse-board').classList.toggle('fresh', Boolean(pulse && !pulse.seen));
    $('muse-when').textContent = pulse ? `${when(pulse.at)}, מתוך ${pulse.count} רעיונות` : '';
    $('muse-text').textContent = ready
      ? pulse?.text ?? 'כאן יופיע מה חדש אצלך: כיוונים יצירתיים שאתה פותח, חוטים שחוזרים. הבדיקה רצה לבד פעם ביום כשנכנסים רעיונות חדשים.'
      : 'עוזר הכתיבה עוד לא מחובר: צריך להוסיף ב-Cloudflare סוד בשם ANTHROPIC_API_KEY.';
    $('muse-run').textContent = newSince ? `לקרוא את ${newSince === 1 ? 'הרעיון החדש' : `${newSince} הרעיונות החדשים`}` : 'לקרוא שוב את החודש האחרון';
    $('muse-run').disabled = !ready;
    $('muse-weekly').disabled = !ready;
    $('muse-seen').hidden = !(pulse && !pulse.seen);
    const sel = modelPick(museView.model);
    sel.id = 'muse-model';
    sel.addEventListener('change', async () => {
      try {
        museView.model = (await send('/api/studio/muse/model', 'PUT', { model: sel.value })).model;
        say('muse-msg', 'מעכשיו העוזר עובד עם המודל הזה.', 'ok');
      } catch (err) {
        report('muse-msg')(err);
      }
    });
    $('muse-model-slot').replaceChildren(...(museView.models.length ? [sel] : []));
    // Once read, the pulse folds to its first lines.
    $('muse-board').classList.toggle('folded', Boolean(pulse?.seen) && !museView.unfold);
    $('muse-more').hidden = !$('muse-board').classList.contains('folded');
  }
  $('muse-run').addEventListener('click', async () => {
    $('muse-run').disabled = true;
    say('muse-msg', 'קורא את המחברת...');
    try {
      await stream('/api/studio/ideas/pulse', {}, (t) => {
        $('muse-text').textContent = t;
        if (t) say('muse-msg', '');
      });
      say('muse-msg', '');
      await loadMuse();
    } catch (err) {
      report('muse-msg')(err);
      $('muse-run').disabled = false;
    }
  });
  $('muse-more').addEventListener('click', () => {
    museView.unfold = true;
    drawMuse();
  });
  $('muse-seen').addEventListener('click', async () => {
    await send('/api/studio/ideas/pulse/seen', 'POST').catch(() => {});
    if (museView.pulse) museView.pulse.seen = true;
    drawMuse();
  });
  $('muse-weekly').addEventListener('click', async () => {
    $('muse-weekly').disabled = true;
    say('muse-msg', 'כותב טיוטה על הפרשה...');
    try {
      const idea = await send('/api/studio/ideas/weekly', 'POST');
      ideasView.list.unshift({ files: [], ...idea });
      say('muse-msg', 'הטיוטה מחכה למעלה, נעוצה.', 'ok');
      drawIdeas();
    } catch (err) {
      report('muse-msg')(err);
    }
    $('muse-weekly').disabled = !museView.ready;
  });

  // ---------- an old idea comes back ----------
  function oldPool() {
    const age = (i) => Date.now() - Date.parse(i.createdAt);
    const waiting = scoped().filter((i) => age(i) > 14 * DAY && !i.pinned);
    return waiting.length ? waiting : scoped().filter((i) => age(i) > 2 * DAY);
  }
  function nextOld() {
    const pool = oldPool();
    ideasView.oldId = pickOne(pool, pool.find((i) => i.id === ideasView.oldId))?.id ?? null;
  }
  function drawOld() {
    const idea = ideasView.list.find((i) => i.id === ideasView.oldId);
    $('resurface').hidden = !idea;
    if (!idea) return;
    $('resurface-age').textContent = `מ${ago(idea.createdAt)}`;
    $('resurface-card').replaceChildren(ideaCard(idea));
    $('resurface-next').hidden = oldPool().length < 2;
  }
  $('resurface-next').addEventListener('click', () => {
    nextOld();
    drawOld();
  });

  // ---------- sparks ----------
  async function loadSparks() {
    ideasView.sparks = (await call('/api/studio/sparks')).sparks;
  }
  function nextSpark() {
    const w = $('spark-wing').value;
    const pool = (ideasView.sparks ?? []).filter((s) => !w || s.wing === w || s.wing === 'any');
    ideasView.spark = pickOne(pool, ideasView.spark);
    const s = ideasView.spark;
    $('spark-text').textContent = s ? s.text : 'לאגף הזה עוד אין ניצוצות. אפשר לכתוב כמה למטה, ב"הניצוצות שלי".';
    if (s && s.wing !== 'any') $('spark').dataset.wing = s.wing;
    else delete $('spark').dataset.wing;
    $('spark-write').disabled = !s;
  }
  $('spark-wing').addEventListener('change', nextSpark);
  $('spark-next').addEventListener('click', nextSpark);
  $('spark-write').addEventListener('click', () => {
    const s = ideasView.spark;
    if (!s) return;
    ideasView.answering = s.text;
    $('capture-spark-text').textContent = s.text;
    $('capture-spark').hidden = false;
    if (s.wing !== 'any') $('capture-wing').value = s.wing;
    $('capture').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('capture-text').focus({ preventScroll: true });
  });
  function clearAnswering() {
    ideasView.answering = '';
    $('capture-spark').hidden = true;
  }
  $('capture-spark-clear').addEventListener('click', clearAnswering);

  function drawSparkEditor() {
    $('spark-groups').replaceChildren(
      ...['any', ...WING_IDS].map((w) => {
        const lines = (ideasView.sparks ?? []).filter((s) => s.wing === w).map((s) => s.text);
        const ta = h('textarea', { value: lines.join('\n'), dir: 'auto', rows: Math.min(8, Math.max(3, lines.length + 1)) });
        ta.dataset.wing = w;
        return h('label', { className: 'field' }, w === 'any' ? 'לכל דבר' : WING_NAME[w], ta);
      }),
    );
  }
  $('spark-editor').addEventListener('toggle', () => {
    if ($('spark-editor').open) drawSparkEditor();
  });
  async function saveSparks(list) {
    try {
      const { sparks, own } = await send('/api/studio/sparks', 'PUT', { sparks: list });
      ideasView.sparks = sparks;
      drawSparkEditor();
      nextSpark();
      say('sparks-msg', own ? 'נשמר.' : 'חזרה הרשימה המקורית.', 'ok');
    } catch (err) {
      report('sparks-msg')(err);
    }
  }
  $('sparks-save').addEventListener('click', () =>
    saveSparks(
      [...$('spark-groups').querySelectorAll('textarea')].flatMap((ta) =>
        ta.value.split('\n').map((t) => t.trim()).filter(Boolean).map((text) => ({ wing: ta.dataset.wing, text })),
      ),
    ),
  );
  $('sparks-reset').addEventListener('click', () => confirm('לחזור לניצוצות המקוריים? מה שכתבת כאן יימחק.') && saveSparks([]));

  // ---------- capture ----------
  // A file that failed to save (no signal, say) waits in ideasView.pending
  // and goes with the next "שמירה".
  async function capture(file = ideasView.pending) {
    const text = $('capture-text').value;
    if (!text.trim() && !file) return void $('capture-text').focus();
    const form = new FormData();
    form.set('text', text);
    form.set('wing', $('capture-wing').value);
    form.set('tags', $('capture-tags').value);
    if (ideasView.answering) form.set('spark', ideasView.answering);
    if (file) form.set('file', file, file.name);
    $('capture-save').disabled = true;
    say('capture-msg', file ? 'שומר...' : '');
    try {
      const idea = await call('/api/studio/ideas', { method: 'POST', body: form });
      ideasView.pending = null;
      $('capture-text').value = '';
      $('capture-tags').value = '';
      $('capture-wing').value = ideasView.scope;
      clearAnswering();
      const at = ideasView.list.findIndex((x) => !x.pinned);
      ideasView.list.splice(at < 0 ? ideasView.list.length : at, 0, idea);
      drawIdeas();
      say('capture-msg', pickOne(SAVED), 'ok');
    } catch (err) {
      if (file) ideasView.pending = file;
      if (!(err instanceof AuthError)) say('capture-msg', file ? `לא נשמר (${err.message}). הקובץ מחכה כאן, "שמירה" תנסה שוב.` : err.message, 'err');
    } finally {
      $('capture-save').disabled = false;
    }
  }
  $('capture').addEventListener('submit', (e) => {
    e.preventDefault();
    capture();
  });
  $('capture').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      capture();
    }
  });

  // A phone photo can be 5 MB or HEIC; send a JPEG of at most 2000px instead.
  async function shrink(file) {
    const fine = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
    if (!file.type.startsWith('image/') || file.type === 'image/gif' || (fine && file.size < 1_500_000)) return file;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' }) : file;
    } catch {
      return file;
    }
  }
  $('photo-btn').addEventListener('click', () => $('photo').click());
  $('photo').addEventListener('change', async () => {
    const file = $('photo').files[0];
    $('photo').value = '';
    if (!file) return;
    say('capture-msg', 'מכין את התמונה...');
    capture(await shrink(file));
  });

  // Voice memo: tap to record, tap again and it is saved (with any text typed).
  const rec = { mr: null, timer: 0, t0: 0 };
  const REC_MAX_MS = 30 * 60 * 1000; // about 15 MB at 64 kbps, well under the upload cap
  const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function recUi(on) {
    pressed($('rec'), on).classList.toggle('recording', on);
    $('rec-label').textContent = on ? `עצירה ושמירה ${clock(Date.now() - rec.t0)}` : 'הקלטה';
  }
  async function toggleRec() {
    if (rec.mr) return rec.mr.stop();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return say('capture-msg', 'הדפדפן הזה לא מקליט. אפשר להקליט בטלפון ולצרף את הקובץ דרך "עריכה".', 'err');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return say('capture-msg', 'אין גישה למיקרופון. צריך לאשר אותה בדפדפן.', 'err');
    }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : {});
    const chunks = [];
    mr.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    mr.addEventListener('stop', () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(rec.timer);
      rec.mr = null;
      recUi(false);
      const mime = mr.mimeType || type || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) return say('capture-msg', 'לא נקלט כלום. עוד פעם?', 'err');
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      const d = new Date();
      const name = `הקלטה ${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}.${ext}`;
      capture(new File([blob], name, { type: mime }));
    });
    mr.start(1000);
    rec.mr = mr;
    rec.t0 = Date.now();
    rec.timer = setInterval(() => {
      if (Date.now() - rec.t0 > REC_MAX_MS) mr.stop();
      else recUi(true);
    }, 500);
    recUi(true);
    say('capture-msg', '');
  }
  $('rec').addEventListener('click', toggleRec);

  // ---------- a wing's studio ----------
  const wingView = { id: null, filter: null };

  function itemRow(e) {
    const path = e.status === 'published' ? itemPath(e) : null;
    const where = state.byId.get(e.spaceId);
    const href = e.kind === 'project' || e.kind === 'work' ? `#project/${e.id}` : `#item/${e.id}`;
    const [play, panel] = rowPlayer(e);
    return h(
      'li',
      {},
      h('input', { type: 'checkbox', className: 'pick', value: e.id, ariaLabel: `בחירת ${e.title || 'פריט'}` }),
      h('a', { className: 'title', href, dir: 'auto', textContent: e.title || e.meta?.synced?.name || 'בלי כותרת' }),
      h('span', { className: 'row-actions' }, play, path ? h('a', { className: 'btn small ghost', href: path, textContent: 'באתר' }) : null),
      h(
        'div',
        { className: 'meta' },
        h('span', { textContent: KIND[e.kind] ?? e.kind }),
        where?.parentId ? h('span', { dir: 'auto', textContent: where.title }) : null,
        e.meta?.order != null ? h('span', { textContent: `#${e.meta.order}` }) : null,
        h('span', { className: `badge ${e.status === 'draft' ? 'draft' : 'vis-public'}`, textContent: e.status === 'draft' ? 'טיוטה' : 'פורסם' }),
        h('span', { className: `badge vis-${e.visibility}`, textContent: VIS[e.visibility] }),
        h('time', { textContent: `עודכן ${fmt(e.updatedAt)}` }),
      ),
      panel,
    );
  }

  // An item's recordings and videos, played right in the list.
  function rowPlayer(e) {
    const vs = (e.meta?.versions ?? []).filter((v) => v && typeof v.url === 'string' && v.url);
    if (!vs.length) return [null, null];
    const panel = h('div', { className: 'row-player', hidden: true });
    const show = async (i) => {
      const chips = vs.length > 1
        ? h('div', { className: 'filters' }, ...vs.map((v, j) => h('button', { type: 'button', textContent: v.label || `גרסה ${j + 1}`, ariaPressed: String(i === j), onclick: () => show(j) })))
        : null;
      panel.replaceChildren(...[chips, await player(vs[i].url, vs[i].kind)].filter(Boolean));
    };
    const btn = h('button', { className: 'btn small play', type: 'button', ariaExpanded: 'false', title: vs.map((v) => v.label).filter(Boolean).join(' · ') });
    const label = (open) => btn.replaceChildren(h('span', { className: 'play-icon', ariaHidden: 'true' }), open ? 'סגירה' : vs.length > 1 ? `נגינה · ${vs.length}` : 'נגינה');
    label(false);
    btn.addEventListener('click', async () => {
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.classList.toggle('on', open);
      label(open);
      if (open && !panel.childElementCount) await show(0);
      if (!open) for (const m of panel.querySelectorAll('audio, video')) m.pause();
    });
    return [btn, panel];
  }

  // `chat`: the community chat's address, for a private message to an active member.
  function request(m, communityId, done, msg = 'g-status', chat = null) {
    const decide = (status) => send(`/api/studio/communities/${communityId}/members`, 'PATCH', { userId: m.userId, status }).then(done, report(msg));
    return h(
      'li',
      {},
      personLink(m.userId, m.displayName),
      h('span', { className: 'meta', dir: 'auto' }, h('span', { textContent: `@${m.username}` }), m.status === 'pending' ? h('span', { className: 'badge vis-community', textContent: 'מבקש להצטרף' }) : null, m.accountPending ? h('span', { className: 'badge', textContent: 'חשבון חדש' }) : null, h('time', { textContent: fmt(m.createdAt) })),
      h(
        'span',
        { className: 'actions' },
        ...(m.status === 'pending'
          ? [
              h('button', { className: 'btn small primary', type: 'button', textContent: 'אישור', onclick: () => decide('active') }),
              h('button', { className: 'btn small danger', type: 'button', textContent: 'דחייה', onclick: () => decide('refused') }),
            ]
          : [
              chat && m.status === 'active'
                ? h('a', { className: 'btn small', href: `${chat}?to=${encodeURIComponent(m.userId)}`, textContent: 'הודעה פרטית' })
                : null,
              h('button', { className: 'btn small danger', type: 'button', textContent: m.status === 'active' ? 'הסרה' : 'מחיקה', onclick: () => confirm(`להוציא את ${m.displayName}?`) && decide('removed') }),
            ]),
      ),
      m.note ? h('span', { className: 'note', dir: 'auto', textContent: m.note }) : null,
    );
  }

  async function openWing(id) {
    wingView.id = id;
    wingView.filter = null;
    const wing = state.byId.get(id);
    document.querySelector('#view-wing').dataset.wing = id;
    $('w-title').textContent = `סטודיו ${wing?.title ?? ''}`;
    $('w-kind').replaceChildren(...WING_KINDS[id].map((k) => h('option', { value: k, textContent: KIND[k] })));
    $('w-kind').hidden = WING_KINDS[id].length < 2;
    $('w-settings').href = `#space/${id}`;
    $('w-notebook').href = `#ideas/${id}`;
    call('/api/studio/ideas')
      .then(({ ideas }) => {
        const n = ideas.filter((i) => i.meta.wing === id).length;
        $('w-notebook-count').textContent = n ? String(n) : '';
      })
      .catch(() => {});
    $('w-view').href = `/${id}`;
    siteHere(`/${id}`);
    $('w-new-space').hidden = id === 'software' || id === 'articles' || id === 'torah';
    $('w-drop').hidden = id === 'software';
    $('w-drop').querySelector('.drop-list').replaceChildren();
    await loadSpaces().catch(report('w-msg'));
    showDriveLink($('w-drive'), driveFolder(id));
    const kids = state.spaces.filter((x) => x.parentId && inside(id).includes(x.id) && x.id !== id);
    $('w-spaces').replaceChildren(
      ...kids.map((x) =>
        h(
          'a',
          { className: 'space-card', href: `#space/${x.id}` },
          h('span', { className: 't', dir: 'auto', textContent: x.title }),
          h('span', { className: 'meta' }, h('span', { textContent: SPACE_KIND[x.kind] ?? '' }), h('span', { textContent: x.entries === 1 ? 'פריט אחד' : `${x.entries} פריטים` }), ...x.communities.map((cid) => (state.commById.get(cid) ? h('span', { dir: 'auto', textContent: state.commById.get(cid).title }) : null)), h('span', { className: `badge vis-${x.visibility}`, textContent: VIS[x.visibility] })),
        ),
      ),
    );
    $('w-spaces-empty').hidden = kids.length > 0;
    $('w-spaces-box').hidden = !kids.length && $('w-new-space').hidden;
    $('w-filters').replaceChildren(
      ...[{ id: null, title: 'הכל' }, ...kids].map((x) =>
        h('button', {
          type: 'button',
          textContent: x.title,
          ariaPressed: String(wingView.filter === x.id),
          onclick: (ev) => {
            wingView.filter = x.id;
            for (const b of $('w-filters').children) b.setAttribute('aria-pressed', String(b === ev.currentTarget));
            loadWingItems();
          },
        }),
      ),
    );
    $('w-filters').hidden = !kids.length;
    loadWingItems();
  }

  async function loadWingItems() {
    const id = wingView.id;
    const q = $('w-search').value.trim();
    const ids = wingView.filter ? inside(wingView.filter) : inside(id);
    try {
      const lists = await Promise.all(ids.map((x) => call(`/api/studio/entries?space=${encodeURIComponent(x)}${q ? `&q=${encodeURIComponent(q)}` : ''}`)));
      const all = lists.flatMap((l) => l.entries).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      $('w-items').replaceChildren(...all.map(itemRow));
      $('w-items-empty').hidden = all.length > 0;
    } catch (err) {
      report('w-msg')(err);
    }
  }
  $('w-search').addEventListener('input', debounce(loadWingItems, 250));

  $('w-new').addEventListener('click', () => {
    const kind = $('w-kind').value;
    location.hash = kind === 'project' ? '#project-new' : `#new/${wingView.id}/${kind}`;
  });
  $('w-new-space').addEventListener('click', async () => {
    const kinds = wingView.id === 'books' ? 'book' : wingView.id === 'sketches' ? 'series' : 'collection';
    const title = prompt(wingView.id === 'books' ? 'שם הספר:' : 'שם:');
    if (!title?.trim()) return;
    try {
      const x = await send('/api/studio/spaces', 'POST', { parentId: wingView.id, kind: kinds, title });
      await loadSpaces();
      location.hash = `#space/${x.id}`;
    } catch (err) {
      report('w-msg')(err);
    }
  });

  // ---------- one space (or a wing's own settings) ----------
  const spaceView = { id: null };

  async function openSpace(id) {
    spaceView.id = id;
    await loadSpaces().catch(() => {});
    const x = state.byId.get(id);
    if (!x) return void say('s-status', 'לא נמצא', 'err');
    const isWing = !x.parentId;
    document.querySelector('#view-space').dataset.wing = x.wing;
    $('s-back').href = `#wing/${x.wing}`;
    $('s-title').value = x.title;
    $('s-summary').value = x.summary;
    $('s-kind').value = x.kind;
    $('s-kind').closest('label').hidden = isWing;
    $('s-visibility').value = x.visibility;
    pickComms($('s-communities'), x.communities);
    $('s-slug').value = x.slug;
    $('s-slug').closest('label').hidden = isWing;
    $('s-state').value = x.meta?.status ?? '';
    $('s-cover').value = x.meta?.cover ?? '';
    $('s-sort').value = x.sort ?? 0;
    $('s-drive').value = x.meta?.drive?.folder ?? '';
    showDriveLink($('s-drive-open'), driveFolder(id));
    $('s-delete').hidden = isWing;
    $('s-view').href = pathOf(x);
    siteHere(pathOf(x));
    $('s-status').textContent = isWing ? 'הגדרות האגף' : `${SPACE_KIND[x.kind] ?? ''} ב${wingOf(id)?.title ?? ''}`;
    const kinds = WING_KINDS[x.wing] ?? [];
    $('s-new-item').hidden = !kinds.length || kinds[0] === 'project';
    $('s-drop').hidden = $('s-new-item').hidden;
    $('s-drop').querySelector('.drop-list').replaceChildren();
    try {
      const { entries } = await call(`/api/studio/entries?space=${encodeURIComponent(id)}`);
      entries.sort((a, b) => (a.meta?.order ?? 1e9) - (b.meta?.order ?? 1e9) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      $('s-items').replaceChildren(...entries.map(itemRow));
      $('s-items-empty').hidden = entries.length > 0;
    } catch (err) {
      report('s-status')(err);
    }
  }

  $('s-save').addEventListener('click', async () => {
    const x = state.byId.get(spaceView.id);
    if (!x) return;
    const body = {
      title: $('s-title').value,
      summary: $('s-summary').value,
      visibility: $('s-visibility').value,
      communities: pickedComms($('s-communities')),
      sort: $('s-sort').value,
      meta: { ...x.meta, status: $('s-state').value.trim() || undefined, cover: $('s-cover').value.trim() || undefined, drive: driveMeta(x.meta?.drive, $('s-drive').value) },
    };
    if (x.parentId) Object.assign(body, { kind: $('s-kind').value, slug: $('s-slug').value });
    try {
      await send(`/api/studio/spaces/${x.id}`, 'PATCH', body);
      say('s-status', 'נשמר', 'ok');
      openSpace(x.id);
    } catch (err) {
      report('s-status')(err);
    }
  });
  $('s-delete').addEventListener('click', async () => {
    const x = state.byId.get(spaceView.id);
    if (!x || !confirm(`למחוק את "${x.title}"? אפשר רק כשאין בו כלום.`)) return;
    try {
      await call(`/api/studio/spaces/${x.id}`, { method: 'DELETE' });
      await loadSpaces();
      location.hash = `#wing/${x.wing}`;
    } catch (err) {
      report('s-status')(err);
    }
  });
  $('s-new-item').addEventListener('click', () => {
    const x = state.byId.get(spaceView.id);
    location.hash = `#new/${x.id}/${(WING_KINDS[x.wing] ?? ['article'])[0]}`;
  });

  // ---------- editor (any item: a song, a chapter, an article...) ----------
  const editor = { entry: null, dirty: false, saving: null, defaults: {} };
  const fields = ['title', 'summary', 'slug', 'tags', 'visibility', 'body', 'kind', 'space', 'order', 'capo', 'key', 'comments'];

  function status(text, kind = '') {
    $('save-status').textContent = text;
    $('save-status').style.color = kind === 'err' ? '#ff9b85' : '';
  }

  // Versions: recordings, videos, arrangements. One row each.
  function versionRow(v = {}) {
    const tag = (n, f) => {
      n.dataset.f = f;
      return n;
    };
    const input = (f, props) => tag(h('input', { type: 'text', value: v[f] ?? '', ...props }), f);
    const kind = h('select', {}, h('option', { value: '', textContent: 'זיהוי אוטומטי' }), h('option', { value: 'audio', textContent: 'שמע' }), h('option', { value: 'video', textContent: 'וידאו' }));
    tag(kind, 'kind').value = v.kind ?? '';
    const vis = h('select', {}, h('option', { value: '', textContent: 'כמו הפריט' }), h('option', { value: 'community', textContent: 'רק לקהילה' }));
    tag(vis, 'visibility').value = v.visibility ?? '';
    const row = h(
      'div',
      { className: 'version-row' },
      input('label', { placeholder: 'שם, למשל "הקלטה רשמית"', dir: 'auto', title: 'שם הגרסה' }),
      input('url', { placeholder: 'קישור מהדרייב, מיוטיוב, או העלאה', dir: 'ltr', title: 'קישור' }),
      kind,
      vis,
      h('button', { className: 'btn small', type: 'button', textContent: 'העלאה', onclick: () => { versionTarget = row; $('ed-version-file').click(); } }),
      h('button', { className: 'btn small danger', type: 'button', textContent: 'הסרה', onclick: () => { row.remove(); changed(); } }),
    );
    row.addEventListener('input', changed);
    row.addEventListener('change', changed);
    enhanceVersion(row);
    return row;
  }
  let versionTarget = null;
  const readVersions = () =>
    [...$('ed-versions').children]
      .map((r) => Object.fromEntries([...r.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n.value.trim()])))
      .filter((v) => v.url)
      .map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x)));
  $('ed-add-version').addEventListener('click', () => $('ed-versions').append(versionRow()));

  // Credits: a role and a member, one row each. Members come from the community list.
  let people = null;
  async function loadPeople() {
    if (people) return;
    try {
      people = (await call('/api/studio/community')).users.filter((u) => u.status === 'active');
    } catch {
      people = null;
    }
  }
  function creditRow(c = {}) {
    const who = h('select', { ariaLabel: 'מי' }, h('option', { value: '', textContent: 'מי מהקהילה?' }), ...(people ?? []).map((u) => h('option', { value: u.id, textContent: `${u.displayName} (${u.username})` })));
    who.dataset.f = 'userId';
    who.value = c.userId ?? '';
    const role = h('input', { type: 'text', value: c.role ?? '', placeholder: 'תפקיד, למשל שירה', dir: 'auto', ariaLabel: 'תפקיד', maxLength: 40 });
    role.dataset.f = 'role';
    const row = h('div', { className: 'social-row' }, role, who, h('button', { className: 'btn small danger', type: 'button', textContent: 'הסרה', onclick: () => { row.remove(); changed(); } }));
    row.addEventListener('input', changed);
    row.addEventListener('change', changed);
    return row;
  }
  const readCredits = () => {
    const list = [...$('ed-credits').children]
      .map((r) => Object.fromEntries([...r.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n.value.trim()])))
      .filter((c) => c.userId);
    return list.length ? list : undefined;
  };
  $('ed-add-credit').addEventListener('click', () => {
    const row = creditRow();
    $('ed-credits').append(row);
    row.querySelector('input').focus();
  });

  function spaceOptions(spaceId) {
    const wing = wingOf(spaceId);
    const ids = wing ? inside(wing.id) : [];
    $('ed-space').replaceChildren(...ids.map((id) => state.byId.get(id)).filter(Boolean).map((x) => h('option', { value: x.id, textContent: spaceLabel(x) })));
    $('ed-space').value = spaceId ?? '';
    const kinds = [...new Set([...(WING_KINDS[wing?.id] ?? []), editor.entry?.kind ?? editor.defaults.kind].filter(Boolean))];
    $('ed-kind').replaceChildren(...kinds.map((k) => h('option', { value: k, textContent: KIND[k] ?? k })));
    $('ed-back').href = spaceId ? (state.byId.get(spaceId)?.parentId ? `#space/${spaceId}` : `#wing/${spaceId}`) : '#ideas';
    $('ed-back').textContent = spaceId ? `חזרה ל${state.byId.get(spaceId)?.title ?? 'אגף'}` : 'חזרה';
  }

  function modeFor(kind) {
    const song = kind === 'song';
    $('ed-song').hidden = !song;
    $('ed-body').classList.toggle('chords-mode', song);
    $('md-tools').hidden = song;
    $('ed-body').dir = song ? 'rtl' : 'auto';
    $('ed-body').placeholder = song
      ? 'מילים ואקורדים. אפשר [Am]כך בתוך השורה, או שורת אקורדים מעל שורת מילים. {c: פזמון} לכותרת קטנה.'
      : 'כותבים כאן. Markdown עובד: ## כותרת, **מודגש**, - רשימה, [קישור](https://...)';
  }

  function fill(entry) {
    const d = editor.defaults;
    $('ed-title').value = entry?.title ?? '';
    $('ed-summary').value = entry?.summary ?? '';
    $('ed-slug').value = entry?.slug ?? '';
    $('ed-tags').value = (entry?.tags ?? []).join(', ');
    $('ed-visibility').value = entry?.visibility ?? 'private';
    pickComms($('ed-communities'), entry ? entry.communities ?? [] : (state.byId.get(d.spaceId)?.communities ?? []), changed);
    $('ed-body').value = entry?.body ?? '';
    spaceOptions(entry ? entry.spaceId : d.spaceId);
    $('ed-kind').value = entry?.kind ?? d.kind ?? $('ed-kind').value;
    $('ed-order').value = entry?.meta?.order ?? '';
    $('ed-capo').value = entry?.meta?.capo ?? '';
    $('ed-key').value = entry?.meta?.key ?? '';
    $('ed-comments').checked = entry?.meta?.comments !== false;
    $('ed-versions').replaceChildren(...(entry?.meta?.versions ?? []).map(versionRow));
    $('ed-projects').replaceChildren(...(entry?.meta?.projects ?? []).map((p) => projectFileRow(p)));
    showDriveLink($('ed-drive'), driveFolder($('ed-space').value));
    $('ed-credits').replaceChildren(...(entry?.meta?.credits ?? []).map(creditRow));
    modeFor($('ed-kind').value);
    reflect(entry);
    refreshPage();
  }

  function reflect(entry) {
    const published = entry?.status === 'published';
    $('publish').textContent = published ? 'החזרה לטיוטה' : 'פרסום';
    $('publish').classList.toggle('primary', !published);
    $('delete-article').hidden = !entry;
    const path = entry && published ? itemPath(entry) : null;
    $('view-link').hidden = !path;
    if (path) $('view-link').href = path;
    const where = entry && state.byId.get(entry.spaceId);
    siteHere(path ?? (where ? pathOf(where) : null));
    if (entry) status(`${published ? 'פורסם' : 'טיוטה'} · ${VIS[entry.visibility]} · נשמר ${fmt(entry.updatedAt)}`);
    else status('טיוטה חדשה');
  }

  async function openEditor(id, defaults = {}, { skipLocal = false } = {}) {
    await loadPeople();
    editor.entry = null;
    editor.dirty = false;
    editor.conflict = false;
    editor.defaults = defaults;
    notice(null);
    $('ed-history').hidden = true;
    fill(null);
    if (id) {
      status('טוען...');
      try {
        editor.entry = await call(`/api/studio/entries/${id}`);
        if (editor.entry.kind === 'project' || editor.entry.kind === 'work') return void (location.hash = `#project/${id}`);
        fill(editor.entry);
        $('ed-history').hidden = false;
      } catch (err) {
        if (!(err instanceof AuthError)) status(err.message, 'err');
        return;
      }
    } else {
      $('ed-title').focus();
    }
    if (!skipLocal) offerLocal();
    renderPreview();
  }

  // ---------- earlier versions ----------
  const REASON = { edit: '', restore: 'לפני שחזור', conflict: 'מחלון אחר' };
  const versionsView = { list: [], picked: null };
  async function openHistory() {
    if (!editor.entry) return;
    $('history-dialog').showModal();
    showVersions();
    say('hs-msg', 'טוען...');
    try {
      ({ revisions: versionsView.list } = await call(`/api/studio/entries/${editor.entry.id}/revisions`));
      say('hs-msg', '');
      drawVersions();
    } catch (err) {
      report('hs-msg')(err);
    }
  }
  function showVersions() {
    versionsView.picked = null;
    $('hs-list').hidden = false;
    $('hs-view').hidden = true;
    $('hs-restore').hidden = true;
    $('hs-back').hidden = true;
  }
  function drawVersions() {
    $('hs-list').replaceChildren(
      ...versionsView.list.map((r) =>
        h(
          'li',
          { tabIndex: 0, onclick: () => pickVersion(r), onkeydown: (e) => e.key === 'Enter' && pickVersion(r) },
          h('span', { className: 'who', textContent: fmt(r.savedAt || r.keptAt) }),
          h('span', { className: 'meta', dir: 'auto' }, h('span', { textContent: r.title || 'בלי כותרת' }), h('span', { textContent: `${r.chars.toLocaleString('he-IL')} תווים` }), REASON[r.reason] ? h('span', { className: 'badge', textContent: REASON[r.reason] }) : null),
        ),
      ),
    );
    $('hs-empty').hidden = versionsView.list.length > 0;
  }
  async function pickVersion(r) {
    say('hs-msg', 'טוען...');
    try {
      const v = await call(`/api/studio/entries/${editor.entry.id}/revisions/${r.id}`);
      versionsView.picked = v;
      say('hs-msg', `נשמר ב־${fmt(v.savedAt || v.keptAt)}`);
      $('hs-title').textContent = v.title || 'בלי כותרת';
      $('hs-body').textContent = v.body || '(בלי טקסט)';
      $('hs-list').hidden = true;
      $('hs-empty').hidden = true;
      $('hs-view').hidden = false;
      $('hs-restore').hidden = false;
      $('hs-back').hidden = false;
    } catch (err) {
      report('hs-msg')(err);
    }
  }
  $('ed-history').addEventListener('click', async () => {
    // What is on screen goes to the server first, so it becomes a version too.
    if (editor.dirty) {
      editor.flush.cancel();
      try {
        await save();
      } catch {
        return;
      }
    }
    openHistory();
  });
  $('hs-back').addEventListener('click', () => {
    showVersions();
    say('hs-msg', '');
    drawVersions();
  });
  $('hs-restore').addEventListener('click', async () => {
    const v = versionsView.picked;
    if (!v || !editor.entry) return;
    try {
      const entry = await send(`/api/studio/entries/${editor.entry.id}/revisions/${v.id}/restore`, 'POST');
      editor.flush.cancel();
      editor.entry = entry;
      editor.dirty = false;
      forgetLocal();
      notice(null);
      fill(entry);
      renderPreview();
      $('history-dialog').close();
      status(`שוחזר לגרסה מ־${fmt(v.savedAt || v.keptAt)}. מה שהיה לפני כן נמצא בגרסאות הקודמות.`);
    } catch (err) {
      report('hs-msg')(err);
    }
  });

  function collect() {
    const num = (v) => (v === '' ? undefined : Number(v));
    const meta = {
      ...(editor.entry?.meta ?? {}),
      order: num($('ed-order').value),
      capo: $('ed-capo').value.trim() || undefined,
      key: $('ed-key').value.trim() || undefined,
      versions: readVersions(),
      projects: readProjects(),
      comments: $('ed-comments').checked ? undefined : false,
      credits: readCredits(),
    };
    delete meta.synced;
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
    return {
      title: $('ed-title').value,
      summary: $('ed-summary').value,
      slug: $('ed-slug').value,
      tags: $('ed-tags').value,
      visibility: $('ed-visibility').value,
      communities: pickedComms($('ed-communities')),
      body: $('ed-body').value,
      kind: $('ed-kind').value,
      spaceId: $('ed-space').value || null,
      meta,
    };
  }

  function changed() {
    editor.dirty = true;
    status('לא נשמר');
    keepLocal();
    editor.flush();
    refreshPage();
  }

  // ---------- a copy in this browser ----------
  // Every change is copied to localStorage until the server has it, so text
  // typed while offline, before a failed save or a closed tab is never lost.
  const localKey = () => `studio.local.${editor.entry?.id ?? `new.${editor.defaults.spaceId ?? ''}`}`;
  const keepLocal = debounce(() => {
    try {
      const { title, summary, body } = collect();
      localStorage.setItem(localKey(), JSON.stringify({ at: new Date().toISOString(), base: editor.entry?.updatedAt ?? null, title, summary, body }));
    } catch {
      // storage full or blocked: the server save still runs
    }
  }, 300);
  function readLocal(key = localKey()) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }
  function forgetLocal(key = localKey()) {
    keepLocal.cancel();
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing kept
    }
  }

  function notice(text, actions = []) {
    $('ed-notice').hidden = !text;
    $('ed-notice-text').textContent = text ?? '';
    $('ed-notice-actions').replaceChildren(...actions.map(([label, fn, cls = '']) => h('button', { className: `btn small ${cls}`, type: 'button', textContent: label, onclick: fn })));
  }

  // Opening an item: offer back what this browser kept and the server never got.
  function offerLocal() {
    const key = localKey();
    const copy = readLocal(key);
    const e = editor.entry;
    if (!copy) return;
    if (e && copy.title === e.title && copy.summary === e.summary && copy.body === e.body) return forgetLocal(key);
    notice(`יש כאן טקסט שלא נשמר, מ־${fmt(copy.at)}${copy.body ? ` (${copy.body.length.toLocaleString('he-IL')} תווים)` : ''}.`, [
      ['להחזיר אותו', () => {
        $('ed-title').value = copy.title ?? '';
        $('ed-summary').value = copy.summary ?? '';
        $('ed-body').value = copy.body ?? '';
        notice(null);
        changed();
        renderPreview();
      }, 'primary'],
      ['לזרוק', () => {
        if (!confirm('לזרוק את הטקסט שלא נשמר?')) return;
        forgetLocal(key);
        notice(null);
      }, 'danger'],
    ]);
  }

  // Another window (or the phone) saved this item since it was opened here.
  function conflicted(err) {
    notice('הפריט נשמר בינתיים בחלון אחר או במכשיר אחר. מה שכתבת כאן שמור בדפדפן עד שתחליט.', [
      ['לשמור את מה שכאן', async () => {
        notice(null);
        editor.flush.cancel();
        try {
          await save({ overwrite: true });
          status('נשמר. מה שנשמר בחלון האחר נמצא בגרסאות הקודמות.');
        } catch {
          // the status line says why
        }
      }, 'primary'],
      ['לטעון את מה שנשמר שם', async () => {
        editor.flush.cancel();
        keepLocal.cancel();
        editor.dirty = false;
        notice(null);
        await openEditor(editor.entry.id, editor.defaults, { skipLocal: true });
        status('נטען. הטקסט שהיה כאן לא נשמר; הוא עדיין בדפדפן, ויוצע שוב בפעם הבאה שתפתח את הפריט.');
      }],
    ]);
    status(err.message, 'err');
  }

  // Saves are serialized; a change made during a save triggers one more.
  async function save(extra = {}) {
    if (editor.saving) {
      await editor.saving;
      if (!editor.dirty && !Object.keys(extra).length) return editor.entry;
    }
    const body = { ...collect(), ...extra };
    if (!editor.entry && !body.title.trim() && !body.body.trim()) return null;
    // While another window's save waits for a decision, only that decision saves.
    if (!$('ed-notice').hidden && editor.conflict && !extra.overwrite) return editor.entry;
    editor.dirty = false;
    status('שומר...');
    const run = (async () => {
      const before = localKey();
      try {
        if (editor.entry) {
          editor.entry = await send(`/api/studio/entries/${editor.entry.id}`, 'PATCH', { ...body, baseUpdatedAt: editor.entry.updatedAt });
        } else {
          editor.entry = await send('/api/studio/entries', 'POST', body);
          history.replaceState(null, '', `#item/${editor.entry.id}`);
          current = location.hash;
        }
        editor.conflict = false;
        if (before !== localKey()) {
          // A new item got its id: the copy moves to the item's own key.
          forgetLocal(before);
          if (editor.dirty) keepLocal();
        } else if (!editor.dirty) forgetLocal(before);
        if (!$('ed-slug').matches(':focus')) $('ed-slug').value = editor.entry.slug ?? '';
        reflect(editor.entry);
        $('ed-history').hidden = false;
        if (editor.dirty) editor.flush();
        return editor.entry;
      } catch (err) {
        editor.dirty = true;
        keepLocal();
        if (err.data?.conflict) {
          editor.conflict = true;
          conflicted(err);
        } else if (!(err instanceof AuthError)) status(err instanceof TypeError || navigator.onLine === false ? 'אין חיבור לשרת. הטקסט שמור בדפדפן, ויישמר כשהחיבור יחזור.' : err.message, 'err');
        throw err;
      } finally {
        editor.saving = null;
      }
    })();
    editor.saving = run;
    return run;
  }
  editor.flush = debounce(() => save().catch(() => {}), 1200);

  const renderPreview = debounce(async () => {
    if ($('view-edit').classList.contains('split') === false) return;
    try {
      const { html } = await send('/api/studio/preview', 'POST', { body: $('ed-body').value, mode: $('ed-kind').value === 'song' ? 'chords' : 'markdown' });
      $('ed-preview').innerHTML = html; // rendered and sanitized by the server
    } catch {
      // the next keystroke tries again
    }
  }, 400);

  for (const f of fields) {
    $(`ed-${f}`).addEventListener(f === 'kind' || f === 'space' || f === 'comments' ? 'change' : 'input', () => {
      changed();
      if (f === 'kind') modeFor($('ed-kind').value);
      if (f === 'body' || f === 'kind') renderPreview();
    });
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$('view-project').hidden) {
      e.preventDefault();
      saveProject().catch(() => {});
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$('view-edit').hidden) {
      e.preventDefault();
      editor.flush.cancel();
      save().catch(() => {});
    }
  });
  // Back online: send what waited.
  window.addEventListener('online', () => {
    if (editor.dirty && !$('view-edit').hidden) editor.flush();
  });
  window.addEventListener('beforeunload', (e) => {
    if (editor.dirty || project.dirty || cvView.dirty()) e.preventDefault();
  });

  $('publish').addEventListener('click', async () => {
    const publishing = editor.entry?.status !== 'published';
    if (publishing && $('ed-visibility').value === 'private' && !confirm('הפריט מוגדר "רק אני", אז גם אחרי פרסום רק אתה תראה אותו. להמשיך?')) return;
    editor.flush.cancel();
    try {
      await save({ status: publishing ? 'published' : 'draft' });
    } catch {
      // status line shows the error
    }
  });

  $('delete-article').addEventListener('click', async () => {
    if (!editor.entry || !confirm('להעביר את הפריט לסל המחזור? אפשר להחזיר אותו משם עד 30 יום, עם התגובות והקבצים.')) return;
    editor.flush.cancel();
    try {
      await call(`/api/studio/entries/${editor.entry.id}`, { method: 'DELETE' });
      editor.dirty = false;
      forgetLocal();
      refreshTrashCount();
      location.hash = $('ed-back').getAttribute('href');
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, 'err');
    }
  });

  function setSplit(split) {
    $('view-edit').classList.toggle('split', split);
    $('ed-preview').hidden = !split;
    $('toggle-preview').textContent = split ? 'הסתרת תצוגה מקדימה' : 'תצוגה מקדימה';
    if (split) renderPreview();
  }
  $('toggle-preview').addEventListener('click', () => setSplit(!$('view-edit').classList.contains('split')));
  // On a phone the preview would sit under the text: it starts hidden there.
  if (phone.matches) setSplit(false);

  // Markdown helpers: wrap the selection or prefix the current lines.
  $('md-tools').addEventListener('click', (e) => {
    const kind = e.target.closest('button')?.dataset.md;
    if (!kind) return;
    const ta = $('ed-body');
    const { selectionStart: s, selectionEnd: t, value } = ta;
    const sel = value.slice(s, t);
    let out;
    if (kind === 'bold' || kind === 'italic') {
      const m = kind === 'bold' ? '**' : '*';
      out = `${m}${sel || 'טקסט'}${m}`;
    } else if (kind === 'link') {
      out = `[${sel || 'טקסט'}](https://)`;
    } else {
      const prefix = { h2: '## ', h3: '### ', quote: '> ', list: '- ' }[kind];
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const block = value.slice(lineStart, t);
      out = block.split('\n').map((l) => prefix + l).join('\n');
      ta.setRangeText(out, lineStart, t, 'end');
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      return;
    }
    ta.setRangeText(out, s, t, 'select');
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  });

  // ---------- files ----------
  // The file goes up as the request body itself, so a big video streams
  // into storage (src/blobs.js). onProgress gets 0..1 as it goes.
  const MAX_UPLOAD = 95 * 1024 * 1024;
  const TYPE_BY_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const typeOf = (file) => file.type || TYPE_BY_EXT[/\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase()] || 'application/octet-stream';
  function upload(entryId, file, onProgress = () => {}) {
    if (file.size > MAX_UPLOAD) return Promise.reject(new Error(`${file.name} גדול מ־95MB. מעלים אותו לדרייב ומדביקים כאן את הקישור.`));
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/studio/files?entryId=${encodeURIComponent(entryId)}&name=${encodeURIComponent(file.name)}`);
      x.setRequestHeader('Content-Type', typeOf(file));
      x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onerror = () => reject(new Error(`ההעלאה של ${file.name} נקטעה. בודקים את החיבור ומנסים שוב.`));
      x.onload = () => {
        let data = {};
        try {
          data = JSON.parse(x.responseText);
        } catch {
          // no body
        }
        if (x.status === 401) {
          showLogin('הכניסה פגה. צריך להיכנס שוב.');
          return reject(new AuthError());
        }
        if (x.status === 413) return reject(new Error(`${file.name} גדול מ־95MB. מעלים אותו לדרייב ומדביקים כאן את הקישור.`));
        if (x.status === 400 && /Unsupported/.test(data.error ?? '')) return reject(new Error(`את ${file.name} אי אפשר להעלות: רק תמונה, שמע, וידאו, PDF או פרויקט קיובייס.`));
        if (x.status < 200 || x.status >= 300) return reject(new Error(data.error || `שגיאה ${x.status}`));
        onProgress(1);
        resolve(data);
      };
      x.send(file);
    });
  }


  $('ed-upload').addEventListener('click', () => $('ed-file').click());
  $('ed-file').addEventListener('change', async () => {
    const file = $('ed-file').files[0];
    $('ed-file').value = '';
    if (!file) return;
    try {
      // Files belong to a saved item, so save a new article first.
      if (!editor.entry) {
        if (!$('ed-title').value.trim()) $('ed-title').value = file.name.replace(/\.[^.]+$/, '');
        editor.flush.cancel();
        await save();
      }
      status(`מעלה ${file.name}...`);
      const f = await upload(editor.entry.id, file, (p) => status(`מעלה ${file.name}... ${Math.round(p * 100)}%`));
      const alt = f.name.replace(/[\[\]]/g, '');
      const snippet = f.kind === 'image' ? `![${alt}](${f.url})` : `[${alt}](${f.url})`;
      const ta = $('ed-body');
      ta.setRangeText(`${snippet}\n`, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, 'err');
    }
  });

  // A file for a version row: upload it and put its address in the row.
  $('ed-version-file').addEventListener('change', () => {
    const file = $('ed-version-file').files[0];
    $('ed-version-file').value = '';
    if (file && versionTarget) uploadVersion(file, versionTarget);
  });
  async function uploadVersion(file, row) {
    try {
      if (!editor.entry) {
        if (!$('ed-title').value.trim()) $('ed-title').value = file.name.replace(/\.[^.]+$/, '');
        editor.flush.cancel();
        await save();
      }
      status(`מעלה ${file.name}...`);
      const f = await upload(editor.entry.id, file, (p) => status(`מעלה ${file.name}... ${Math.round(p * 100)}%`));
      row.querySelector('[data-f="url"]').value = f.url;
      const label = row.querySelector('[data-f="label"]');
      if (!label.value) label.value = f.name.replace(/\.[^.]+$/, '');
      if (f.kind === 'audio' || f.kind === 'video') row.querySelector('[data-f="kind"]').value = f.kind;
      row.dispatchEvent(new Event('input')); // saves, and shows the player
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, 'err');
    }
  }
  // Recordings and videos dropped on the box become new versions, one by one.
  const mediaBox = $('ed-versions').closest('fieldset');
  mediaBox.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
    ev.preventDefault();
    mediaBox.classList.add('over');
  });
  mediaBox.addEventListener('dragleave', (ev) => {
    if (!mediaBox.contains(ev.relatedTarget)) mediaBox.classList.remove('over');
  });
  mediaBox.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    mediaBox.classList.remove('over');
    for (const file of ev.dataTransfer?.files ?? []) {
      if (file.size > MAX_UPLOAD) {
        status(`${file.name} גדול מ־95MB: מעלים לדרייב ומדביקים את הקישור`, 'err');
        continue;
      }
      const row = versionRow();
      $('ed-versions').append(row);
      await uploadVersion(file, row);
    }
  });

  // ---------- projects ----------
  const project = { entry: null, dirty: false };

  async function loadProjects() {
    try {
      const [a, b] = await Promise.all([call('/api/studio/entries?kind=project'), call('/api/studio/entries?kind=work')]);
      const all = [...a.entries, ...b.entries];
      const onCv = all.filter((p) => p.meta?.cv?.show).sort((x, y) => (x.meta.cv.order ?? 999) - (y.meta.cv.order ?? 999));
      const rest = all.filter((p) => !p.meta?.cv?.show);
      $('projects-empty').hidden = all.length > 0;
      $('projects').replaceChildren(...[...onCv, ...rest].map((p) => projectRow(p, onCv)));
    } catch (err) {
      report('projects-msg')(err);
    }
  }

  function projectRow(p, onCv) {
    const s = p.meta?.synced ?? {};
    const src = p.meta?.source ? (p.meta.source.repo ?? new URL(p.meta.source.url).host) : null;
    const i = onCv.indexOf(p);
    const move = (d) => async () => {
      const list = [...onCv];
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      try {
        await Promise.all(list.map((x, k) => (x.meta.cv.order === k + 1 ? null : send(`/api/studio/entries/${x.id}`, 'PATCH', { meta: { ...x.meta, cv: { show: true, order: k + 1 } } }))));
      } finally {
        loadProjects();
      }
    };
    return h(
      'li',
      {},
      h('a', { className: 'title', href: `#project/${p.id}`, dir: 'auto', textContent: p.title || s.name || 'בלי שם' }),
      i >= 0
        ? h('span', { className: 'order' }, h('button', { className: 'btn small', type: 'button', textContent: '↑', title: 'למעלה', onclick: move(-1) }), h('button', { className: 'btn small', type: 'button', textContent: '↓', title: 'למטה', onclick: move(1) }))
        : h('span'),
      h(
        'div',
        { className: 'meta' },
        i >= 0 ? h('span', { className: 'badge vis-public', textContent: `קורות חיים #${i + 1}` }) : null,
        h('span', { className: `badge ${p.status === 'draft' ? 'draft' : 'vis-public'}`, textContent: p.status === 'draft' ? 'טיוטה' : 'פורסם' }),
        h('span', { className: `badge vis-${p.visibility}`, textContent: VIS[p.visibility] }),
        src ? h('span', { dir: 'ltr', textContent: src }) : null,
        p.meta?.syncError ? h('span', { className: 'msg err', textContent: 'הרענון נכשל' }) : s.syncedAt ? h('time', { textContent: `רוענן ${fmt(s.syncedAt)}` }) : null,
      ),
    );
  }

  $('new-project').addEventListener('click', () => (location.hash = '#project-new'));
  $('sync-all').addEventListener('click', async () => {
    say('projects-msg', 'מרענן...');
    const [a, b] = await Promise.all([call('/api/studio/entries?kind=project'), call('/api/studio/entries?kind=work')]).catch(() => [{ entries: [] }, { entries: [] }]);
    const withSource = [...a.entries, ...b.entries].filter((p) => p.meta?.source);
    const failed = [];
    for (const p of withSource) {
      await send(`/api/studio/entries/${p.id}/sync`, 'POST').catch((err) => failed.push(`${p.title}: ${err.message}`));
    }
    const noSource = [...a.entries, ...b.entries].filter((p) => !p.meta?.source).map((p) => p.title);
    const parts = [`רוענו ${withSource.length - failed.length} מתוך ${withSource.length} (כוכבים, שפות ותאריך עדכון. הטקסטים שכתבת נשארים)`];
    if (noSource.length) parts.push(`בלי מקור: ${noSource.join(', ')}`);
    if (failed.length) parts.push(`נכשלו: ${failed.join('; ')}`);
    say('projects-msg', parts.join('. '), failed.length ? 'err' : 'ok');
    loadProjects();
  });

  const LINKS = { code: 'p-link-code', live: 'p-link-live', playGame: 'p-link-play' };

  function factsToText(facts) {
    return (facts ?? []).map((f) => [f.he, f.en, typeof f.v === 'object' ? f.v.he : f.v, typeof f.v === 'object' ? f.v.en : f.v].join(' | ')).join('\n');
  }
  function textToFacts(text) {
    return text
      .split('\n')
      .map((l) => l.split('|').map((x) => x.trim()))
      .filter((p) => p[0])
      .map(([he, en, vhe, ven]) => ({ he, en: en || he, v: ven && ven !== vhe ? { he: vhe ?? '', en: ven } : vhe ?? '' }));
  }

  function showSynced(entry) {
    const s = entry?.meta?.synced;
    const rows = [];
    if (entry?.meta?.syncError) rows.push(h('span', { className: 'err', textContent: `הרענון האחרון נכשל: ${entry.meta.syncError}` }));
    if (s) {
      rows.push(h('span', { textContent: `רוענן ${fmt(s.syncedAt)}${s.pushedAt ? ` · עדכון אחרון במקור ${fmt(s.pushedAt)}` : ''}${s.stars ? ` · ★ ${s.stars}` : ''}` }));
      if (s.description) rows.push(h('span', { dir: 'auto', textContent: `תיאור מהמקור: ${s.description}` }));
      const tags = s.topics?.length ? s.topics : s.languages;
      if (tags?.length) rows.push(h('span', { dir: 'ltr', textContent: tags.join(', ') }));
      if (s.homepage) rows.push(h('span', { dir: 'ltr', textContent: s.homepage }));
      if (s.readme) rows.push(h('span', { textContent: `README: ${s.readme.length.toLocaleString()} תווים` }));
    }
    $('p-synced').replaceChildren(...rows);
  }

  function fillProject(entry) {
    const m = entry?.meta ?? {};
    $('p-title').value = entry?.title ?? '';
    $('p-title-en').value = m.en?.title ?? '';
    $('p-summary').value = entry?.summary ?? '';
    $('p-summary-en').value = m.en?.summary ?? '';
    $('p-tag').value = m.tag ?? '';
    $('p-tag-en').value = m.en?.tag ?? '';
    $('p-kind').value = entry?.kind ?? 'project';
    $('p-source').value = m.source ? (m.source.repo ?? m.source.url) : '';
    for (const [k, id] of Object.entries(LINKS)) $(id).value = (m.links ?? []).find((l) => l.k === k)?.href ?? '';
    $('p-image').value = m.image ?? '';
    $('p-tags').value = (entry?.tags ?? []).join(', ');
    $('p-note').value = m.note ?? '';
    $('p-note-en').value = m.en?.note ?? '';
    $('p-facts').value = factsToText(m.facts);
    $('p-visibility').value = entry?.visibility ?? 'public';
    $('p-state').value = entry?.status ?? 'draft';
    $('p-cv').checked = Boolean(m.cv?.show);
    $('p-body').value = entry?.body ?? '';
    $('p-delete').hidden = !entry;
    $('p-view').hidden = !(entry?.status === 'published' && entry.slug);
    if (entry?.slug) $('p-view').href = `/work/${encodeURIComponent(entry.slug)}`;
    siteHere(entry?.status === 'published' && entry.slug ? `/work/${encodeURIComponent(entry.slug)}` : '/software');
    showSynced(entry);
    $('p-status').textContent = entry ? `נשמר ${fmt(entry.updatedAt)}` : 'פרויקט חדש';
    project.dirty = false;
  }

  async function openProject(id) {
    project.entry = null;
    fillProject(null);
    if (!id) return $('p-title').focus();
    try {
      project.entry = await call(`/api/studio/entries/${id}`);
      fillProject(project.entry);
    } catch (err) {
      if (!(err instanceof AuthError)) $('p-status').textContent = err.message;
    }
  }

  function parseSourceInput(v) {
    v = v.trim();
    if (!v) return null;
    const gh = v.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
    if (gh) return { type: 'github', repo: `${gh[1]}/${gh[2]}` };
    return { type: 'url', url: v };
  }

  function collectProject() {
    const old = project.entry?.meta ?? {};
    const links = Object.entries(LINKS)
      .map(([k, id]) => ({ k, href: $(id).value.trim() }))
      .filter((l) => l.href);
    const cvShow = $('p-cv').checked;
    const meta = {
      ...old,
      en: { title: $('p-title-en').value.trim(), summary: $('p-summary-en').value.trim(), tag: $('p-tag-en').value.trim(), note: $('p-note-en').value.trim() },
      tag: $('p-tag').value.trim(),
      note: $('p-note').value.trim(),
      source: parseSourceInput($('p-source').value),
      links,
      image: $('p-image').value.trim(),
      facts: textToFacts($('p-facts').value),
      cv: { show: cvShow, order: old.cv?.order ?? 999 },
    };
    delete meta.synced;
    delete meta.syncError;
    return {
      kind: $('p-kind').value,
      title: $('p-title').value,
      summary: $('p-summary').value,
      tags: $('p-tags').value,
      visibility: $('p-visibility').value,
      status: $('p-state').value,
      body: $('p-body').value,
      meta,
    };
  }

  async function saveProject() {
    const body = collectProject();
    $('p-status').textContent = 'שומר...';
    try {
      if (project.entry) {
        project.entry = await send(`/api/studio/entries/${project.entry.id}`, 'PATCH', { ...body, baseUpdatedAt: project.entry.updatedAt });
      } else {
        if (!body.title.trim() && !body.meta.source) throw new Error('צריך שם או מקור');
        if (!body.title.trim()) body.title = body.meta.source.repo?.split('/')[1] ?? '';
        project.entry = await send('/api/studio/entries', 'POST', body);
        history.replaceState(null, '', `#project/${project.entry.id}`);
        current = location.hash;
      }
      fillProject(project.entry);
      return project.entry;
    } catch (err) {
      if (!(err instanceof AuthError)) $('p-status').textContent = err.message;
      throw err;
    }
  }

  $('p-save').addEventListener('click', () => saveProject().catch(() => {}));
  $('p-upload').addEventListener('click', () => $('p-file').click());
  $('p-file').addEventListener('change', async () => {
    const file = $('p-file').files[0];
    $('p-file').value = '';
    if (!file) return;
    try {
      const entry = project.entry ?? (await saveProject());
      $('p-status').textContent = `מעלה ${file.name}...`;
      const f = await upload(entry.id, file);
      $('p-image').value = f.url;
      await saveProject();
    } catch (err) {
      if (!(err instanceof AuthError)) $('p-status').textContent = err.message;
    }
  });
  $('view-project').addEventListener('input', () => {
    project.dirty = true;
    $('p-status').textContent = 'לא נשמר';
  });
  $('p-sync').addEventListener('click', async () => {
    try {
      const entry = await saveProject();
      $('p-status').textContent = 'מרענן מהמקור...';
      project.entry = await send(`/api/studio/entries/${entry.id}/sync`, 'POST');
      fillProject(project.entry);
      $('p-status').textContent = 'רוענן מהמקור';
    } catch (err) {
      if (!(err instanceof AuthError)) $('p-status').textContent = err.message;
      if (project.entry) openProject(project.entry.id).then(() => ($('p-status').textContent = err.message));
    }
  });
  $('p-delete').addEventListener('click', async () => {
    if (!project.entry || !confirm('להעביר את הפרויקט לסל המחזור? אפשר להחזיר אותו משם עד 30 יום.')) return;
    try {
      await call(`/api/studio/entries/${project.entry.id}`, { method: 'DELETE' });
      project.dirty = false;
      location.hash = '#projects';
    } catch (err) {
      if (!(err instanceof AuthError)) $('p-status').textContent = err.message;
    }
  });

  // ---------- community ----------
  const STATUS = { active: 'פעיל', pending: 'ממתין', suspended: 'מושעה' };

  async function loadCommunity() {
    try {
      const [{ users, invites }] = await Promise.all([call('/api/studio/community'), loadComms()]);
      if (!$('inv-communities').querySelector('input:checked')) pickComms($('inv-communities'));
      const pending = users.filter((u) => u.status === 'pending');
      const members = users.filter((u) => u.status !== 'pending');
      showPendingCount(pending.length);
      $('pending').replaceChildren(...pending.map((u) => person(u, [['אישור בלי קהילות', () => setStatus(u, 'active')], ['דחייה', () => remove(u, 'לדחות את הבקשה?'), 'danger']])));
      $('pending-empty').hidden = pending.length > 0;
      $('members').replaceChildren(
        ...members.map((u) =>
          person(u, [
            ...(u.isOwner ? [] : [['זה החשבון שלי', () => confirm(`${u.displayName} הוא החשבון שלך? הוא ייכנס לכל הקהילות, גם לחדשות.`) && send('/api/studio/settings/owner-member', 'PUT', { userId: u.id }).then(reloadPeople, report('invite-msg'))]]),
            u.status === 'active' ? ['השעיה', () => setStatus(u, 'suspended')] : ['החזרה', () => setStatus(u, 'active'), 'primary'],
            ...(u.isOwner ? [] : [['הסרה', () => remove(u, `להסיר את ${u.displayName} מהקהילה?`), 'danger']]),
          ]),
        ),
      );
      $('members-empty').hidden = members.length > 0;
      $('invites').replaceChildren(...invites.map(inviteRow));
    } catch (err) {
      report('invite-msg')(err);
    }
  }

  function showPendingCount(n) {
    $('pending-count').textContent = n ? `(${n})` : '';
  }

  function person(u, actions) {
    return h(
      'li',
      {},
      personLink(u.id, u.displayName),
      h('span', { className: 'meta', dir: 'auto' }, h('span', { textContent: `@${u.username}` }), u.isOwner ? h('span', { className: 'badge vis-community', textContent: 'זה אתה · בכל הקהילות' }) : null, h('span', { className: 'badge', textContent: STATUS[u.status] ?? u.status }), h('time', { textContent: fmt(u.createdAt) }), u.viaInvite ? h('span', { textContent: 'דרך הזמנה' }) : null),
      h('span', { className: 'actions' }, ...actions.map(([label, fn, cls = '']) => h('button', { className: `btn small ${cls}`, type: 'button', textContent: label, onclick: fn }))),
      u.note ? h('span', { className: 'note', dir: 'auto', textContent: u.note }) : null,
      memberComms(u),
    );
  }

  // One person, many communities: tick and save. A person's requests start
  // ticked, so approving all of them is one click.
  function memberComms(u) {
    const where = u.communities ?? {};
    const titles = state.comms.filter((c) => where[c.id] === 'active').map((c) => c.title);
    const asked = state.comms.filter((c) => where[c.id] === 'pending').length;
    const waiting = u.status === 'pending' || asked > 0;
    const msg = h('span', { className: 'msg', role: 'status' });
    const boxes = state.comms.map((c) =>
      h(
        'label',
        { className: 'pick' },
        h('input', { type: 'checkbox', value: c.id, checked: Boolean(where[c.id]) }),
        h('span', { dir: 'auto', textContent: c.title }),
        where[c.id] === 'pending' ? h('small', { className: 'badge vis-community', textContent: 'ביקש/ה' }) : null,
      ),
    );
    const save = h('button', {
      className: 'btn small primary',
      type: 'button',
      textContent: waiting ? 'אישור לקהילות המסומנות' : 'שמירה',
      onclick: async () => {
        save.disabled = true;
        msg.textContent = 'שומר...';
        try {
          await send(`/api/studio/members/${u.id}/communities`, 'PUT', { communities: boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value) });
          await reloadPeople();
        } catch (err) {
          save.disabled = false;
          msg.textContent = err.message;
        }
      },
    });
    const label = titles.length ? `קהילות: ${titles.join(', ')}` : 'עוד לא בשום קהילה';
    return h(
      'details',
      { className: 'member-comms', open: waiting && state.comms.length > 0 },
      h('summary', {}, label, asked ? h('span', { className: 'badge vis-community', textContent: asked === 1 ? ' בקשה אחת' : ` ${asked} בקשות` }) : null),
      state.comms.length
        ? h('div', { className: 'comm-pick' }, h('div', { className: 'picks' }, ...boxes), h('div', { className: 'pick-bar' }, save, msg))
        : h('a', { href: '#communities', textContent: 'עוד אין קהילות. ליצירת קהילה' }),
    );
  }

  const setStatus = (u, status) => send(`/api/studio/members/${u.id}`, 'PATCH', { status }).then(reloadPeople, report(peopleMsg()));
  const remove = (u, question) =>
    confirm(question) &&
    call(`/api/studio/members/${u.id}`, { method: 'DELETE' }).then(() => (personView.id ? (location.hash = '#community') : loadCommunity()), report(peopleMsg()));

  // ---------- one person ----------
  // Every name in the studio leads here (#person/<id>): the person, their
  // communities, and what they wrote or were credited with, each a step from
  // its place on the site and in the studio.
  const personView = { id: null };
  const peopleMsg = () => (personView.id ? 'pp-status' : 'invite-msg');
  const reloadPeople = () => (personView.id ? openPerson(personView.id) : loadCommunity());

  // A name that opens that person's page; the owner's own words (no id) stay plain.
  function personLink(id, name, cls = 'who') {
    return id ? h('a', { className: cls, href: `#person/${id}`, dir: 'auto', textContent: name }) : h('span', { className: cls, dir: 'auto', textContent: name });
  }

  const linkRow = (main, metaKids, actions = [], note = null) =>
    h('li', {}, main, h('span', { className: 'meta', dir: 'auto' }, ...metaKids), actions.length ? h('span', { className: 'actions' }, ...actions) : null, note);
  const btnLink = (href, text) => h('a', { className: 'btn small', href, textContent: text });

  async function openPerson(id) {
    personView.id = id;
    say('pp-status', 'טוען...');
    try {
      const [data] = await Promise.all([call(`/api/studio/members/${id}`), loadComms()]);
      if (personView.id !== id) return;
      const u = data.person;
      showNavCurrent();
      const actions = u.status === 'pending'
        ? [['אישור בלי קהילות', () => setStatus(u, 'active')], ['דחייה', () => remove(u, 'לדחות את הבקשה?'), 'danger']]
        : [
            ...(u.isOwner ? [] : [['זה החשבון שלי', () => confirm(`${u.displayName} הוא החשבון שלך? הוא ייכנס לכל הקהילות, גם לחדשות.`) && send('/api/studio/settings/owner-member', 'PUT', { userId: u.id }).then(reloadPeople, report('pp-status'))]]),
            u.status === 'active' ? ['השעיה', () => setStatus(u, 'suspended')] : ['החזרה', () => setStatus(u, 'active'), 'primary'],
            ['הסרה', () => remove(u, `להסיר את ${u.displayName} מהקהילה?`), 'danger'],
          ];
      const card = person(u, actions);
      card.classList.add('person-card');
      card.querySelector('.member-comms').open = true;
      card.querySelector('.who').replaceWith(h('h1', { className: 'who', dir: 'auto', textContent: u.displayName }));
      $('pp-card').replaceChildren(card);
      document.title = `${u.displayName} · סטודיו`;

      const comms = state.comms.filter((c) => u.communities[c.id]);
      $('pp-comms').replaceChildren(
        ...comms.map((c) =>
          linkRow(
            h('a', { className: 'who', href: `#group/${c.id}`, dir: 'auto', textContent: c.title }),
            [h('span', { className: `badge${u.communities[c.id] === 'pending' ? ' vis-community' : ''}`, textContent: u.communities[c.id] === 'pending' ? 'ביקש/ה להצטרף' : 'חבר/ה' })],
            [
              btnLink(c.path, 'באתר'),
              u.communities[c.id] === 'active' && u.status === 'active' ? btnLink(`${c.path}/chat?to=${encodeURIComponent(u.id)}`, 'הודעה פרטית') : null,
            ].filter(Boolean),
          ),
        ),
      );
      $('pp-comms-empty').hidden = comms.length > 0;

      $('pp-comments').replaceChildren(
        ...data.comments.map((c) =>
          linkRow(
            c.on.path ? h('a', { className: 'who', href: c.on.path, dir: 'auto', textContent: c.on.title || 'בלי כותרת' }) : h('span', { className: 'who', dir: 'auto', textContent: c.on.title || 'פריט שנמחק' }),
            [c.on.kind === 'post' ? h('span', { className: 'badge', textContent: 'פוסט' }) : null, c.status === 'resolved' ? h('span', { className: 'badge', textContent: 'טופל' }) : null, h('time', { textContent: fmt(c.createdAt) })].filter(Boolean),
            [c.on.kind === 'post' ? btnLink('#blog', 'לבלוגים') : c.on.id ? btnLink(`#item/${c.on.id}`, 'לעריכה') : null].filter(Boolean),
            h('span', { className: 'note', dir: 'auto', textContent: c.body }),
          ),
        ),
      );
      $('pp-comments-empty').hidden = data.comments.length > 0;

      $('pp-posts').replaceChildren(
        ...data.posts.map((p) =>
          linkRow(
            p.path ? h('a', { className: 'who', href: p.path, dir: 'auto', textContent: p.title }) : h('span', { className: 'who', dir: 'auto', textContent: p.title }),
            [
              state.commById.get(p.spaceId) ? h('a', { href: `#group/${p.spaceId}`, dir: 'auto', textContent: state.commById.get(p.spaceId).title }) : null,
              p.status === 'hidden' ? h('span', { className: 'badge', textContent: 'מוסתר' }) : null,
              p.public ? h('span', { className: 'badge', textContent: 'פתוח לכולם' }) : null,
              h('time', { textContent: fmt(p.createdAt) }),
            ].filter(Boolean),
            [],
            p.excerpt ? h('span', { className: 'note', dir: 'auto', textContent: p.excerpt }) : null,
          ),
        ),
      );
      $('pp-posts-empty').hidden = data.posts.length > 0;

      $('pp-credits').replaceChildren(
        ...data.credits.map((x) =>
          linkRow(
            h('a', { className: 'who', href: x.kind === 'project' || x.kind === 'work' ? `#project/${x.id}` : `#item/${x.id}`, dir: 'auto', textContent: x.title || 'בלי כותרת' }),
            x.roles.length ? [h('span', { dir: 'auto', textContent: x.roles.join(', ') })] : [],
            x.path ? [btnLink(x.path, 'באתר')] : [],
          ),
        ),
      );
      $('pp-credits-empty').hidden = data.credits.length > 0;

      $('pp-tagged').replaceChildren(
        ...data.tagged.map((t) =>
          linkRow(
            t.path ? h('a', { className: 'who', href: t.path, dir: 'auto', textContent: t.title || 'בלי כותרת' }) : h('span', { className: 'who', dir: 'auto', textContent: t.title || 'בלי כותרת' }),
            [h('span', { textContent: t.what === 'post' ? 'בפוסט' : 'בתגובה' }), h('time', { textContent: fmt(t.at) })],
            t.entryId ? [btnLink(`#item/${t.entryId}`, 'לעריכה')] : [],
          ),
        ),
      );
      $('pp-tagged-empty').hidden = data.tagged.length > 0;
      say('pp-status', '');
    } catch (err) {
      report('pp-status')(err);
    }
  }

  function inviteRow(inv) {
    const link = `${location.origin}/join?code=${inv.code}`;
    const expired = inv.expiresAt && inv.expiresAt < new Date().toISOString();
    const used = inv.uses >= inv.maxUses;
    const standing = expired ? 'פג תוקף' : used ? 'נוצל' : `${inv.uses}/${inv.maxUses} נוצלו${inv.expiresAt ? ` · עד ${fmt(inv.expiresAt)}` : ''}`;
    return h(
      'li',
      {},
      h('span', { className: 'who', dir: 'auto', textContent: inv.note || 'הזמנה' }),
      h('span', { className: 'meta' }, h('span', { textContent: standing }), ...(inv.communities ?? []).map((cid) => h('span', { className: 'badge', dir: 'auto', textContent: state.commById.get(cid)?.title ?? '' }))),
      h(
        'span',
        { className: 'actions' },
        expired || used
          ? null
          : h('button', {
              className: 'btn small primary',
              type: 'button',
              textContent: 'העתקת קישור',
              onclick: async (e) => {
                await navigator.clipboard.writeText(link).catch(() => prompt('הקישור:', link));
                e.target.textContent = 'הועתק';
              },
            }),
        h('button', { className: 'btn small danger', type: 'button', textContent: 'ביטול', onclick: () => confirm('לבטל את הקישור?') && call(`/api/studio/invites/${inv.code}`, { method: 'DELETE' }).then(loadCommunity, report('invite-msg')) }),
      ),
      h('code', { className: 'note', textContent: link }),
    );
  }

  $('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const inv = await send('/api/studio/invites', 'POST', { note: $('inv-note').value, maxUses: $('inv-uses').value, days: $('inv-days').value, communities: pickedComms($('inv-communities')) });
      $('inv-note').value = '';
      pickComms($('inv-communities'));
      await navigator.clipboard.writeText(`${location.origin}/join?code=${inv.code}`).then(
        () => say('invite-msg', 'הקישור נוצר והועתק', 'ok'),
        () => say('invite-msg', 'הקישור נוצר', 'ok'),
      );
      loadCommunity();
    } catch (err) {
      report('invite-msg')(err);
    }
  });

  // ---------- communities ----------
  async function loadGroups() {
    try {
      const list = await loadComms();
      $('g-list').replaceChildren(
        ...list.map((c) =>
          h(
            'li',
            {},
            h('a', { className: 'who', href: `#group/${c.id}`, dir: 'auto', textContent: c.title }),
            h(
              'span',
              { className: 'meta' },
              h('span', { textContent: c.members === 1 ? 'חבר אחד' : `${c.members} חברים` }),
              c.requests ? h('span', { className: 'badge vis-community', textContent: c.requests === 1 ? 'בקשה אחת' : `${c.requests} בקשות` }) : null,
              h('span', { textContent: c.entries === 1 ? 'פריט אחד' : `${c.entries} פריטים` }),
              c.spaces ? h('span', { textContent: c.spaces === 1 ? 'ספר או סדרה אחד' : `${c.spaces} ספרים וסדרות` }) : null,
              h('span', { className: 'badge', textContent: c.joinMode === 'closed' ? 'בהזמנה בלבד' : 'אפשר לבקש' }),
              c.hidden ? h('span', { className: 'badge draft', textContent: 'נסתרת' }) : null,
            ),
            c.summary ? h('span', { className: 'note', dir: 'auto', textContent: c.summary }) : null,
          ),
        ),
      );
      $('g-empty').hidden = list.length > 0;
    } catch (err) {
      report('g-msg')(err);
    }
  }

  $('g-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await send('/api/studio/communities', 'POST', { title: $('g-new-title').value });
      $('g-new-title').value = '';
      await loadComms();
      location.hash = `#group/${c.id}`;
    } catch (err) {
      report('g-msg')(err);
    }
  });

  const groupView = { id: null };

  async function openGroup(id) {
    groupView.id = id;
    try {
      await loadComms();
      const c = state.commById.get(id);
      if (!c) return void say('g-status', 'הקהילה לא נמצאה', 'err');
      $('g-title').value = c.title;
      $('g-summary').value = c.summary;
      $('g-join').value = c.joinMode;
      $('g-slug').value = c.slug;
      $('g-sort').value = c.sort ?? 0;
      $('g-hidden').checked = c.hidden;
      $('g-view').href = c.path;
      $('g-chat').href = `${c.path}/chat`;
      siteHere(c.path);
      say('g-status', `${c.members} חברים${c.requests ? ` · ${c.requests} בקשות` : ''}`);
      const [{ members }, { users }, { entries }] = await Promise.all([
        call(`/api/studio/communities/${id}/members`),
        call('/api/studio/community'),
        call('/api/studio/entries'),
      ]);
      const shown = members.filter((m) => m.status !== 'refused');
      $('g-members').replaceChildren(...shown.map((m) => request(m, id, () => openGroup(id), 'g-status', `${c.path}/chat`)));
      $('g-members-empty').hidden = shown.length > 0;
      const inside = new Set(shown.map((m) => m.userId));
      $('g-add').replaceChildren(
        h('option', { value: '', textContent: 'הוספת חבר קיים לקהילה' }),
        ...users.filter((u) => u.status === 'active' && !inside.has(u.id)).map((u) => h('option', { value: u.id, textContent: `${u.displayName} (@${u.username})` })),
      );
      const open = entries.filter((x) => (x.communities ?? []).includes(id));
      $('g-items').replaceChildren(...open.map(itemRow));
      $('g-items-empty').hidden = open.length > 0;
    } catch (err) {
      report('g-status')(err);
    }
  }

  $('g-save').addEventListener('click', async () => {
    try {
      await send(`/api/studio/communities/${groupView.id}`, 'PATCH', {
        title: $('g-title').value,
        summary: $('g-summary').value,
        joinMode: $('g-join').value,
        slug: $('g-slug').value,
        sort: $('g-sort').value,
        hidden: $('g-hidden').checked,
      });
      await openGroup(groupView.id);
      say('g-status', 'נשמר', 'ok');
    } catch (err) {
      report('g-status')(err);
    }
  });
  $('g-delete').addEventListener('click', async () => {
    const c = state.commById.get(groupView.id);
    if (!c || !confirm(`למחוק את "${c.title}"? הפריטים שפתוחים רק לה יישארו פתוחים רק לך, והבלוג שלה יימחק מהאתר.`)) return;
    try {
      await call(`/api/studio/communities/${c.id}`, { method: 'DELETE' });
      location.hash = '#communities';
    } catch (err) {
      report('g-status')(err);
    }
  });
  $('g-add-btn').addEventListener('click', async () => {
    const userId = $('g-add').value;
    if (!userId) return;
    try {
      await send(`/api/studio/communities/${groupView.id}/members`, 'PATCH', { userId, status: 'active' });
      openGroup(groupView.id);
    } catch (err) {
      report('g-status')(err);
    }
  });

  // ---------- comments ----------
  const comments = { filter: 'open' };

  async function loadComments() {
    try {
      const data = await call(`/api/studio/comments${comments.filter ? `?status=${comments.filter}` : ''}`);
      showCommentCount(data.open);
      for (const b of $('c-filters').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.status === comments.filter));
      $('c-list').replaceChildren(...data.comments.map(commentRow));
      $('c-empty').hidden = data.comments.length > 0;
      say('c-msg', '');
    } catch (err) {
      report('c-msg')(err);
    }
  }

  function showCommentCount(n) {
    $('comment-count').textContent = n || '';
  }

  function commentRow(c) {
    const where = state.byId.get(c.entry.spaceId);
    const open = c.status === 'open';
    return h(
      'li',
      {},
      personLink(c.userId, c.author),
      h(
        'span',
        { className: 'meta', dir: 'auto' },
        c.entry.path ? h('a', { href: `${c.entry.path}#c-${c.id}`, textContent: c.entry.title || 'בלי כותרת' }) : h('span', { textContent: c.entry.title || 'פריט שנמחק' }),
        where ? h('span', { textContent: where.parentId ? where.title : wingOf(where.id)?.title }) : null,
        c.replyTo ? h('span', { className: 'badge', textContent: 'תשובה' }) : null,
        open ? null : h('span', { className: 'badge', textContent: 'טופל' }),
        h('time', { textContent: fmt(c.createdAt) }),
      ),
      h(
        'span',
        { className: 'actions' },
        h('button', { className: `btn small ${open ? 'primary' : ''}`, type: 'button', textContent: open ? 'טופל' : 'פתיחה מחדש', onclick: () => send(`/api/studio/comments/${c.id}`, 'PATCH', { status: open ? 'resolved' : 'open' }).then(loadComments, report('c-msg')) }),
        h('a', { className: 'btn small', href: c.entry.kind === 'post' ? '#blog' : `#item/${c.entryId}`, textContent: c.entry.kind === 'post' ? 'לבלוגים' : 'לעריכה' }),
        h('button', { className: 'btn small danger', type: 'button', textContent: 'מחיקה', onclick: () => confirm('למחוק את התגובה?') && call(`/api/comments/${c.id}`, { method: 'DELETE' }).then(loadComments, report('c-msg')) }),
      ),
      c.quote ? h('span', { className: 'note quote', dir: 'auto', textContent: c.quote }) : null,
      h('span', { className: 'note', dir: 'auto', textContent: c.body }),
    );
  }

  $('c-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    comments.filter = b.dataset.status;
    loadComments();
  });

  // ---------- community blogs ----------
  const blog = { status: '', space: '' };

  async function loadBlog() {
    const pick = $('b-space');
    if (!pick.options.length) {
      await loadComms().catch(() => {});
      pick.replaceChildren(h('option', { value: '', textContent: 'כל הקהילות' }), ...state.comms.map((c) => h('option', { value: c.id, textContent: c.title })));
    }
    pick.value = blog.space;
    const where = state.commById.get(blog.space);
    $('b-open').hidden = !where;
    if (where) $('b-open').href = where.path;
    siteHere(where?.path ?? '/community');
    for (const b of $('b-filters').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.status === blog.status));
    try {
      const data = await call(`/api/studio/posts?${new URLSearchParams({ space: blog.space, status: blog.status })}`);
      showBlogCount(data.week);
      $('b-list').replaceChildren(...data.posts.map(postRow));
      $('b-empty').hidden = data.posts.length > 0;
      say('b-msg', '');
    } catch (err) {
      report('b-msg')(err);
    }
  }

  function showBlogCount(n) {
    $('blog-count').textContent = n || '';
  }

  function postRow(p) {
    const where = state.commById.get(p.spaceId);
    const mod = (change) => send(`/api/studio/posts/${p.id}`, 'PATCH', change).then(loadBlog, report('b-msg'));
    const hidden = p.status === 'hidden';
    return h(
      'li',
      {},
      p.path ? h('a', { className: 'who', href: p.path, dir: 'auto', textContent: p.title }) : h('span', { className: 'who', dir: 'auto', textContent: p.title }),
      h(
        'span',
        { className: 'meta', dir: 'auto' },
        where ? h('span', { dir: 'auto', textContent: where.title }) : null,
        p.userId ? h('a', { href: `#person/${p.userId}`, dir: 'auto', textContent: p.author }) : h('span', { textContent: p.author }),
        p.comments ? h('span', { textContent: p.comments === 1 ? 'תגובה אחת' : `${p.comments} תגובות` }) : null,
        p.pinned ? h('span', { className: 'badge', textContent: 'נעוץ' }) : null,
        p.public ? h('span', { className: 'badge', textContent: 'פתוח לכולם' }) : null,
        hidden ? h('span', { className: 'badge', textContent: 'מוסתר' }) : null,
        h('time', { textContent: fmt(p.createdAt) }),
      ),
      h(
        'span',
        { className: 'actions' },
        h('button', { className: 'btn small', type: 'button', textContent: p.pinned ? 'ביטול נעיצה' : 'נעיצה', onclick: () => mod({ pinned: !p.pinned }) }),
        h('button', { className: 'btn small', type: 'button', textContent: p.public ? 'רק לקהילה' : 'פתיחה לכולם', onclick: () => mod({ public: !p.public }) }),
        h('button', { className: 'btn small', type: 'button', textContent: hidden ? 'החזרה' : 'הסתרה', onclick: () => mod({ hidden: !hidden }) }),
        h('button', { className: 'btn small danger', type: 'button', textContent: 'מחיקה', onclick: () => confirm('למחוק את הפוסט, עם כל התגובות עליו?') && call(`/api/blog/posts/${p.id}`, { method: 'DELETE' }).then(loadBlog, report('b-msg')) }),
      ),
      p.excerpt ? h('span', { className: 'note', dir: 'auto', textContent: p.excerpt }) : null,
    );
  }

  $('b-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    blog.status = b.dataset.status;
    loadBlog();
  });
  $('b-space').addEventListener('change', () => {
    blog.space = $('b-space').value;
    loadBlog();
  });

  // ---------- settings ----------
  function socialRow(x = {}) {
    const row = h(
      'div',
      { className: 'social-row' },
      h('input', { type: 'text', value: x.label ?? '', placeholder: 'שם, למשל YouTube', dir: 'auto', ariaLabel: 'שם' }),
      h('input', { type: 'text', value: x.href ?? '', placeholder: 'https://...', dir: 'ltr', ariaLabel: 'כתובת' }),
      h('button', { className: 'btn small danger', type: 'button', textContent: 'הסרה', onclick: () => row.remove() }),
    );
    return row;
  }

  // ---------- trash and backup ----------
  async function refreshTrashCount() {
    try {
      const { items } = await call('/api/studio/trash');
      $('trash-count').textContent = items.length || '';
      return items;
    } catch {
      return null;
    }
  }
  async function loadTrash(msg = '') {
    say('t-msg', msg, msg ? 'ok' : '');
    const items = await refreshTrashCount();
    if (!items) return say('t-msg', 'לא הצלחתי לטעון את הסל.', 'err');
    const left = (iso) => Math.max(0, 30 - Math.floor((Date.now() - new Date(iso)) / DAY));
    $('t-list').replaceChildren(
      ...items.map((t) => {
        const where = state.byId.get(t.spaceId);
        return h(
          'li',
          {},
          h('span', { className: 'who', dir: 'auto', textContent: t.title || 'בלי כותרת' }),
          h(
            'span',
            { className: 'meta', dir: 'auto' },
            h('span', { textContent: KIND[t.kind] ?? t.kind }),
            where ? h('span', { textContent: where.title }) : null,
            h('span', { textContent: `נמחק ${fmt(t.deletedAt)}` }),
            h('span', { textContent: `עוד ${left(t.deletedAt)} ימים בסל` }),
          ),
          h(
            'span',
            { className: 'actions' },
            h('button', {
              className: 'btn small primary',
              type: 'button',
              textContent: 'החזרה',
              onclick: () =>
                send(`/api/studio/trash/${t.id}/restore`, 'POST').then((e) => {
                  loadTrash(`"${e.title || 'בלי כותרת'}" חזר למקום שלו.`);
                  loadSpaces().catch(() => {});
                }, report('t-msg')),
            }),
            h('button', {
              className: 'btn small danger',
              type: 'button',
              textContent: 'מחיקה לתמיד',
              onclick: () => confirm(`למחוק את "${t.title || 'בלי כותרת'}" לתמיד, עם הקבצים והגרסאות שלו? מזה אין דרך חזרה.`) && call(`/api/studio/trash/${t.id}`, { method: 'DELETE' }).then(() => loadTrash(), report('t-msg')),
            }),
          ),
        );
      }),
    );
    $('t-empty').hidden = items.length > 0;
  }

  async function loadSettings() {
    try {
      const { socials } = await call('/api/studio/settings');
      $('socials').replaceChildren(...socials.map(socialRow));
    } catch (err) {
      report('socials-msg')(err);
    }
  }

  $('add-social').addEventListener('click', () => {
    const row = socialRow();
    $('socials').append(row);
    row.querySelector('input').focus();
  });

  $('save-socials').addEventListener('click', async () => {
    const socials = [...$('socials').children].map((r) => {
      const [label, href] = r.querySelectorAll('input');
      return { label: label.value, href: href.value };
    });
    try {
      const saved = await send('/api/studio/settings/socials', 'PUT', { socials });
      $('socials').replaceChildren(...saved.socials.map(socialRow));
      say('socials-msg', 'נשמר', 'ok');
    } catch (err) {
      report('socials-msg')(err);
    }
  });

  // ---------- media links: players while editing ----------
  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)(\?|$)/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;
  // Same rules as src/media.js, so the studio shows what the page will show.
  function ytId(href) {
    try {
      const u = new URL(href);
      const host = u.hostname.replace(/^www\.|^m\./, '');
      if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
      if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (u.pathname === '/watch') return u.searchParams.get('v');
        return u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/)?.[1] ?? null;
      }
    } catch {
      // not a URL
    }
    return null;
  }
  function drId(href) {
    try {
      const u = new URL(href);
      if (u.hostname !== 'drive.google.com' && u.hostname !== 'docs.google.com') return null;
      return u.pathname.match(/\/(?:file\/d|document\/d|presentation\/d)\/([\w-]{10,})/)?.[1] ?? u.searchParams.get('id');
    } catch {
      return null;
    }
  }
  const linkInfo = async (urls) => (await send('/api/studio/link-info', 'POST', { urls })).links;

  // What an uploaded file is, asked once per address.
  const fileTypes = new Map();
  function fileType(url) {
    if (!fileTypes.has(url)) {
      fileTypes.set(url, fetch(url, { method: 'HEAD', credentials: 'same-origin' }).then((r) => (r.ok ? r.headers.get('Content-Type') ?? '' : ''), () => ''));
    }
    return fileTypes.get(url);
  }

  function frame(src, audio) {
    const f = h('iframe', { src, title: 'נגן', loading: 'lazy', allowFullscreen: true });
    f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    return h('div', { className: `media${audio ? ' audio' : ''}` }, f);
  }

  async function player(url, kind) {
    const yt = ytId(url);
    if (yt && /^[\w-]+$/.test(yt)) return frame(`https://www.youtube-nocookie.com/embed/${yt}`, false);
    const drive = drId(url);
    if (drive && /^[\w-]+$/.test(drive)) {
      const open = h('a', { className: 'media-open', href: `https://drive.google.com/file/d/${drive}/view`, target: '_blank', rel: 'noopener', textContent: 'פתיחה בדרייב ↗' });
      if (kind !== 'audio' && kind !== 'video') return h('div', { className: 'player' }, frame(`https://drive.google.com/file/d/${drive}/preview`, false), open);
      // The site's own player, through /media/drive; Drive's frame if Drive will not hand the file over.
      const el = kind === 'audio'
        ? h('audio', { controls: true, preload: 'metadata', src: `/media/drive/${drive}?k=audio` })
        : h('video', { controls: true, preload: 'metadata', playsInline: true, poster: `https://drive.google.com/thumbnail?id=${drive}&sz=w1280`, src: `/media/drive/${drive}?k=video` });
      const box = h('div', { className: `media${kind === 'audio' ? ' audio' : ''}` }, el);
      el.addEventListener('error', () => {
        box.classList.add('framed');
        el.replaceWith(frame(`https://drive.google.com/file/d/${drive}/preview`, kind === 'audio').firstChild);
      }, { once: true });
      return h('div', { className: 'player' }, box, open);
    }
    let k = kind;
    if (!k && /^\/files\/[a-z0-9-]+$/.test(url)) {
      const type = await fileType(url);
      k = type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : '';
    }
    if (!k) k = AUDIO_EXT.test(url) ? 'audio' : VIDEO_EXT.test(url) ? 'video' : '';
    if (k === 'audio') return h('div', { className: 'media audio' }, h('audio', { controls: true, preload: 'metadata', src: url }));
    if (k === 'video') return h('div', { className: 'media' }, h('video', { controls: true, preload: 'metadata', playsInline: true, src: url }));
    return h('p', { className: 'hint', textContent: 'לקישור הזה אין נגן. באתר הוא יופיע ככפתור.' });
  }

  // A version row shows its player and keeps it in step with the link.
  // A pasted Drive or YouTube link fills in audio or video, and a name if empty.
  function enhanceVersion(row) {
    const url = row.querySelector('[data-f="url"]');
    const kind = row.querySelector('[data-f="kind"]');
    const label = row.querySelector('[data-f="label"]');
    const box = h('div', { className: 'version-preview' });
    const note = h('p', { className: 'hint warn', hidden: true });
    row.append(box, note);
    const refresh = debounce(async () => {
      const u = url.value.trim();
      const key = `${u}|${kind.value}`;
      if (box.dataset.key === key) return;
      box.dataset.key = key;
      const node = u ? await player(u, kind.value) : null;
      if (box.dataset.key === key) box.replaceChildren(...(node ? [node] : []));
    }, 250);
    let asked = '';
    const detect = debounce(async () => {
      const u = url.value.trim();
      if (u === asked || !(ytId(u) || drId(u))) return;
      asked = u;
      try {
        const [info] = await linkInfo([u]);
        if (url.value.trim() !== u) return;
        note.hidden = !info.private;
        note.textContent = 'נראה שהקובץ לא משותף. בדרייב: שיתוף, ואז "כל מי שיש לו את הקישור", אחרת המבקרים לא יראו אותו.';
        let touched = false;
        if (info.kind && !kind.value) {
          kind.value = info.kind;
          touched = true;
        }
        if (info.title && !label.value.trim()) {
          label.value = info.title.slice(0, 40);
          touched = true;
        }
        if (touched) row.dispatchEvent(new Event('change'));
      } catch {
        // no title is fine; the row works without it
      }
    }, 400);
    row.addEventListener('input', () => {
      refresh();
      detect();
    });
    row.addEventListener('change', refresh);
    refresh();
  }

  // ---------- project files (Cubase, zip) ----------
  const PROJECT_KIND = { cubase: 'קיובייס', zip: 'ZIP', other: 'אחר' };
  const PROJECT_VIS = { private: 'רק אני', community: 'הקהילה', members: 'כל החברים', public: 'כולם' };
  const projectKindOf = (name) => (/\.(cpr|bak)$/i.test(name) ? 'cubase' : /\.zip$/i.test(name) ? 'zip' : null);
  let projectTarget = null;

  function projectFileRow(p = {}) {
    const tag = (n, f) => {
      n.dataset.f = f;
      return n;
    };
    const select = (f, options, value) => {
      const n = tag(h('select', {}, ...Object.entries(options).map(([v, t]) => h('option', { value: v, textContent: t }))), f);
      n.value = value;
      return n;
    };
    const url = tag(h('input', { type: 'text', value: p.url ?? '', placeholder: 'קישור מהדרייב, או העלאה', dir: 'ltr', title: 'קישור' }), 'url');
    const label = tag(h('input', { type: 'text', value: p.label ?? '', placeholder: 'שם, למשל "מיקס אחרון"', dir: 'auto', title: 'שם' }), 'label');
    const kind = select('kind', PROJECT_KIND, PROJECT_KIND[p.kind] ? p.kind : 'cubase');
    const vis = select('visibility', PROJECT_VIS, PROJECT_VIS[p.visibility] ? p.visibility : 'private');
    vis.title = 'מי יכול להוריד';
    const row = h(
      'div',
      { className: 'version-row project-row' },
      label,
      url,
      kind,
      vis,
      h('button', { className: 'btn small', type: 'button', textContent: 'העלאה', onclick: () => { projectTarget = row; $('ed-project-file').click(); } }),
      h('button', { className: 'btn small danger', type: 'button', textContent: 'הסרה', onclick: () => { row.remove(); changed(); } }),
    );
    // A pasted Drive link: take the name and the kind from the file when it is shared.
    let asked = '';
    const detect = debounce(async () => {
      const u = url.value.trim();
      if (u === asked || !drId(u)) return;
      asked = u;
      try {
        const [info] = await linkInfo([u]);
        if (url.value.trim() !== u || !info.name) return;
        const k = projectKindOf(info.name);
        if (k) kind.value = k;
        if (!label.value.trim()) label.value = info.title.slice(0, 80);
        changed();
      } catch {
        // fine without it
      }
    }, 400);
    row.addEventListener('input', (e) => {
      changed();
      if (e.target === url) detect();
    });
    row.addEventListener('change', changed);
    return row;
  }
  function readProjects() {
    const list = [...$('ed-projects').children]
      .map((r) => Object.fromEntries([...r.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n.value.trim()])))
      .filter((p) => p.url);
    return list.length ? list : undefined;
  }
  $('ed-add-project').addEventListener('click', () => {
    const row = projectFileRow();
    $('ed-projects').append(row);
    row.querySelector('input').focus();
  });
  $('ed-project-file').addEventListener('change', async () => {
    const file = $('ed-project-file').files[0];
    $('ed-project-file').value = '';
    const row = projectTarget;
    if (!file || !row) return;
    if (file.size > MAX_UPLOAD) return void status('הקובץ גדול מ־95MB. מעלים אותו לדרייב ומדביקים כאן את הקישור.', 'err');
    try {
      if (!editor.entry) {
        if (!$('ed-title').value.trim()) $('ed-title').value = file.name.replace(/\.[^.]+$/, '');
        editor.flush.cancel();
        await save();
      }
      status(`מעלה ${file.name}...`);
      const f = await upload(editor.entry.id, file, (p) => status(`מעלה ${file.name}... ${Math.round(p * 100)}%`));
      row.querySelector('[data-f="url"]').value = f.url;
      const label = row.querySelector('[data-f="label"]');
      if (!label.value) label.value = f.name.replace(/\.[^.]+$/, '');
      row.querySelector('[data-f="kind"]').value = f.project ?? projectKindOf(f.name) ?? 'other';
      changed();
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, 'err');
    }
  });

  // ---------- Drive folders ----------
  const isHttps = (u) => /^https:\/\/\S+$/.test(u ?? '');
  // The folder of a space, or of the nearest space above it that has one.
  function driveFolder(spaceId) {
    for (let x = state.byId.get(spaceId), hops = 0; x && hops < 20; x = state.byId.get(x.parentId), hops++) {
      if (isHttps(x.meta?.drive?.folder)) return x.meta.drive.folder;
    }
    return null;
  }
  function showDriveLink(a, folder) {
    a.hidden = !folder;
    if (folder) a.href = folder;
  }
  function driveMeta(old, value) {
    const folder = value.trim();
    if (folder && !isHttps(folder)) return old; // only https links; keep what was there
    return folder ? { ...old, folder } : undefined;
  }
  $('ed-space').addEventListener('change', () => showDriveLink($('ed-drive'), driveFolder($('ed-space').value)));

  // ---------- pasting many links at once ----------
  // where(): the space new drafts go into. versions: also offer "add as versions".
  let batches = 0;
  function linkBatch(mount, { where, versions = false, done = () => {} }) {
    const msgId = `batch-msg-${++batches}`;
    const area = h('textarea', { rows: 4, dir: 'ltr', placeholder: 'https://drive.google.com/file/d/...\nhttps://youtu.be/...', ariaLabel: 'קישורים' });
    const list = h('ul', { className: 'batch-list' });
    const count = h('span', { className: 'hint' });
    const msg = h('p', { className: 'msg', id: msgId, role: 'status' });
    const made = h('ul', { className: 'batch-made' });
    const folder = h('a', { className: 'btn small', target: '_blank', rel: 'noopener', textContent: 'התיקייה בדרייב ↗', hidden: true });
    const asVersions = h('button', { className: 'btn small', type: 'button', textContent: 'להוסיף כגרסאות לפריט הזה', hidden: !versions });
    const asItems = h('button', { className: 'btn small accent', type: 'button', textContent: 'פריט טיוטה לכל קישור' });
    const known = new Map(); // url -> what the server read from it
    const rows = new Map(); // url -> its row

    const urlsIn = (text) => [...new Set(text.match(/https?:\/\/[^\s,<>"']+/g) ?? [])];
    function row(url) {
      const title = h('input', { type: 'text', dir: 'auto', placeholder: 'רגע, קורא את השם...', ariaLabel: 'שם' });
      const kind = h('select', { ariaLabel: 'סוג' }, h('option', { value: '', textContent: 'זיהוי אוטומטי' }), h('option', { value: 'audio', textContent: 'שמע' }), h('option', { value: 'video', textContent: 'וידאו' }));
      const src = h('small', { className: 'src', dir: 'ltr', textContent: url });
      return { li: h('li', {}, title, kind, src), title, kind, src };
    }
    function apply(url, info) {
      const r = rows.get(url);
      if (!r) return;
      if (!r.title.value && info.title) r.title.value = info.title;
      if (!r.kind.value && info.kind) r.kind.value = info.kind;
      r.title.placeholder = info.source === 'drive-folder' ? 'זו תיקייה. צריך קישור לקובץ עצמו' : info.private ? 'הקובץ לא משותף, אז אין שם. מה השם?' : 'מה השם?';
    }
    const read = debounce(async () => {
      const urls = urlsIn(area.value);
      for (const u of [...rows.keys()]) if (!urls.includes(u)) rows.delete(u);
      for (const u of urls) if (!rows.has(u)) rows.set(u, row(u));
      list.replaceChildren(...urls.map((u) => rows.get(u).li));
      count.textContent = urls.length ? `${urls.length} קישורים` : '';
      for (const u of urls) if (known.has(u)) apply(u, known.get(u));
      const fresh = urls.filter((u) => !known.has(u));
      if (!fresh.length) return;
      try {
        for (const info of await linkInfo(fresh)) {
          known.set(info.url, info);
          apply(info.url, info);
        }
      } catch {
        for (const u of fresh) apply(u, {});
      }
    }, 400);
    area.addEventListener('input', read);

    // A folder link is not something to play; it stays in the list until removed.
    const picked = () =>
      [...rows.entries()]
        .filter(([url]) => known.get(url)?.source !== 'drive-folder')
        .map(([url, r]) => ({ url, title: r.title.value.trim(), kind: r.kind.value, row: r }));
    const tabName = (x) => (x.kind === 'audio' ? 'הקלטה' : x.kind === 'video' ? 'וידאו' : 'נגן');
    const clearDone = (urls) => {
      area.value = urlsIn(area.value).filter((u) => !urls.includes(u)).join('\n');
      read();
    };

    asVersions.addEventListener('click', () => {
      const all = picked();
      if (!all.length) return;
      for (const x of all) $('ed-versions').append(versionRow({ label: (x.title || tabName(x)).slice(0, 40), url: x.url, kind: x.kind || undefined }));
      changed();
      clearDone(all.map((x) => x.url));
      say(msgId, `נוספו ${all.length} גרסאות`, 'ok');
    });

    asItems.addEventListener('click', async () => {
      const spaceId = where();
      const kind = (WING_KINDS[wingOf(spaceId)?.id] ?? [])[0];
      if (!spaceId || !kind || kind === 'project') return say(msgId, 'כאן אי אפשר ליצור פריטים מקישורים.', 'err');
      const all = picked();
      const named = all.filter((x) => x.title);
      const created = [];
      let failed = 0;
      say(msgId, 'יוצר טיוטות...');
      for (const x of named) {
        try {
          const version = { label: tabName(x), url: x.url, ...(x.kind ? { kind: x.kind } : {}) };
          created.push({ ...(await send('/api/studio/entries', 'POST', { kind, spaceId, title: x.title, status: 'draft', meta: { versions: [version] } })), from: x.url });
        } catch (err) {
          if (err instanceof AuthError) return;
          failed++;
          x.row.src.textContent = `${x.url} · ${err.message}`;
        }
      }
      clearDone(created.map((x) => x.from));
      const missing = all.length - named.length;
      const parts = [
        created.length ? `נוצרו ${created.length} טיוטות ב${state.byId.get(spaceId)?.title ?? ''}` : null,
        missing ? `ל־${missing} קישורים חסר שם: משלימים ולוחצים שוב` : null,
        failed ? `${failed} לא נשמרו` : null,
      ];
      say(msgId, parts.filter(Boolean).join('. '), missing || failed ? 'err' : 'ok');
      made.replaceChildren(...created.map((x) => h('li', {}, h('a', { href: `#item/${x.id}`, dir: 'auto', textContent: x.title }))));
      if (created.length) done();
    });

    mount.replaceChildren(
      h('summary', { textContent: 'הדבקת קישורים מהדרייב או מיוטיוב' }),
      h(
        'div',
        { className: 'batch-body' },
        h('p', { className: 'hint', textContent: 'קישור בכל שורה, או כמה קישורים שהעתקת יחד מהדרייב. כשהקובץ משותף, השם נקרא ממנו; לקישור בלי שם כותבים אחד.' }),
        area,
        list,
        h('div', { className: 'toolbar' }, asVersions, asItems, folder, count),
        msg,
        made,
      ),
    );
    mount.addEventListener('toggle', () => {
      if (!mount.open) return;
      showDriveLink(folder, driveFolder(where()));
      asItems.hidden = (WING_KINDS[wingOf(where())?.id] ?? ['project'])[0] === 'project';
      area.focus();
    });
  }
  linkBatch(document.querySelector('[data-batch="wing"]'), { where: () => wingView.filter ?? wingView.id, done: () => loadWingItems() });
  linkBatch(document.querySelector('[data-batch="space"]'), { where: () => spaceView.id, done: () => openSpace(spaceView.id) });
  linkBatch(document.querySelector('[data-batch="item"]'), { where: () => $('ed-space').value, versions: true });

  // ---------- moving items ----------
  const mover = { ids: [], single: false, kind: '', resolve: null };

  function fillMove(spaceId) {
    const wing = $('mv-wing').value;
    const ids = inside(wing);
    $('mv-space').replaceChildren(...ids.map((id) => state.byId.get(id)).filter(Boolean).map((x) => h('option', { value: x.id, textContent: x.parentId ? x.title : 'האגף עצמו' })));
    $('mv-space').value = spaceId && ids.includes(spaceId) ? spaceId : wing;
    const kinds = WING_KINDS[wing] ?? [];
    $('mv-kind').replaceChildren(
      ...(mover.single ? [] : [h('option', { value: '', textContent: 'כמו שהוא, אם מתאים לאגף' })]),
      ...kinds.map((k) => h('option', { value: k, textContent: KIND[k] ?? k })),
    );
    $('mv-kind').value = kinds.includes(mover.kind) ? mover.kind : mover.single ? kinds[0] : '';
  }

  // Resolves with the moved entries, or null if the owner changed their mind.
  function openMove(ids, { spaceId = null, kind = '', single = false } = {}) {
    endMove(null);
    Object.assign(mover, { ids, single, kind });
    const wings = state.spaces.filter((x) => !x.parentId);
    $('mv-wing').replaceChildren(...wings.map((w) => h('option', { value: w.id, textContent: w.title })));
    $('mv-wing').value = wingOf(spaceId)?.id ?? wings[0]?.id;
    fillMove(spaceId);
    $('mv-title').textContent = ids.length > 1 ? `לאן להעביר ${ids.length} פריטים?` : 'לאן להעביר?';
    say('mv-msg', '');
    $('move-dialog').showModal();
    return new Promise((r) => (mover.resolve = r));
  }
  function endMove(result) {
    mover.resolve?.(result);
    mover.resolve = null;
  }
  $('mv-wing').addEventListener('change', () => fillMove(null));
  $('mv-cancel').addEventListener('click', () => $('move-dialog').close());
  $('move-dialog').addEventListener('close', () => endMove(null));
  $('mv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('mv-msg', 'מעביר...');
    try {
      const { entries } = await send('/api/studio/entries/move', 'POST', { ids: mover.ids, spaceId: $('mv-space').value, kind: $('mv-kind').value || undefined });
      endMove(entries);
      $('move-dialog').close();
      loadSpaces().catch(() => {});
    } catch (err) {
      report('mv-msg')(err);
    }
  });

  $('ed-move').addEventListener('click', async () => {
    editor.flush.cancel();
    try {
      if (!editor.entry || editor.dirty) await save();
    } catch {
      return; // the status line says why
    }
    if (!editor.entry) return void status('קודם כותבים משהו, ואז מעבירים', 'err');
    const moved = await openMove([editor.entry.id], { spaceId: editor.entry.spaceId, kind: editor.entry.kind, single: true });
    if (!moved?.length) return;
    editor.entry = moved[0];
    if (editor.entry.kind === 'project' || editor.entry.kind === 'work') return void (location.hash = `#project/${editor.entry.id}`);
    fill(editor.entry);
    status(`עבר ל${state.byId.get(editor.entry.spaceId)?.title ?? ''} · ${KIND[editor.entry.kind] ?? ''}`);
  });

  // Back into the notebook: private again, with everything it has.
  $('ed-to-idea').addEventListener('click', async () => {
    editor.flush.cancel();
    if (!editor.entry) return void status('עוד אין מה להחזיר', 'err');
    const live = editor.entry.status === 'published';
    if (!confirm(live ? 'להחזיר לרעיונות? זה יורד מהאתר ונהיה פרטי, עם כל הטקסט, הגרסאות והקבצים.' : 'להחזיר לרעיונות? זה נשמר במחברת עם כל הטקסט, הגרסאות והקבצים.')) return;
    try {
      if (editor.dirty) await save();
      const back = await send(`/api/studio/entries/${editor.entry.id}/to-idea`, 'POST');
      editor.dirty = false;
      editor.entry = null;
      location.hash = back.meta.wing ? `#ideas/${back.meta.wing}` : '#ideas';
    } catch (err) {
      status(err.message, 'err');
    }
  });

  // Marking several items in a wing or space list and moving them together.
  function pickBar(barId, listId, from, reload) {
    const list = $(listId);
    const toggle = h('button', { className: 'btn small', type: 'button' });
    const count = h('span', { className: 'picked' });
    const all = h('button', { className: 'btn small', type: 'button', textContent: 'סימון הכל' });
    const go = h('button', { className: 'btn small accent', type: 'button', textContent: 'להעביר את המסומנים' });
    const boxes = () => [...list.querySelectorAll('.pick')];
    const picked = () => boxes().filter((c) => c.checked).map((c) => c.value);
    const sync = () => {
      const n = picked().length;
      count.textContent = n ? `${n} מסומנים` : 'מסמנים פריטים ברשימה';
      go.disabled = !n;
    };
    const set = (on) => {
      list.classList.toggle('picking', on);
      toggle.textContent = on ? 'סיום' : 'סימון והעברה';
      toggle.setAttribute('aria-pressed', String(on));
      for (const n of [count, all, go]) n.hidden = !on;
      if (!on) for (const c of boxes()) c.checked = false;
      sync();
    };
    toggle.addEventListener('click', () => set(!list.classList.contains('picking')));
    all.addEventListener('click', () => {
      const every = boxes().every((c) => c.checked);
      for (const c of boxes()) c.checked = !every;
      sync();
    });
    list.addEventListener('change', (e) => e.target.matches('.pick') && sync());
    new MutationObserver(sync).observe(list, { childList: true });
    go.addEventListener('click', async () => {
      const moved = await openMove(picked(), { spaceId: from() });
      if (!moved) return;
      set(false);
      reload();
    });
    $(barId).replaceChildren(toggle, count, all, go);
    set(false);
  }
  // ---------- dropping files in: each one becomes a new draft ----------
  function dropzone(zone, target) {
    const input = zone.querySelector('input[type="file"]');
    const list = zone.querySelector('.drop-list');
    zone.querySelector('.pick-files').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      take(files);
    });
    zone.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
      ev.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', (ev) => {
      if (!zone.contains(ev.relatedTarget)) zone.classList.remove('over');
    });
    zone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      zone.classList.remove('over');
      take([...(ev.dataTransfer?.files ?? [])]);
    });
    async function take(files) {
      if (!files.length) return;
      let made = 0;
      for (const f of files) made += (await one(f)) ? 1 : 0;
      if (made) target().done();
    }
    async function one(file) {
      const state = h('span', { className: 'state', textContent: 'מעלה...' });
      const li = h('li', {}, h('span', { className: 'name', dir: 'auto', textContent: file.name }), state);
      list.prepend(li);
      const fail = (text) => {
        li.className = 'err';
        state.textContent = text;
        return false;
      };
      const type = file.type.split(';')[0];
      const ok = /^(audio|video)\//.test(type) || type === 'application/pdf' || /^image\/(png|jpeg|webp|gif)$/.test(type) || projectKindOf(file.name);
      if (!ok) return fail('סוג קובץ שהאתר לא מציג');
      if (file.size > MAX_UPLOAD) return fail('גדול מ־95MB: מעלים לדרייב ומדביקים את הקישור');
      const { spaceId, kind } = target();
      try {
        let entry = await send('/api/studio/entries', 'POST', { kind, spaceId, title: file.name.replace(/\.[^.]+$/, '').slice(0, 200), status: 'draft' });
        const f = await upload(entry.id, file, (p) => {
          state.textContent = `מעלה... ${Math.round(p * 100)}%`;
        });
        const meta = { ...entry.meta };
        const alt = f.name.replace(/[\[\]]/g, '');
        let body;
        if (f.kind === 'audio' || f.kind === 'video') meta.versions = [{ label: f.kind === 'audio' ? 'הקלטה' : 'סרטון', url: f.url, kind: f.kind }];
        else if (f.project) meta.projects = [{ label: f.name, url: f.url, kind: f.project, visibility: 'private' }];
        else body = f.kind === 'image' ? `![${alt}](${f.url})\n` : `[${alt}](${f.url})\n`;
        entry = await send(`/api/studio/entries/${entry.id}`, 'PATCH', { meta, ...(body ? { body } : {}) });
        li.className = 'ok';
        state.replaceChildren(h('a', { href: `#item/${entry.id}`, textContent: 'נשמר כטיוטה · פתיחה' }));
        return true;
      } catch (err) {
        if (err instanceof AuthError) return false;
        return fail(err.message);
      }
    }
  }
  dropzone($('w-drop'), () => ({ spaceId: wingView.filter ?? wingView.id, kind: $('w-kind').value === 'project' ? 'article' : $('w-kind').value, done: loadWingItems }));
  dropzone($('s-drop'), () => {
    const x = state.byId.get(spaceView.id);
    return { spaceId: spaceView.id, kind: (WING_KINDS[x?.wing] ?? ['article'])[0], done: () => openSpace(spaceView.id) };
  });

  pickBar('w-pickbar', 'w-items', () => wingView.filter ?? wingView.id, () => openWing(wingView.id));
  pickBar('s-pickbar', 's-items', () => spaceView.id, () => openSpace(spaceView.id));

  // ---------- the item as visitors will see it ----------
  const pagePreview = { on: false };
  const refreshPage = debounce(async () => {
    if (!pagePreview.on || $('view-edit').hidden) return;
    try {
      const { html } = await send('/api/studio/preview-page', 'POST', { id: editor.entry?.id, ...collect(), as: $('ed-page-as').value });
      const f = $('ed-page-frame');
      const y = f.contentWindow?.scrollY ?? 0;
      f.onload = () => f.contentWindow?.scrollTo(0, y);
      // Links open in a new tab, not inside the preview.
      f.srcdoc = html.replace('<head>', '<head><base target="_blank">');
      say('ed-page-msg', '');
    } catch (err) {
      if (!(err instanceof AuthError)) say('ed-page-msg', err.message, 'err');
    }
  }, 700);
  function setPagePreview(on) {
    pagePreview.on = on;
    $('ed-page').hidden = !on;
    $('view-edit').classList.toggle('with-page', on);
    $('ed-page-toggle').setAttribute('aria-pressed', String(on));
    try {
      localStorage.setItem('studio.pagePreview', on ? '1' : '');
    } catch {
      // private window
    }
    if (on) refreshPage();
  }
  $('ed-page-toggle').addEventListener('click', () => setPagePreview(!pagePreview.on));
  $('ed-page-close').addEventListener('click', () => setPagePreview(false));
  $('ed-page-as').addEventListener('change', refreshPage);
  try {
    if (localStorage.getItem('studio.pagePreview') && matchMedia('(min-width: 1100px)').matches) setPagePreview(true);
  } catch {
    // private window
  }

  // ---------- start ----------
  async function start() {
    try {
      await call('/api/admin/session');
    } catch (err) {
      if (!(err instanceof AuthError)) showLogin(err.message);
      return;
    }
    $('login').hidden = true;
    $('app').hidden = false;
    route();
    call('/api/studio/community').then(({ users }) => showPendingCount(users.filter((u) => u.status === 'pending').length), () => {});
    call('/api/studio/comments?status=open').then(({ open }) => showCommentCount(open), () => {});
    call('/api/studio/posts?status=pinned').then(({ week }) => showBlogCount(week), () => {});
    refreshTrashCount();
  }
  start();
})();
