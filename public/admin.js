// Admin page: which sections show, and the items in the creative sections.
(() => {
  const $ = (id) => document.getElementById(id);
  const NAMES = {
    code: 'פרויקטי קוד',
    music: 'מוזיקה',
    voice: 'דיבוב',
    sketches: 'מערכונים',
    writing: 'כתיבה',
    about: 'עליי',
    contact: 'יצירת קשר',
  };
  const ORDER = Object.keys(NAMES);
  const MEDIA = ['music', 'voice', 'sketches', 'writing'];
  const KIND = { audio: 'שמע', video: 'וידאו', pdf: 'PDF', image: 'תמונה', link: 'קישור' };

  let site = { sections: {}, intros: {}, items: [] };
  let filter = 'all';

  function say(id, text, kind = '') {
    const n = $(id);
    n.textContent = text;
    n.className = `msg ${kind}`;
  }

  function h(tag, props = {}, ...kids) {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }

  async function call(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.endsWith('/login')) {
      showLogin('פג תוקף הכניסה. צריך להיכנס שוב.');
      throw new Error('auth');
    }
    if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
    return data;
  }
  const sendJson = (path, method, body) =>
    call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ---------- login ----------
  function showLogin(message = '') {
    $('login-form').hidden = false;
    $('panel').hidden = true;
    $('logout').hidden = true;
    say('login-msg', message, message ? 'err' : '');
    $('password').focus();
  }

  async function showPanel() {
    $('login-form').hidden = true;
    $('panel').hidden = false;
    $('logout').hidden = false;
    await refresh();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('login-msg', 'בודק...');
    try {
      await sendJson('/api/admin/login', 'POST', { password: $('password').value });
      $('password').value = '';
      await showPanel();
    } catch (err) {
      say('login-msg', err.message === 'Wrong password.' ? 'סיסמה שגויה.' : err.message, 'err');
    }
  });

  $('logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  async function refresh() {
    try {
      site = await call('/api/admin/site');
      renderSwitches();
      renderList();
    } catch (err) {
      if (err.message !== 'auth') say('list-msg', err.message, 'err');
    }
  }

  // ---------- sections ----------
  function renderSwitches() {
    $('switches').replaceChildren(
      ...ORDER.map((s) => {
        const on = site.sections[s] !== false;
        const count = site.items.filter((i) => i.section === s && !i.hidden).length;
        const input = h('input', { type: 'checkbox', checked: on, id: `sw-${s}` });
        input.dataset.section = s;
        const state = h('span', { className: 'state' });
        const setState = () => {
          state.textContent = !input.checked ? 'כבוי' : MEDIA.includes(s) && count === 0 ? 'דלוק, אבל ריק ולכן מוסתר' : MEDIA.includes(s) ? `מוצג (${count})` : 'מוצג';
        };
        input.addEventListener('change', setState);
        setState();
        const li = h(
          'li',
          { className: 'switch' },
          h('div', { className: 'top' }, h('label', { className: 'toggle', htmlFor: `sw-${s}`, title: NAMES[s] }, input, h('span')), h('label', { className: 'name', htmlFor: `sw-${s}`, textContent: NAMES[s] }), state),
        );
        if (MEDIA.includes(s)) {
          const intro = h('textarea', { id: `intro-${s}`, maxLength: 600, value: site.intros[s] || '', placeholder: 'משפט פתיחה לחלק הזה (לא חובה)' });
          intro.dataset.intro = s;
          intro.setAttribute('aria-label', `משפט פתיחה: ${NAMES[s]}`);
          li.append(intro);
        }
        return li;
      }),
    );
  }

  $('sections-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sections = {};
    document.querySelectorAll('#switches input[data-section]').forEach((i) => (sections[i.dataset.section] = i.checked));
    const intros = {};
    document.querySelectorAll('#switches textarea[data-intro]').forEach((t) => (intros[t.dataset.intro] = t.value));
    $('save-sections').disabled = true;
    try {
      await sendJson('/api/admin/settings', 'PUT', { sections, intros });
      say('sections-msg', 'נשמר. האתר יתעדכן תוך דקה.', 'ok');
      await refresh();
    } catch (err) {
      if (err.message !== 'auth') say('sections-msg', err.message, 'err');
    } finally {
      $('save-sections').disabled = false;
    }
  });

  // ---------- upload ----------
  // Read the duration in the browser so the public page can show it without decoding.
  function mediaDuration(file) {
    if (!/^(audio|video)\//.test(file.type)) return Promise.resolve('');
    return new Promise((resolve) => {
      const a = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(v);
      };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : '');
      a.onerror = () => done('');
      setTimeout(() => done(''), 5000);
      a.src = url;
    });
  }

  $('file').addEventListener('change', () => {
    const f = $('file').files[0];
    if (f && !$('title').value) $('title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    if (f && f.size > 25 * 1024 * 1024) say('upload-msg', `הקובץ שוקל ${(f.size / 1048576).toFixed(1)}MB והמקסימום הוא 25MB. אפשר לכווץ אותו, או להעלות ל־YouTube או Drive ולהדביק קישור.`, 'err');
    else say('upload-msg', '');
  });

  $('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('file').files[0];
    const link = $('link').value.trim();
    if (!file && !link) return say('upload-msg', 'צריך קובץ או קישור.', 'err');
    const form = new FormData();
    form.set('section', $('section').value);
    form.set('title', $('title').value);
    form.set('note', $('note').value);
    form.set('link', link);
    if (file) form.set('file', file);
    if ($('cover').files[0]) form.set('cover', $('cover').files[0]);
    form.set('hidden', String($('hidden-upload').checked));
    if (file) form.set('duration', String(await mediaDuration(file)));

    $('upload-btn').disabled = true;
    $('progress').hidden = !file;
    $('progress').value = 0;
    say('upload-msg', file ? 'מעלה...' : 'שומר...');
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/admin/items');
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) $('progress').value = (ev.loaded / ev.total) * 100;
        };
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
          if (xhr.status === 401) return reject(new Error('פג תוקף הכניסה. צריך להיכנס שוב.'));
          xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `שגיאה ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('החיבור נפל באמצע. נסה שוב.'));
        xhr.send(form);
      });
      const section = $('section').value;
      $('upload-form').reset();
      $('section').value = section;
      say('upload-msg', 'נוסף. ייתכן שיעבור עד דקה עד שיופיע באתר.', 'ok');
      filter = section;
      await refresh();
    } catch (err) {
      say('upload-msg', err.message, 'err');
    } finally {
      $('upload-btn').disabled = false;
      $('progress').hidden = true;
    }
  });

  // ---------- list ----------
  const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
  const fmt = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

  function btn(text, onClick, cls = '') {
    return h('button', { type: 'button', className: `btn ${cls}`, textContent: text, onclick: onClick });
  }

  function renderTabs() {
    const tabs = [['all', 'הכל'], ...MEDIA.map((s) => [s, NAMES[s]])];
    $('tabs').replaceChildren(
      ...tabs.map(([key, label]) => {
        const n = site.items.filter((i) => key === 'all' || i.section === key).length;
        const b = btn(`${label} (${n})`, () => {
          filter = key;
          renderList();
        });
        b.setAttribute('aria-pressed', String(filter === key));
        return b;
      }),
    );
  }

  function preview(item) {
    const src = `/api/file/${item.id}`;
    if (item.kind === 'audio') return h('audio', { controls: true, preload: 'none', src });
    if (item.kind === 'video') return h('video', { controls: true, preload: 'none', src });
    if (item.kind === 'image') return h('img', { src, alt: '', style: 'max-height:160px;width:auto;border-radius:4px' });
    if (item.kind === 'pdf') return h('a', { href: src, target: '_blank', rel: 'noopener', textContent: 'פתיחת ה־PDF ↗' });
    return null;
  }

  function renderList() {
    renderTabs();
    const items = site.items.filter((i) => filter === 'all' || i.section === filter);
    say('list-msg', items.length ? '' : 'אין כאן פריטים עדיין.');
    $('list').replaceChildren(
      ...items.map((item) => {
        const siblings = site.items.filter((i) => i.section === item.section);
        const pos = siblings.indexOf(item);
        const li = h('li', { className: `item${item.hidden ? ' is-hidden' : ''}` });
        const top = h(
          'div',
          { className: 'top' },
          h('strong', { textContent: item.title, dir: 'auto' }),
          h('span', { className: 'badge', textContent: NAMES[item.section] }),
          h('span', { className: 'badge', textContent: KIND[item.kind] ?? item.kind }),
          item.hidden ? h('span', { className: 'badge', textContent: 'מוסתר' }) : null,
          h('span', { className: 'meta', textContent: [fmt(item.duration), item.size ? mb(item.size) : ''].filter(Boolean).join(' · ') }),
        );
        li.append(top);
        if (item.note) li.append(h('p', { className: 'note', textContent: item.note, dir: 'auto' }));
        const p = preview(item);
        if (p) li.append(p);
        if (item.link) li.append(h('a', { className: 'link', href: item.link, target: '_blank', rel: 'noopener', textContent: item.link }));

        const up = btn('למעלה', () => move(item, -1));
        up.disabled = pos === 0;
        const down = btn('למטה', () => move(item, 1));
        down.disabled = pos === siblings.length - 1;
        const del = btn('מחיקה', async () => {
          if (!del.classList.contains('confirm')) {
            del.classList.add('confirm');
            del.textContent = 'למחוק לצמיתות?';
            setTimeout(() => {
              del.classList.remove('confirm');
              del.textContent = 'מחיקה';
            }, 4000);
            return;
          }
          await act(() => call(`/api/admin/items/${item.id}`, { method: 'DELETE' }));
        }, 'danger');
        li.append(
          h('div', { className: 'actions' }, up, down, btn('עריכה', () => edit(li, item)), btn(item.hidden ? 'להציג באתר' : 'להסתיר', () => patch(item.id, { hidden: !item.hidden })), del),
        );
        return li;
      }),
    );
  }

  function edit(li, item) {
    const title = h('input', { type: 'text', value: item.title, maxLength: 120, required: true });
    title.setAttribute('aria-label', 'כותרת');
    const note = h('textarea', { value: item.note || '', maxLength: 600 });
    note.setAttribute('aria-label', 'תיאור');
    const link = h('input', { type: 'url', value: item.link || '', placeholder: 'https://', maxLength: 500 });
    link.setAttribute('aria-label', 'קישור');
    const section = h('select', {}, ...MEDIA.map((s) => h('option', { value: s, textContent: NAMES[s], selected: s === item.section })));
    section.setAttribute('aria-label', 'חלק');
    const form = h('form', { className: 'item', style: 'border:0;padding:0' }, title, note, link, section, h('div', { className: 'row2' }, h('button', { type: 'submit', className: 'btn primary', textContent: 'שמירה' }), btn('ביטול', renderList)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      patch(item.id, { title: title.value, note: note.value, link: link.value, section: section.value });
    });
    li.replaceChildren(form);
    title.focus();
  }

  async function act(fn) {
    try {
      await fn();
      await refresh();
    } catch (err) {
      if (err.message !== 'auth') say('list-msg', err.message, 'err');
    }
  }

  const patch = (id, body) => act(() => sendJson(`/api/admin/items/${id}`, 'PATCH', body));

  function move(item, d) {
    const ids = site.items.filter((i) => i.section === item.section).map((i) => i.id);
    const i = ids.indexOf(item.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    act(() => sendJson('/api/admin/order', 'PUT', { ids }));
  }

  fetch('/api/admin/session', { credentials: 'same-origin' })
    .then((r) => (r.ok ? showPanel() : showLogin()))
    .catch(() => showLogin());
})();
