// Small enhancements for the public pages: version tabs, chord transposing,
// the "ask to join" button, comments, tagging (@) and the community blog.
// Every page works without this script.
(() => {
  const send = async (url, method, body) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || String(res.status));
    return data;
  };

  // ---------- tagging members (@) ----------
  // The textarea shows "@Name"; on send each picked name becomes @{<user id>},
  // which is what the server stores. The list only offers members of the
  // community this text belongs to (the server decides who that is).
  const picked = new WeakMap();
  const namesOf = (ta) => {
    if (!picked.has(ta)) {
      let seed = {};
      try {
        seed = JSON.parse(ta.dataset.names || '{}');
      } catch {
        // no names to start with
      }
      picked.set(ta, new Map(Object.entries(seed)));
    }
    return picked.get(ta);
  };
  const encodeTags = (ta) => {
    let text = ta.value;
    // Longest names first, so "@Dana Levi" is not taken for "@Dana".
    for (const [name, id] of [...namesOf(ta)].sort((a, b) => b[0].length - a[0].length)) text = text.split(`@${name}`).join(`@{${id}}`);
    return text;
  };

  let pickers = 0;
  for (const ta of document.querySelectorAll('textarea[data-people]')) {
    const list = document.createElement('ul');
    list.className = 'mention-pick';
    list.id = `mention-pick-${++pickers}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'חברים מהקהילה');
    list.hidden = true;
    ta.after(list);
    ta.setAttribute('aria-autocomplete', 'list');
    ta.setAttribute('aria-controls', list.id);
    let at = -1;
    let items = [];
    let active = 0;
    let timer;
    let asked = 0;
    const close = () => {
      list.hidden = true;
      items = [];
      ta.removeAttribute('aria-activedescendant');
    };
    // "@" at the start or after a space, then up to 30 characters on the same line.
    const typed = () => {
      const before = ta.value.slice(0, ta.selectionStart);
      const i = before.lastIndexOf('@');
      if (i < 0 || (i > 0 && !/\s/.test(before[i - 1]))) return null;
      const q = before.slice(i + 1);
      if (q.length > 30 || /^\s|[\n@{]/.test(q)) return null;
      return { i, q };
    };
    const pick = (k) => {
      const p = items[k];
      if (!p) return;
      ta.setRangeText(`@${p.name} `, at, ta.selectionStart, 'end');
      namesOf(ta).set(p.name, p.id);
      close();
      ta.focus();
    };
    const show = () => {
      if (!items.length) return close();
      list.replaceChildren(
        ...items.map((p, k) => {
          const li = document.createElement('li');
          li.id = `${list.id}-${k}`;
          li.setAttribute('role', 'option');
          li.setAttribute('aria-selected', String(k === active));
          li.dir = 'auto';
          li.textContent = p.name;
          const small = document.createElement('small');
          small.textContent = p.username;
          li.append(small);
          li.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            pick(k);
          });
          return li;
        }),
      );
      list.hidden = false;
      ta.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    };
    ta.addEventListener('input', () => {
      const m = typed();
      clearTimeout(timer);
      if (!m) return close();
      at = m.i;
      timer = setTimeout(async () => {
        const n = ++asked;
        let found = [];
        try {
          found = (await send(`/api/people?${ta.dataset.people}&q=${encodeURIComponent(m.q)}`, 'GET')).people;
        } catch {
          // no list this time
        }
        if (n !== asked) return;
        items = found;
        active = 0;
        show();
      }, 150);
    });
    ta.addEventListener('keydown', (ev) => {
      if (list.hidden) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        show();
      } else if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        pick(active);
      } else if (ev.key === 'Escape') {
        close();
      }
    });
    ta.addEventListener('blur', () => setTimeout(close, 150));
  }

  // ---------- version tabs (song, sketch, video...) ----------
  for (const box of document.querySelectorAll('[data-versions]')) {
    const tabs = [...box.querySelectorAll('[role="tab"]')];
    const show = (tab) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
    };
    tabs.forEach((t, i) => {
      t.tabIndex = i ? -1 : 0;
      t.addEventListener('click', () => show(t));
      t.addEventListener('keydown', (ev) => {
        // Right-to-left: the right arrow goes back.
        const step = { ArrowLeft: 1, ArrowRight: -1 }[ev.key];
        if (!step) return;
        const next = tabs[(i + step + tabs.length) % tabs.length];
        next.focus();
        show(next);
      });
    });
  }

  // ---------- transposing chords ----------
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const index = (n) => {
    const i = SHARP.indexOf(n);
    return i >= 0 ? i : FLAT.indexOf(n);
  };
  const shiftNote = (note, by, flats) => {
    const n = note === 'H' ? 'B' : note;
    const i = index(n);
    if (i < 0) return note;
    return (flats ? FLAT : SHARP)[(i + by + 120) % 12];
  };
  const shift = (chord, by) =>
    chord.replace(/([A-H](?:#|b)?)/g, (m, note, off, all) => {
      // Only roots: at the start, or right after a slash.
      if (off !== 0 && all[off - 1] !== '/') return m;
      return shiftNote(note, by, note.includes('b'));
    });

  for (const tools of document.querySelectorAll('[data-transpose]')) {
    const sheet = tools.closest('.sheet');
    const chords = [...sheet.querySelectorAll('.ch')].filter((c) => c.textContent.trim());
    chords.forEach((c) => (c.dataset.chord = c.textContent));
    const out = tools.querySelector('output');
    let by = 0;
    for (const b of tools.querySelectorAll('[data-step]')) {
      b.addEventListener('click', () => {
        by = (by + Number(b.dataset.step) + 12) % 12;
        const shown = by > 6 ? by - 12 : by;
        out.textContent = shown > 0 ? `+${shown}` : String(shown);
        for (const c of chords) c.textContent = shift(c.dataset.chord, by);
      });
    }
    const plain = tools.querySelector('[data-plain]');
    plain?.addEventListener('click', () => {
      const on = plain.getAttribute('aria-pressed') !== 'true';
      plain.setAttribute('aria-pressed', String(on));
      sheet.querySelector('.chords').classList.toggle('plain', on);
    });
  }

  // ---------- asking to join a community ----------
  for (const btn of document.querySelectorAll('[data-join]')) {
    btn.addEventListener('click', async () => {
      const msg = btn.parentElement.querySelector('.msg');
      btn.disabled = true;
      try {
        const res = await fetch(`/api/member/communities/${encodeURIComponent(btn.dataset.join)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.status);
        btn.hidden = true;
        if (msg) msg.textContent = data.status === 'active' ? 'כבר בפנים. מרעננים...' : 'הבקשה נשלחה. אחרי שאאשר, הכל ייפתח כאן.';
        if (data.status === 'active') location.reload();
      } catch {
        btn.disabled = false;
        if (msg) {
          msg.textContent = 'לא הצלחתי לשלוח. נסו שוב.';
          msg.className = 'msg err';
        }
      }
    });
  }
  // ---------- comments ----------
  const box = document.querySelector('[data-comments]');
  if (box) {
    const form = box.querySelector('[data-comment-form]');
    const text = form.elements.body;
    const msg = form.querySelector('.msg');
    const target = form.querySelector('.target');
    let anchor = null;
    let quote = '';
    let replyTo = null;
    const aim = (label, a = null, q = '', r = null) => {
      anchor = a;
      quote = q;
      replyTo = r;
      target.hidden = !label;
      target.querySelector('span').textContent = label;
      if (label) {
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        text.focus({ preventScroll: true });
      }
    };
    form.querySelector('[data-clear-target]').addEventListener('click', () => aim(''));

    // A marker beside every paragraph of the text, with how many notes it has.
    const counts = {};
    for (const li of box.querySelectorAll('.comment[data-anchor]')) counts[li.dataset.anchor] = (counts[li.dataset.anchor] ?? 0) + 1;
    const prose = document.querySelector('[data-anchors]');
    if (prose) {
      [...prose.children].forEach((p, i) => {
        if (!p.textContent.trim()) return;
        p.id = `p-${i}`;
        p.classList.add('anchored');
        const words = p.textContent.trim().replace(/\s+/g, ' ');
        const q = words.length > 140 ? `${words.slice(0, 140)}…` : words;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pin';
        b.textContent = counts[i] ? String(counts[i]) : '+';
        if (counts[i]) b.classList.add('has');
        b.setAttribute('aria-label', counts[i] ? `${counts[i]} הערות על הפסקה. הוספת הערה` : 'הערה על הפסקה הזאת');
        b.addEventListener('click', () => aim(`על: ${q}`, i, q));
        p.prepend(b);
      });
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'שולח...';
      try {
        const on = box.dataset.on === 'post' ? { postId: box.dataset.comments } : { entryId: box.dataset.comments };
        const c = await send('/api/comments', 'POST', { ...on, body: encodeTags(text), anchor, quote, replyTo });
        location.hash = `c-${c.id}`;
        location.reload();
      } catch (err) {
        button.disabled = false;
        msg.className = 'msg err';
        msg.textContent = /Sign in/.test(err.message) ? 'צריך להתחבר שוב.' : /lot of comments/.test(err.message) ? 'הרבה תגובות בשעה האחרונה. נסו קצת אחר כך.' : 'לא הצלחתי לשלוח. נסו שוב.';
      }
    });

    box.addEventListener('click', async (ev) => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.reply) {
        const author = t.closest('.comment').querySelector('.meta b').textContent;
        aim(`תשובה ל${author}`, null, '', t.dataset.reply);
      } else if (t.dataset.deleteComment) {
        if (!confirm('למחוק את התגובה?')) return;
        await send(`/api/comments/${t.dataset.deleteComment}`, 'DELETE').then(() => t.closest('.comment').remove(), () => alert('לא הצלחתי למחוק.'));
      } else if (t.dataset.resolve) {
        await send(`/api/studio/comments/${t.dataset.resolve}`, 'PATCH', { status: t.dataset.to }).then(() => location.reload(), () => alert('לא הצלחתי לעדכן.'));
      }
    });
  }

  // ---------- community blog ----------
  for (const form of document.querySelectorAll('[data-post-form]')) {
    const msg = form.querySelector('.msg');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'שולח...';
      const body = { title: form.elements.title.value, body: encodeTags(form.elements.body) };
      try {
        const res = form.dataset.post
          ? await send(`/api/blog/posts/${form.dataset.post}`, 'PATCH', body)
          : await send(`/api/blog/${form.dataset.space}/posts`, 'POST', body);
        location.assign(res.path);
      } catch (err) {
        button.disabled = false;
        msg.className = 'msg err';
        msg.textContent = /Sign in/.test(err.message)
          ? 'צריך להתחבר שוב.'
          : /lot of posts/.test(err.message)
            ? 'הרבה פוסטים בשעה האחרונה. נסו קצת אחר כך.'
            : /title/.test(err.message)
              ? 'חסרה כותרת.'
              : 'לא הצלחתי לשמור. נסו שוב.';
      }
    });
  }

  const post = document.querySelector('[data-post-id]');
  post?.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (b && 'postEdit' in b.dataset) {
      const box = post.querySelector('.post-edit');
      box.hidden = !box.hidden;
      b.setAttribute('aria-expanded', String(!box.hidden));
      if (!box.hidden) box.querySelector('textarea').focus();
      return;
    }
    if (!b || !(b.dataset.postMod || 'postDelete' in b.dataset)) return;
    const id = post.dataset.postId;
    const msg = post.querySelector('.post-tools .msg');
    try {
      if (b.dataset.postMod) {
        await send(`/api/studio/posts/${id}`, 'PATCH', { [b.dataset.postMod]: b.dataset.to === 'true' });
        location.reload();
      } else if (confirm('למחוק את הפוסט, עם כל התגובות עליו?')) {
        await send(`/api/blog/posts/${id}`, 'DELETE');
        location.assign(b.dataset.back);
      }
    } catch {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = 'לא הצלחתי. נסו שוב.';
      }
    }
  });
  // ---------- Drive recordings ----------
  // A Drive file plays in the site's own player (/media/drive). When Drive
  // will not hand it over, show Drive's own frame in its place.
  document.addEventListener(
    'error',
    (ev) => {
      const el = ev.target;
      const box = el instanceof HTMLMediaElement && el.closest('[data-drive]');
      if (!box || !/^[\w-]+$/.test(box.dataset.drive)) return;
      const f = document.createElement('iframe');
      f.src = `https://drive.google.com/file/d/${box.dataset.drive}/preview`;
      f.title = el.title || 'נגן';
      f.allow = 'autoplay; fullscreen';
      f.allowFullscreen = true;
      box.classList.add('framed');
      el.replaceWith(f);
    },
    true,
  );
})();
