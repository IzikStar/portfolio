// Small enhancements for the public pages: version tabs, chord transposing,
// the "ask to join" button and comments. Every page works without this script.
(() => {
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
        const res = await fetch(`/api/member/spaces/${encodeURIComponent(btn.dataset.join)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.status);
        btn.hidden = true;
        if (msg) msg.textContent = data.status === 'active' ? 'כבר בפנים. מרעננים...' : 'הבקשה נשלחה. אחרי האישור הכל ייפתח כאן.';
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

    const send = async (url, method, body) => {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || String(res.status));
      return data;
    };

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'שולח...';
      try {
        const c = await send('/api/comments', 'POST', { entryId: box.dataset.comments, body: text.value, anchor, quote, replyTo });
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
})();
