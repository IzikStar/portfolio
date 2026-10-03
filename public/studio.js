// Studio: the owner's private workspace. Idea notebook and article editor.
// Routes (hash): #ideas, #articles, #new, #edit/<id>.
(() => {
  const $ = (id) => document.getElementById(id);
  const VIS = { private: 'רק אני', members: 'לקהילה', public: 'ציבורי' };
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

  class AuthError extends Error {}
  async function call(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.endsWith('/login')) {
      showLogin('פג תוקף הכניסה. צריך להיכנס שוב.');
      throw new AuthError();
    }
    if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
    return data;
  }
  const send = (path, method, body) => call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const report = (id) => (err) => {
    if (!(err instanceof AuthError)) say(id, err.message, 'err');
  };

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

  // ---------- routing ----------
  function route() {
    const hash = location.hash.slice(1) || 'ideas';
    const [view, id] = hash.split('/');
    const tab = view === 'edit' || view === 'new' ? 'articles' : view;
    for (const a of document.querySelectorAll('.tabs a')) {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    $('view-ideas').hidden = view !== 'ideas';
    $('view-articles').hidden = view !== 'articles';
    $('view-edit').hidden = view !== 'edit' && view !== 'new';
    if (view === 'ideas') loadIdeas();
    else if (view === 'articles') loadArticles();
    else if (view === 'new') openEditor(null);
    else if (view === 'edit' && id) openEditor(id);
    else location.hash = '#ideas';
  }
  let current = location.hash;
  window.addEventListener('hashchange', () => {
    if (editor.dirty && !confirm('יש שינויים שלא נשמרו. לצאת בכל זאת?')) {
      history.replaceState(null, '', current);
      return;
    }
    editor.flush.cancel();
    editor.dirty = false;
    current = location.hash;
    route();
  });

  // ---------- ideas ----------
  async function loadIdeas() {
    const q = $('idea-search').value.trim();
    try {
      const { entries } = await call(`/api/studio/entries?kind=idea${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      $('ideas').replaceChildren(...entries.map(ideaCard));
      $('ideas-empty').hidden = entries.length > 0 || Boolean(q);
    } catch (err) {
      report('capture-msg')(err);
    }
  }
  $('idea-search').addEventListener('input', debounce(loadIdeas, 250));

  async function capture() {
    const body = $('capture-text').value.trim();
    if (!body) return;
    try {
      await send('/api/studio/entries', 'POST', { kind: 'idea', body, tags: $('capture-tags').value });
      $('capture-text').value = '';
      say('capture-msg', 'נשמר', 'ok');
      loadIdeas();
    } catch (err) {
      report('capture-msg')(err);
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

  function ideaCard(idea) {
    const text = h('div', { className: 'text', dir: 'auto', textContent: idea.body });
    const tags = idea.tags.length ? h('ul', { className: 'chips' }, ...idea.tags.map((t) => h('li', { textContent: t }))) : null;
    const msg = h('small', { className: 'msg' });
    const node = h('article', { className: `idea${idea.pinned ? ' pinned' : ''}` });

    const act = (label, fn, cls = '') => h('button', { className: `btn small ${cls}`, type: 'button', textContent: label, onclick: fn });
    const fail = (err) => {
      if (!(err instanceof AuthError)) {
        msg.textContent = err.message;
        msg.className = 'msg err';
      }
    };

    const edit = () => {
      const area = h('textarea', { value: idea.body, dir: 'auto' });
      const tagInput = h('input', { type: 'text', value: idea.tags.join(', '), dir: 'auto', placeholder: 'תגיות' });
      const save = act('שמירה', async () => {
        try {
          await send(`/api/studio/entries/${idea.id}`, 'PATCH', { body: area.value, tags: tagInput.value });
          loadIdeas();
        } catch (err) {
          fail(err);
        }
      }, 'primary');
      node.replaceChildren(area, tagInput, h('div', { className: 'actions' }, save, act('ביטול', loadIdeas)), msg);
      area.focus();
    };

    const toArticle = async () => {
      // Without a title, the idea's first line becomes the title and leaves the body.
      const [first, ...rest] = idea.body.split('\n');
      const change = idea.title
        ? { kind: 'article' }
        : { kind: 'article', title: first.replace(/^#+\s*/, '').slice(0, 120), body: rest.join('\n').trim() };
      try {
        await send(`/api/studio/entries/${idea.id}`, 'PATCH', change);
        location.hash = `#edit/${idea.id}`;
      } catch (err) {
        fail(err);
      }
    };

    node.append(
      ...[idea.title ? h('h3', { dir: 'auto', textContent: idea.title }) : null,
      text,
      tags,
      h('div', { className: 'meta' }, h('time', { textContent: fmt(idea.updatedAt) })),
      h(
        'div',
        { className: 'actions' },
        act(idea.pinned ? 'ביטול נעיצה' : 'נעיצה', () => send(`/api/studio/entries/${idea.id}`, 'PATCH', { pinned: !idea.pinned }).then(loadIdeas, fail)),
        act('עריכה', edit),
        act('להפוך למאמר', toArticle),
        act('מחיקה', () => confirm('למחוק את הרעיון?') && call(`/api/studio/entries/${idea.id}`, { method: 'DELETE' }).then(loadIdeas, fail), 'danger'),
      ),
      msg,
    ].filter(Boolean));
    return node;
  }

  // ---------- articles ----------
  async function loadArticles() {
    const q = $('article-search').value.trim();
    try {
      const { entries } = await call(`/api/studio/entries?kind=article${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      $('articles').replaceChildren(
        ...entries.map((a) =>
          h(
            'li',
            {},
            h('a', { className: 'title', href: `#edit/${a.id}`, dir: 'auto', textContent: a.title || 'ללא כותרת' }),
            a.status === 'published' && a.slug ? h('a', { className: 'btn small', href: `/writing/${encodeURIComponent(a.slug)}`, target: '_blank', textContent: 'צפייה' }) : h('span'),
            h(
              'div',
              { className: 'meta' },
              h('span', { className: `badge ${a.status === 'draft' ? 'draft' : 'vis-public'}`, textContent: a.status === 'draft' ? 'טיוטה' : 'פורסם' }),
              h('span', { className: `badge vis-${a.visibility}`, textContent: VIS[a.visibility] }),
              h('time', { textContent: `עודכן ${fmt(a.updatedAt)}` }),
            ),
          ),
        ),
      );
      $('articles-empty').hidden = entries.length > 0 || Boolean(q);
    } catch (err) {
      if (!(err instanceof AuthError)) $('articles').replaceChildren(h('li', { className: 'msg err', textContent: err.message }));
    }
  }
  $('article-search').addEventListener('input', debounce(loadArticles, 250));
  $('new-article').addEventListener('click', () => (location.hash = '#new'));

  // ---------- editor ----------
  const editor = { entry: null, dirty: false, saving: null };
  const fields = ['title', 'summary', 'slug', 'tags', 'visibility', 'body'];

  function status(text, kind = '') {
    $('save-status').textContent = text;
    $('save-status').style.color = kind === 'err' ? 'var(--signal)' : '';
  }

  function fill(entry) {
    $('ed-title').value = entry?.title ?? '';
    $('ed-summary').value = entry?.summary ?? '';
    $('ed-slug').value = entry?.slug ?? '';
    $('ed-tags').value = (entry?.tags ?? []).join(', ');
    $('ed-visibility').value = entry?.visibility ?? 'private';
    $('ed-body').value = entry?.body ?? '';
    reflect(entry);
  }

  function reflect(entry) {
    const published = entry?.status === 'published';
    $('publish').textContent = published ? 'החזרה לטיוטה' : 'פרסום';
    $('publish').classList.toggle('primary', !published);
    $('delete-article').hidden = !entry;
    $('view-link').hidden = !(published && entry.slug);
    if (published && entry.slug) $('view-link').href = `/writing/${encodeURIComponent(entry.slug)}`;
    if (entry) status(`${published ? 'פורסם' : 'טיוטה'} · ${VIS[entry.visibility]} · נשמר ${fmt(entry.updatedAt)}`);
    else status('טיוטה חדשה');
  }

  async function openEditor(id) {
    editor.entry = null;
    editor.dirty = false;
    fill(null);
    if (id) {
      status('טוען...');
      try {
        editor.entry = await call(`/api/studio/entries/${id}`);
        fill(editor.entry);
      } catch (err) {
        if (!(err instanceof AuthError)) status(err.message, 'err');
        return;
      }
    } else {
      $('ed-title').focus();
    }
    renderPreview();
  }

  function collect() {
    const body = {};
    for (const f of fields) body[f] = $(`ed-${f}`).value;
    return body;
  }

  // Saves are serialized; a change made during a save triggers one more.
  async function save(extra = {}) {
    if (editor.saving) {
      await editor.saving;
      if (!editor.dirty && !Object.keys(extra).length) return editor.entry;
    }
    const body = { ...collect(), ...extra };
    if (!editor.entry && !body.title.trim() && !body.body.trim()) return null;
    editor.dirty = false;
    status('שומר...');
    const run = (async () => {
      try {
        if (editor.entry) {
          editor.entry = await send(`/api/studio/entries/${editor.entry.id}`, 'PATCH', { ...body, baseUpdatedAt: editor.entry.updatedAt });
        } else {
          editor.entry = await send('/api/studio/entries', 'POST', { kind: 'article', ...body });
          history.replaceState(null, '', `#edit/${editor.entry.id}`);
          current = location.hash;
        }
        if (!$('ed-slug').matches(':focus')) $('ed-slug').value = editor.entry.slug ?? '';
        reflect(editor.entry);
        if (editor.dirty) editor.flush();
        return editor.entry;
      } catch (err) {
        editor.dirty = true;
        if (!(err instanceof AuthError)) status(err.message, 'err');
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
      const { html } = await send('/api/studio/preview', 'POST', { body: $('ed-body').value });
      $('ed-preview').innerHTML = html; // rendered and sanitized by the server
    } catch {
      // the next keystroke tries again
    }
  }, 400);

  for (const f of fields) {
    $(`ed-${f}`).addEventListener('input', () => {
      editor.dirty = true;
      status('לא נשמר');
      editor.flush();
      if (f === 'body') renderPreview();
    });
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$('view-edit').hidden) {
      e.preventDefault();
      editor.flush.cancel();
      save().catch(() => {});
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (editor.dirty) e.preventDefault();
  });

  $('publish').addEventListener('click', async () => {
    const publishing = editor.entry?.status !== 'published';
    if (publishing && $('ed-visibility').value === 'private' && !confirm('המאמר מוגדר "רק אני", אז גם אחרי פרסום רק אתה תראה אותו. להמשיך?')) return;
    editor.flush.cancel();
    try {
      await save({ status: publishing ? 'published' : 'draft' });
    } catch {
      // status line shows the error
    }
  });

  $('delete-article').addEventListener('click', async () => {
    if (!editor.entry || !confirm('למחוק את המאמר לצמיתות?')) return;
    editor.flush.cancel();
    try {
      await call(`/api/studio/entries/${editor.entry.id}`, { method: 'DELETE' });
      editor.dirty = false;
      location.hash = '#articles';
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, 'err');
    }
  });

  $('toggle-preview').addEventListener('click', () => {
    const split = $('view-edit').classList.toggle('split');
    $('ed-preview').hidden = !split;
    $('toggle-preview').textContent = split ? 'הסתרת תצוגה מקדימה' : 'תצוגה מקדימה';
    if (split) renderPreview();
  });

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
  }
  start();
})();
