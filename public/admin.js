// Admin page for the music section. Talks to /api/admin/* with a session cookie.
(() => {
  const $ = (id) => document.getElementById(id);
  let tracks = [];

  function say(id, text, kind = '') {
    const n = $(id);
    n.textContent = text;
    n.className = `msg ${kind}`;
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
      await call('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('password').value }),
      });
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

  // Read the duration in the browser so the public page can show it without decoding.
  function audioDuration(file) {
    return new Promise((resolve) => {
      const a = document.createElement('audio');
      const url = URL.createObjectURL(file);
      const done = (v) => {
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

  $('audio').addEventListener('change', () => {
    const f = $('audio').files[0];
    if (f && !$('title').value) $('title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    if (f && f.size > 25 * 1024 * 1024) say('upload-msg', `הקובץ שוקל ${(f.size / 1048576).toFixed(1)}MB. המקסימום הוא 25MB, אפשר לייצא אותו כ־MP3.`, 'err');
    else say('upload-msg', '');
  });

  $('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const audio = $('audio').files[0];
    if (!audio) return say('upload-msg', 'צריך לבחור קובץ שמע.', 'err');
    const form = new FormData();
    form.set('title', $('title').value);
    form.set('note', $('note').value);
    form.set('audio', audio);
    if ($('cover').files[0]) form.set('cover', $('cover').files[0]);
    form.set('hidden', String($('hidden-upload').checked));
    form.set('duration', String(await audioDuration(audio)));

    $('upload-btn').disabled = true;
    $('progress').hidden = false;
    $('progress').value = 0;
    say('upload-msg', 'מעלה...');
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/admin/tracks');
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
      $('upload-form').reset();
      say('upload-msg', 'השיר עלה. ייתכן שיעברו עד דקה עד שיופיע באתר.', 'ok');
      await refresh();
    } catch (err) {
      say('upload-msg', err.message, 'err');
    } finally {
      $('upload-btn').disabled = false;
      $('progress').hidden = true;
    }
  });

  async function refresh() {
    try {
      tracks = await call('/api/admin/tracks');
      render();
    } catch (err) {
      if (err.message !== 'auth') say('list-msg', err.message, 'err');
    }
  }

  const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
  const fmt = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

  function btn(text, onClick, cls = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    say('list-msg', tracks.length ? '' : 'עוד לא הועלו שירים.');
    $('list').replaceChildren(
      ...tracks.map((tr, i) => {
        const li = document.createElement('li');
        li.className = `item${tr.hidden ? ' is-hidden' : ''}`;

        const top = document.createElement('div');
        top.className = 'top';
        const title = document.createElement('strong');
        title.textContent = tr.title;
        title.dir = 'auto';
        top.append(title);
        if (tr.hidden) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'מוסתר';
          top.append(badge);
        }
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = [fmt(tr.duration), tr.size ? mb(tr.size) : ''].filter(Boolean).join(' · ');
        top.append(meta);

        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = `/api/audio/${tr.id}`;

        const actions = document.createElement('div');
        actions.className = 'actions';
        const up = btn('למעלה', () => move(i, -1));
        up.disabled = i === 0;
        const down = btn('למטה', () => move(i, 1));
        down.disabled = i === tracks.length - 1;
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
          await act(() => call(`/api/admin/tracks/${tr.id}`, { method: 'DELETE' }));
        }, 'danger');
        actions.append(
          up,
          down,
          btn('עריכה', () => edit(li, tr)),
          btn(tr.hidden ? 'להציג באתר' : 'להסתיר', () => patch(tr.id, { hidden: !tr.hidden })),
          del,
        );

        if (tr.note) {
          const note = document.createElement('p');
          note.textContent = tr.note;
          note.dir = 'auto';
          note.style.color = 'var(--muted)';
          li.append(top, note, audio, actions);
        } else li.append(top, audio, actions);
        return li;
      }),
    );
  }

  function edit(li, tr) {
    const form = document.createElement('form');
    form.className = 'item';
    form.style.border = '0';
    form.style.padding = '0';
    const t = Object.assign(document.createElement('input'), { type: 'text', value: tr.title, maxLength: 120, required: true });
    t.setAttribute('aria-label', 'שם השיר');
    const n = Object.assign(document.createElement('textarea'), { value: tr.note || '', maxLength: 280 });
    n.setAttribute('aria-label', 'שורת תיאור');
    const row = document.createElement('div');
    row.className = 'row';
    const save = btn('שמירה', () => form.requestSubmit(), 'primary');
    row.append(save, btn('ביטול', render));
    form.append(t, n, row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      patch(tr.id, { title: t.value, note: n.value });
    });
    li.replaceChildren(form);
    t.focus();
  }

  async function act(fn) {
    try {
      await fn();
      await refresh();
    } catch (err) {
      if (err.message !== 'auth') say('list-msg', err.message, 'err');
    }
  }

  const patch = (id, body) =>
    act(() => call(`/api/admin/tracks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

  function move(i, d) {
    const ids = tracks.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    act(() => call('/api/admin/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }));
  }

  fetch('/api/admin/session', { credentials: 'same-origin' })
    .then((r) => (r.ok ? showPanel() : showLogin()))
    .catch(() => showLogin());
})();
