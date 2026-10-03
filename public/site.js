// Small enhancements for the public pages: version tabs, chord transposing,
// and the "ask to join" button. Every page works without this script.
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
})();
