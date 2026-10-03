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
    const tab = view === 'edit' || view === 'new' ? 'articles' : view === 'project' || view === 'project-new' ? 'projects' : view;
    for (const a of document.querySelectorAll('.tabs a')) {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    $('view-ideas').hidden = view !== 'ideas';
    $('view-articles').hidden = view !== 'articles';
    $('view-community').hidden = view !== 'community';
    $('view-projects').hidden = view !== 'projects';
    $('view-project').hidden = view !== 'project' && view !== 'project-new';
    $('view-edit').hidden = view !== 'edit' && view !== 'new';
    if (view === 'ideas') loadIdeas();
    else if (view === 'articles') loadArticles();
    else if (view === 'community') loadCommunity();
    else if (view === 'projects') loadProjects();
    else if (view === 'project-new') openProject(null);
    else if (view === 'project' && id) openProject(id);
    else if (view === 'new') openEditor(null);
    else if (view === 'edit' && id) openEditor(id);
    else location.hash = '#ideas';
  }
  let current = location.hash;
  window.addEventListener('hashchange', () => {
    if ((editor.dirty || project.dirty) && !confirm('יש שינויים שלא נשמרו. לצאת בכל זאת?')) {
      history.replaceState(null, '', current);
      return;
    }
    editor.flush.cancel();
    editor.dirty = false;
    project.dirty = false;
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
  window.addEventListener('beforeunload', (e) => {
    if (editor.dirty || project.dirty) e.preventDefault();
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

  // ---------- files ----------
  async function upload(entryId, file) {
    const form = new FormData();
    form.set('entryId', entryId);
    form.set('file', file);
    return call('/api/studio/files', { method: 'POST', body: form });
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
      const f = await upload(editor.entry.id, file);
      const alt = f.name.replace(/[\[\]]/g, '');
      const snippet = f.kind === 'image' ? `![${alt}](${f.url})` : `[${alt}](${f.url})`;
      const ta = $('ed-body');
      ta.setRangeText(`${snippet}\n`, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, 'err');
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
      $('import-cv').hidden = all.some((p) => p.source === 'import');
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
      h('a', { className: 'title', href: `#project/${p.id}`, dir: 'auto', textContent: p.title || s.name || 'ללא שם' }),
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
  $('import-cv').addEventListener('click', async () => {
    try {
      const { created } = await send('/api/studio/import-cv', 'POST');
      say('projects-msg', `יובאו ${created} פרויקטים`, 'ok');
      loadProjects();
    } catch (err) {
      report('projects-msg')(err);
    }
  });
  $('sync-all').addEventListener('click', async () => {
    say('projects-msg', 'מרענן...');
    const [a, b] = await Promise.all([call('/api/studio/entries?kind=project'), call('/api/studio/entries?kind=work')]).catch(() => [{ entries: [] }, { entries: [] }]);
    const withSource = [...a.entries, ...b.entries].filter((p) => p.meta?.source);
    let ok = 0;
    for (const p of withSource) {
      await send(`/api/studio/entries/${p.id}/sync`, 'POST').then(() => ok++, () => {});
    }
    say('projects-msg', `רוענו ${ok} מתוך ${withSource.length}`, ok === withSource.length ? 'ok' : 'err');
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
    if (!project.entry || !confirm('למחוק את הפרויקט?')) return;
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
      const { users, invites } = await call('/api/studio/community');
      const pending = users.filter((u) => u.status === 'pending');
      const members = users.filter((u) => u.status !== 'pending');
      showPendingCount(pending.length);
      $('pending').replaceChildren(...pending.map((u) => person(u, [['אישור', () => setStatus(u, 'active'), 'primary'], ['דחייה', () => remove(u, 'לדחות את הבקשה?'), 'danger']])));
      $('pending-empty').hidden = pending.length > 0;
      $('members').replaceChildren(
        ...members.map((u) =>
          person(u, [
            u.status === 'active' ? ['השעיה', () => setStatus(u, 'suspended')] : ['החזרה', () => setStatus(u, 'active'), 'primary'],
            ['הסרה', () => remove(u, `להסיר את ${u.displayName} מהקהילה?`), 'danger'],
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
      h('span', { className: 'who', dir: 'auto', textContent: u.displayName }),
      h('span', { className: 'meta', dir: 'auto' }, h('span', { textContent: `@${u.username}` }), h('span', { className: 'badge', textContent: STATUS[u.status] ?? u.status }), h('time', { textContent: fmt(u.createdAt) }), u.viaInvite ? h('span', { textContent: 'דרך הזמנה' }) : null),
      h('span', { className: 'actions' }, ...actions.map(([label, fn, cls = '']) => h('button', { className: `btn small ${cls}`, type: 'button', textContent: label, onclick: fn }))),
      u.note ? h('span', { className: 'note', dir: 'auto', textContent: u.note }) : null,
    );
  }

  const setStatus = (u, status) => send(`/api/studio/members/${u.id}`, 'PATCH', { status }).then(loadCommunity, report('invite-msg'));
  const remove = (u, question) => confirm(question) && call(`/api/studio/members/${u.id}`, { method: 'DELETE' }).then(loadCommunity, report('invite-msg'));

  function inviteRow(inv) {
    const link = `${location.origin}/join?code=${inv.code}`;
    const expired = inv.expiresAt && inv.expiresAt < new Date().toISOString();
    const used = inv.uses >= inv.maxUses;
    const state = expired ? 'פג תוקף' : used ? 'נוצל' : `${inv.uses}/${inv.maxUses} נוצלו${inv.expiresAt ? ` · עד ${fmt(inv.expiresAt)}` : ''}`;
    return h(
      'li',
      {},
      h('span', { className: 'who', dir: 'auto', textContent: inv.note || 'הזמנה' }),
      h('span', { className: 'meta' }, h('span', { textContent: state })),
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
      const inv = await send('/api/studio/invites', 'POST', { note: $('inv-note').value, maxUses: $('inv-uses').value, days: $('inv-days').value });
      $('inv-note').value = '';
      await navigator.clipboard.writeText(`${location.origin}/join?code=${inv.code}`).then(
        () => say('invite-msg', 'הקישור נוצר והועתק', 'ok'),
        () => say('invite-msg', 'הקישור נוצר', 'ok'),
      );
      loadCommunity();
    } catch (err) {
      report('invite-msg')(err);
    }
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
    call('/api/studio/community').then(({ users }) => showPendingCount(users.filter((u) => u.status === 'pending').length), () => {});
  }
  start();
})();
