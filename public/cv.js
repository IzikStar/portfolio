// The CV page arrives fully rendered (src/cv-page.js). This adds what needs a
// browser: the language preference, print, copying the address, the audio
// player and the current section in the top bar.
(() => {
  const he = document.documentElement.lang === 'he';
  const T = he ? { play: 'נגן', pause: 'השהה' } : { play: 'Play', pause: 'Pause' };

  // The toggle is a plain link (?lang=en); remember the choice for next time.
  document.querySelectorAll('[data-lang]').forEach((a) =>
    a.addEventListener('click', () => {
      document.cookie = `cv_lang=${a.dataset.lang}; Path=/cv; Max-Age=31536000; SameSite=Lax`;
    }),
  );

  const print = document.querySelector('[data-print]');
  if (print && typeof window.print === 'function') {
    print.hidden = false;
    print.addEventListener('click', () => window.print());
  }

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.hidden = false;
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = btn.dataset.copied;
        setTimeout(() => (btn.textContent = label), 1800);
      } catch {
        const email = btn.parentElement.querySelector('.email');
        if (!email) return;
        const range = document.createRange();
        range.selectNodeContents(email);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    });
  });

  // ---------- one audio player for every play button ----------
  const player = document.getElementById('player');
  const buttons = [...document.querySelectorAll('[data-play]')];
  let current = null;
  const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';
  const fmt = (s) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
  const titleOf = (b) => b.getAttribute('aria-label').replace(/^[^:]*:\s*/, '');

  function sync() {
    for (const b of buttons) {
      const on = b === current && !player.paused;
      b.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
      b.setAttribute('aria-label', `${on ? T.pause : T.play}: ${titleOf(b)}`);
      b.closest('.row, .card')?.classList.toggle('active', b === current);
    }
    const id = current?.dataset.play;
    document.querySelectorAll('[data-seek]').forEach((s) => s.classList.toggle('on', s.dataset.seek === id));
  }

  function toggle(b) {
    if (b === current) {
      player.paused ? player.play().catch(() => {}) : player.pause();
      return;
    }
    if (current) {
      const t = document.querySelector(`[data-time="${current.dataset.play}"]`);
      if (t) t.textContent = '';
    }
    current = b;
    player.src = b.dataset.src;
    player.play().catch(() => {});
    sync();
  }

  buttons.forEach((b) => b.addEventListener('click', () => toggle(b)));
  document.querySelectorAll('[data-seek]').forEach((seek) =>
    seek.addEventListener('click', (e) => {
      if (current?.dataset.play !== seek.dataset.seek || !player.duration) return;
      const r = seek.getBoundingClientRect();
      let x = (e.clientX - r.left) / r.width;
      if (getComputedStyle(seek).direction === 'rtl') x = 1 - x;
      player.currentTime = x * player.duration;
    }),
  );
  ['play', 'pause'].forEach((ev) => player.addEventListener(ev, sync));
  player.addEventListener('timeupdate', () => {
    if (!player.duration || !current) return;
    const id = current.dataset.play;
    const bar = document.querySelector(`[data-seek="${id}"] i`);
    if (bar) bar.style.width = `${(player.currentTime / player.duration) * 100}%`;
    const time = document.querySelector(`[data-time="${id}"]`);
    if (time) time.textContent = `${fmt(player.currentTime) || '0:00'} / ${fmt(player.duration)}`;
  });
  player.addEventListener('ended', () => {
    const next = buttons[buttons.indexOf(current) + 1];
    if (next) toggle(next);
    else sync();
  });
  // One sound at a time: a video pauses the music and the other way around.
  document.addEventListener(
    'play',
    (e) => {
      if (e.target instanceof HTMLVideoElement) player.pause();
      else if (e.target === player) document.querySelectorAll('video').forEach((v) => v.pause());
    },
    true,
  );

  // ---------- the section in view, marked in the top bar ----------
  const links = new Map([...document.querySelectorAll('.bar nav a')].map((a) => [a.getAttribute('href').slice(1), a]));
  if ('IntersectionObserver' in window && links.size) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          links.forEach((a, id) => (id === en.target.id ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
        }
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    document.querySelectorAll('section.block[id]').forEach((s) => io.observe(s));
  }
})();
