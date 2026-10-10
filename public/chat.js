// The community chat page (src/chat.js): messages arrive live over a
// WebSocket; when that is not possible the page asks for changes every few
// seconds instead. Each message has a small menu: reply, pin, edit, delete,
// and "make it a post" (on the blog it can be read alone and commented on).
// A message can be for some members only ("למי?" next to the box), and the
// owner decides who writes and who only reads (the participants list).
(() => {
  const root = document.querySelector('[data-chat]');
  const dataEl = document.getElementById('chat-data');
  if (!root || !dataEl) return;
  const start = JSON.parse(dataEl.textContent);
  const { room, me, owner } = start;
  let canWrite = start.canWrite;
  let roster = start.members ?? []; // [{ id, name, role }], the owner first
  const $ = (sel) => root.querySelector(sel);
  const log = $('[data-log]');
  const scroller = $('[data-scroll]');
  const pinsEl = $('[data-pins]');
  const statusEl = $('[data-status]');
  const form = $('[data-compose]');
  const ta = form.querySelector('textarea');
  const msgEl = $('[data-msg]');
  const replyingEl = $('[data-replying]');
  const moreWrap = $('[data-more-wrap]');
  const emptyEl = $('[data-empty]');

  const messages = new Map(); // id -> message
  let pinned = [];
  let since = start.now;
  let replyTo = null;
  let oldest = null;

  const send = async (url, method, body) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || String(res.status)), { status: res.status });
    return data;
  };

  const isMine = (m) => (me === 'owner' ? m.userId === null : m.userId === me);
  const timeFmt = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  const dayFmt = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });
  const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
  const dayLabel = (iso) => {
    const k = dayKey(iso);
    if (k === dayKey(new Date().toISOString())) return 'היום';
    if (k === dayKey(new Date(Date.now() - 86400_000).toISOString())) return 'אתמול';
    return dayFmt.format(new Date(iso));
  };
  // One color per writer, so a busy chat is easy to follow.
  const hue = (s) => {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  };

  // Text with its links clickable; nothing else is HTML.
  const fill = (el, text) => {
    const parts = String(text).split(/(https?:\/\/[^\s<>"]+)/g);
    for (const [i, part] of parts.entries()) {
      if (i % 2) {
        const a = document.createElement('a');
        a.href = part;
        a.textContent = part;
        a.rel = 'noopener nofollow';
        a.target = '_blank';
        el.append(a);
      } else if (part) el.append(part);
    }
  };
  // Hebrew anywhere in it: right to left, even when it opens with a link.
  const dirOf = (t) => (/[\u0590-\u05FF]/.test(t ?? '') ? 'rtl' : 'auto');
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  };

  const nameOf = (id) => roster.find((p) => p.id === id)?.name ?? 'מישהו';
  const forWhom = (ids) => ids.map(nameOf).join(', ');

  // ---------- drawing ----------

  function bubble(m) {
    const li = el('li', `chat-msg${isMine(m) ? ' mine' : ''}${m.deleted ? ' deleted' : ''}${m.pinned ? ' is-pinned' : ''}`);
    li.id = `m-${m.id}`;
    li.dataset.id = m.id;
    li.style.setProperty('--who', hue(m.userId ?? 'owner'));
    const b = el('div', 'bubble');
    if (!isMine(m)) b.append(el('span', 'who', m.author));
    if (m.audience?.length && !m.deleted) b.append(el('span', 'for', `🔒 רק ל${forWhom(m.audience)}`));
    if (m.reply && !m.deleted) {
      const q = el('a', 'quote');
      q.href = `#m-${m.replyTo}`;
      q.append(el('b', '', m.reply.author));
      q.append(el('span', '', m.reply.deleted ? 'ההודעה נמחקה' : m.reply.text));
      q.dir = 'auto';
      b.append(q);
    }
    const text = el('p', 'text');
    text.dir = dirOf(m.body);
    if (m.deleted) text.textContent = 'ההודעה נמחקה';
    else fill(text, m.body);
    b.append(text);
    if (m.post && !m.deleted) {
      const p = el('a', 'chat-post');
      p.href = m.post.path;
      const n = m.post.comments;
      p.textContent = `${m.post.public ? 'פוסט פתוח לכולם' : 'פוסט בבלוג'} · ${n ? (n === 1 ? 'תגובה אחת' : `${n} תגובות`) : 'להגיב'}`;
      b.append(p);
    }
    const meta = el('span', 'meta');
    if (m.pinned) meta.append(el('span', 'pin-mark', 'נעוץ'));
    if (m.editedAt && !m.deleted) meta.append(el('span', '', 'נערך'));
    const t = el('time', '', timeFmt.format(new Date(m.createdAt)));
    t.dateTime = m.createdAt;
    meta.append(t);
    b.append(meta);
    li.append(b);
    if (!m.deleted) {
      const btn = el('button', 'chat-menu-btn', '⋯');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'אפשרויות להודעה');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.dataset.menu = m.id;
      li.append(btn);
    }
    return li;
  }

  function daySep(iso) {
    const li = el('li', 'chat-day');
    li.dataset.day = dayKey(iso);
    li.append(el('span', '', dayLabel(iso)));
    return li;
  }

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  // Redraw everything in order (cheap enough for a few hundred messages).
  function draw({ keepBottom = nearBottom(), anchor = null } = {}) {
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    const list = [...messages.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    const frag = document.createDocumentFragment();
    let day = null;
    for (const m of list) {
      const k = dayKey(m.createdAt);
      if (k !== day) {
        frag.append(daySep(m.createdAt));
        day = k;
      }
      frag.append(bubble(m));
    }
    log.replaceChildren(frag);
    emptyEl.hidden = list.length > 0;
    oldest = list[0]?.createdAt ?? null;
    if (anchor) {
      const again = document.getElementById(anchor.id);
      if (again) scroller.scrollTop += again.getBoundingClientRect().top - before;
    } else if (keepBottom) toBottom();
    drawPins();
  }

  function drawPins() {
    pinned = [...messages.values()].filter((m) => m.pinned).concat(pinned.filter((p) => !messages.has(p.id) && p.pinned));
    pinned.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    pinsEl.hidden = pinned.length === 0;
    pinsEl.replaceChildren();
    if (!pinned.length) return;
    const details = el('details', 'wrap');
    const summary = el('summary', '', pinned.length === 1 ? 'הודעה נעוצה' : `${pinned.length} הודעות נעוצות`);
    const last = pinned[pinned.length - 1];
    const peek = el('span', 'peek', last.body.split('\n')[0]);
    peek.dir = 'auto';
    summary.append(peek);
    details.append(summary);
    const ol = el('ol');
    for (const p of pinned) {
      const li = el('li');
      const a = el('a');
      a.href = `#m-${p.id}`;
      a.dataset.jump = p.id;
      a.append(el('b', '', p.author));
      const s = el('span', '', p.body);
      s.dir = 'auto';
      a.append(s);
      li.append(a);
      ol.append(li);
    }
    details.append(ol);
    pinsEl.append(details);
  }

  function take(list, opts) {
    for (const m of list) {
      messages.set(m.id, m);
      if (m.changedAt > since) since = m.changedAt;
    }
    draw(opts);
  }

  pinned = start.pinned ?? [];
  moreWrap.hidden = !start.more;
  take(start.messages, { keepBottom: true });
  requestAnimationFrame(toBottom);

  // A message's own page anchor (#m-<id>) may be older than what is loaded.
  async function jump(id) {
    for (let tries = 0; !document.getElementById(`m-${id}`) && !moreWrap.hidden && tries < 10; tries++) await older();
    const target = document.getElementById(`m-${id}`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  async function older() {
    if (!oldest) return;
    const first = log.querySelector('.chat-msg');
    const data = await send(`/api/chat/${room}/messages?before=${encodeURIComponent(oldest)}`, 'GET');
    moreWrap.hidden = !data.more;
    take(data.messages, { keepBottom: false, anchor: first });
  }
  $('[data-more]').addEventListener('click', () => older().catch((err) => say(err.message)));

  root.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href^="#m-"]');
    if (!a) return;
    ev.preventDefault();
    pinsEl.querySelector('details')?.removeAttribute('open');
    jump(a.getAttribute('href').slice(3));
  });

  // ---------- writing ----------

  const say = (text) => {
    msgEl.textContent = text;
    if (text) setTimeout(() => msgEl.textContent === text && (msgEl.textContent = ''), 5000);
  };

  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };
  ta.addEventListener('input', () => {
    grow();
    typing();
  });

  function setReply(m) {
    replyTo = m?.id ?? null;
    replyingEl.hidden = !m;
    if (m) {
      const only = m.audience?.length ? ` (רק ל${forWhom([...m.audience, m.userId ?? 'owner'].filter((id) => id !== me))})` : '';
      replyingEl.querySelector('span').textContent = `תגובה ל${m.author}${only}: ${m.body.slice(0, 80)}`;
      ta.focus();
    }
    toBtn.hidden = Boolean(m?.audience?.length); // a reply goes to the same people
  }
  $('[data-cancel-reply]').addEventListener('click', () => setReply(null));

  let editing = null;
  function setEdit(m) {
    editing = m?.id ?? null;
    setReply(null);
    if (m) {
      replyingEl.hidden = false;
      replyingEl.querySelector('span').textContent = 'עריכת הודעה';
      ta.value = m.body;
      grow();
      ta.focus();
    }
  }
  $('[data-cancel-reply]').addEventListener('click', () => {
    if (editing) {
      editing = null;
      ta.value = '';
      grow();
    }
  });

  const coarse = matchMedia('(pointer: coarse)').matches;
  ta.addEventListener('keydown', (ev) => {
    // Enter sends on a keyboard; on a phone Enter is a new line and the button sends.
    if (ev.key === 'Enter' && !ev.shiftKey && !coarse && !ev.isComposing) {
      ev.preventDefault();
      form.requestSubmit();
    }
    if (ev.key === 'Escape') {
      setReply(null);
      if (editing) setEdit(null);
    }
  });

  let sending = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = ta.value.trim();
    if (!body || sending) return;
    sending = true;
    try {
      const audience = toBtn.hidden ? [] : [...toSet];
      const m = editing
        ? await send(`/api/chat/messages/${editing}`, 'PATCH', { body })
        : await send(`/api/chat/${room}/messages`, 'POST', { body, replyTo, audience });
      ta.value = '';
      grow();
      editing = null;
      setReply(null);
      // "למי?" stays as it was: a private conversation does not slip into the group.
      take([m], { keepBottom: true });
      say('');
    } catch (err) {
      if (err.status === 403) setCanWrite(false);
      say(err.status === 429 ? 'רגע, הרבה הודעות בדקה אחת. עוד כמה שניות.' : `לא נשלח: ${err.message}`);
    } finally {
      sending = false;
      ta.focus();
    }
  });

  // ---------- for whom: some members only ----------

  const toBtn = $('[data-to-btn]');
  const toPicker = $('[data-to-picker]');
  const toList = $('[data-to-list]');
  let toSet = new Set();
  function setTo(set) {
    toSet = set;
    toBtn.textContent = toSet.size ? `🔒 ל${toSet.size === 1 ? forWhom([...toSet]) : `־${toSet.size}`}` : 'לכולם';
    toBtn.classList.toggle('on', toSet.size > 0);
    for (const box of toList.querySelectorAll('input')) box.checked = toSet.has(box.value);
  }
  function drawToList() {
    toList.replaceChildren();
    // The owner sees every message anyway; members may still write to him alone.
    for (const p of roster.filter((x) => x.id !== me)) {
      const label = el('label', 'chip-check');
      const box = el('input');
      box.type = 'checkbox';
      box.value = p.id;
      box.checked = toSet.has(p.id);
      box.addEventListener('change', () => {
        const next = new Set(toSet);
        if (box.checked) next.add(p.id);
        else next.delete(p.id);
        setTo(next);
      });
      label.append(box, el('span', '', p.name));
      toList.append(label);
    }
    if (!toList.childElementCount) toList.append(el('span', 'hint', 'עוד אין בקהילה אחרים לבחור מהם.'));
  }
  toBtn.addEventListener('click', () => {
    const open = toPicker.hidden;
    toPicker.hidden = !open;
    toBtn.setAttribute('aria-expanded', String(open));
    if (open) drawToList();
  });

  // ---------- participants, and who may write (the owner decides) ----------

  const peopleBtn = $('[data-people-btn]');
  const peopleEl = $('[data-people]');
  const readonlyEl = $('[data-readonly]');
  function setCanWrite(yes) {
    canWrite = yes;
    form.hidden = !yes;
    readonlyEl.hidden = yes;
  }
  function takeRoster(list) {
    roster = list;
    const mine = roster.find((p) => p.id === me);
    if (mine && !owner) setCanWrite(mine.role !== 'read');
    drawPeople();
    if (!toPicker.hidden) drawToList();
  }
  function drawPeople() {
    if (peopleEl.hidden) return;
    const here = new Set(people.map((p) => p.id));
    const ul = el('ul', 'wrap');
    for (const p of roster) {
      const li = el('li');
      const name = el('span', 'name', p.name);
      if (here.has(p.id)) name.classList.add('here');
      li.append(name);
      if (p.id !== me && canWrite) {
        const dm = el('button', 'chat-dm', 'הודעה פרטית');
        dm.type = 'button';
        dm.addEventListener('click', () => privateTo(p.id));
        li.append(dm);
      }
      if (p.id === 'owner') li.append(el('span', 'role', 'מנהל'));
      else if (owner) {
        const sel = el('select');
        sel.setAttribute('aria-label', `הרשאה של ${p.name}`);
        for (const [v, t] of [['write', 'כותב/ת'], ['read', 'קריאה בלבד']]) {
          const o = el('option', '', t);
          o.value = v;
          o.selected = p.role === v;
          sel.append(o);
        }
        sel.addEventListener('change', async () => {
          try {
            await send(`/api/chat/${room}/members/${p.id}`, 'PUT', { role: sel.value });
            p.role = sel.value;
            say(`${p.name}: ${sel.value === 'read' ? 'קריאה בלבד' : 'כותב/ת'}`);
          } catch (err) {
            sel.value = p.role;
            say(err.message);
          }
        });
        li.append(sel);
      } else if (p.role === 'read') li.append(el('span', 'role', 'קריאה בלבד'));
      ul.append(li);
    }
    peopleEl.replaceChildren(ul);
  }
  // Write to one person only: the "למי?" list set to just them.
  function privateTo(id) {
    if (!roster.some((p) => p.id === id) || id === me) return;
    setReply(null);
    setTo(new Set([id]));
    peopleEl.hidden = true;
    peopleBtn.setAttribute('aria-expanded', 'false');
    say(`הודעה פרטית ל${nameOf(id)}: רק את/ה ו${nameOf(id)} תראו אותה.`);
    ta.focus();
  }

  peopleBtn.addEventListener('click', async () => {
    const open = peopleEl.hidden;
    peopleEl.hidden = !open;
    peopleBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      drawPeople();
      try {
        takeRoster((await send(`/api/chat/${room}/members`, 'GET')).members);
      } catch {
        // the list on the page will do
      }
    }
  });

  // ---------- the menu on each message ----------

  let menu = null;
  const closeMenu = () => {
    menu?.remove();
    menu = null;
  };
  document.addEventListener('click', (ev) => {
    if (menu && !menu.contains(ev.target) && !ev.target.closest('[data-menu]')) closeMenu();
  });
  document.addEventListener('keydown', (ev) => ev.key === 'Escape' && closeMenu());

  function openMenu(btn, m) {
    closeMenu();
    menu = el('div', 'chat-menu');
    menu.setAttribute('role', 'menu');
    const item = (label, fn, danger = false) => {
      const b = el('button', danger ? 'danger' : '', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', async () => {
        closeMenu();
        try {
          await fn();
        } catch (err) {
          say(err.message);
        }
      });
      menu.append(b);
    };
    const update = (m2) => take([m2]);
    if (canWrite) item('תגובה', () => setReply(m));
    item('העתקה', () => navigator.clipboard?.writeText(m.body).then(() => say('הועתק')));
    if (canWrite) item(m.pinned ? 'ביטול נעיצה' : 'נעיצה למעלה', async () => update(await send(`/api/chat/messages/${m.id}`, 'PATCH', { pinned: !m.pinned })));
    if (isMine(m) && canWrite) item('עריכה', () => setEdit(m));
    const shared = !m.audience?.length;
    if (isMine(m) || owner) {
      if (!m.post && shared && canWrite) {
        item('לבלוג הקהילה, עם תגובות', async () => {
          const m2 = await send(`/api/chat/messages/${m.id}/post`, 'POST', {});
          update(m2);
          say('עלה לבלוג. אפשר להגיב שם.');
        });
      }
      if (owner && shared && !m.post?.public) {
        item('פרסום לכולם, עם תגובות', async () => {
          update(await send(`/api/chat/messages/${m.id}/post`, 'POST', { public: true }));
          say('פורסם לכולם.');
        });
      }
      item('מחיקה', async () => {
        if (!confirm('למחוק את ההודעה?')) return;
        update(await send(`/api/chat/messages/${m.id}`, 'DELETE'));
      }, true);
    }
    const row = btn.closest('.chat-msg');
    // Near the bottom of the chat the menu opens upward, so it is not cut off.
    const box = scroller.getBoundingClientRect();
    if (row.getBoundingClientRect().bottom > box.top + box.height * 0.55) menu.classList.add('up');
    row.append(menu);
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  log.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-menu]');
    if (!btn) return;
    const m = messages.get(btn.dataset.menu);
    if (m) openMenu(btn, m);
  });

  // ---------- who is here, who is typing ----------

  let people = [];
  const typingNow = new Map(); // id -> { name, until }
  function drawStatus() {
    const now = Date.now();
    for (const [id, t] of typingNow) if (t.until < now) typingNow.delete(id);
    if (typingNow.size) {
      const names = [...typingNow.values()].map((t) => t.name);
      statusEl.textContent = names.length === 1 ? `${names[0]} מקליד/ה…` : `${names.join(', ')} מקלידים…`;
      statusEl.className = 'chat-status typing';
      return;
    }
    statusEl.className = 'chat-status';
    if (mode === 'poll') {
      statusEl.textContent = 'מתעדכן כל כמה שניות';
      return;
    }
    if (mode !== 'live') {
      statusEl.textContent = 'מתחבר…';
      return;
    }
    const others = people.filter((p) => p.id !== me).map((p) => p.name);
    statusEl.textContent = others.length ? `כאן עכשיו: ${others.join(', ')}` : 'מחובר';
  }
  setInterval(drawStatus, 1500);

  let lastTyping = 0;
  function typing() {
    if (mode !== 'live' || Date.now() - lastTyping < 2500) return;
    lastTyping = Date.now();
    try {
      ws.send(JSON.stringify({ type: 'typing' }));
    } catch {
      // the socket is reconnecting
    }
  }

  // ---------- live: socket first, polling as the fallback ----------

  let mode = 'connecting';
  let ws = null;
  let retry = 0;
  let pollTimer = null;
  let socketWorks = true;

  async function catchUp() {
    const data = await send(`/api/chat/${room}/messages?since=${encodeURIComponent(since)}`, 'GET');
    if (data.messages.length) take(data.messages);
  }

  function poll(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        await catchUp();
      } catch (err) {
        if (err.status === 401 || err.status === 403 || err.status === 404) {
          say('אין כבר גישה לצ׳אט הזה.');
          return;
        }
      }
      if (mode === 'poll') poll(document.hidden ? 15000 : 3000);
    }, delay);
  }

  function startPolling() {
    mode = 'poll';
    drawStatus();
    poll(0);
  }

  function connect() {
    if (!('WebSocket' in window) || !socketWorks) return startPolling();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let opened = false;
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/chat/${room}/socket`);
    } catch {
      return startPolling();
    }
    ws.addEventListener('open', () => {
      opened = true;
      retry = 0;
      mode = 'live';
      clearTimeout(pollTimer);
      drawStatus();
      catchUp().catch(() => {});
    });
    ws.addEventListener('message', (ev) => {
      if (ev.data === 'pong') return;
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.type === 'message' && data.message) {
        typingNow.delete(data.message.userId ?? 'owner');
        take([data.message]);
      } else if (data.type === 'presence') {
        people = data.people ?? [];
        drawPeople();
      } else if (data.type === 'members') {
        takeRoster(data.members ?? []);
      } else if (data.type === 'typing' && data.id !== me) {
        typingNow.set(data.id, { name: data.name, until: Date.now() + 4000 });
      }
      drawStatus();
    });
    ws.addEventListener('close', (ev) => {
      ws = null;
      if (ev.code === 4003) {
        mode = 'gone';
        say('אין כבר גישה לצ׳אט הזה.');
        return;
      }
      // Never opened at all: no live chat here, so poll (and try again later).
      if (!opened && retry >= 1) socketWorks = false;
      retry++;
      startPolling();
      if (socketWorks) setTimeout(() => mode === 'poll' && connect(), Math.min(30000, 1000 * 2 ** retry));
    });
  }
  connect();

  // Keep the socket warm, and catch up after the phone wakes.
  setInterval(() => {
    if (mode === 'live' && ws?.readyState === 1) ws.send('ping');
  }, 25000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (mode === 'live') catchUp().catch(() => {});
      else if (mode === 'poll') poll(0);
    }
  });

  if (location.hash.startsWith('#m-')) jump(location.hash.slice(3));
  // /community/<slug>/chat?to=<id>: open ready to write to that person alone.
  const to = new URLSearchParams(location.search).get('to');
  if (to && canWrite) privateTo(to);
})();
