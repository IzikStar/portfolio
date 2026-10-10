// The halls of fame page (/community/<slug>/hall, src/chat.js): the owner
// adds, renames and removes characters; whoever put a message in a hall (and
// the owner) can take it out again.
(() => {
  const root = document.querySelector('[data-hall]');
  if (!root) return;
  const msg = root.querySelector('[data-hall-msg]');
  const say = (text) => (msg.textContent = text);

  const send = async (url, method, body) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || String(res.status));
    return data;
  };
  const fields = (form) => ({ name: form.elements.name.value.trim(), about: form.elements.about.value.trim() });

  root.addEventListener('submit', async (ev) => {
    const form = ev.target;
    const room = form.dataset.charNew;
    const id = form.dataset.charForm;
    if (!room && !id) return;
    ev.preventDefault();
    try {
      if (room) {
        const { character } = await send(`/api/chat/${room}/characters`, 'POST', fields(form));
        location.hash = `ch-${character.id}`;
      } else {
        await send(`/api/chat/characters/${id}`, 'PATCH', fields(form));
      }
      location.reload();
    } catch (err) {
      say(err.message);
    }
  });

  root.addEventListener('click', async (ev) => {
    const edit = ev.target.closest('[data-char-edit]');
    if (edit) {
      const form = root.querySelector(`[data-char-form="${edit.dataset.charEdit}"]`);
      form.hidden = !form.hidden;
      edit.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) form.elements.name.focus();
      return;
    }
    const del = ev.target.closest('[data-char-delete]');
    if (del) {
      if (!confirm(`למחוק את ${del.dataset.name}? ההודעות נשארות בצ׳אט, רק ההיכל שלה נמחק.`)) return;
      try {
        await send(`/api/chat/characters/${del.dataset.charDelete}`, 'DELETE');
        del.closest('.hall').remove();
        say(`${del.dataset.name} נמחקה.`);
      } catch (err) {
        say(err.message);
      }
      return;
    }
    const out = ev.target.closest('[data-hall-out]');
    if (out) {
      try {
        await send(`/api/chat/messages/${out.dataset.hallOut}/hall/${out.dataset.character}`, 'DELETE');
        const list = out.closest('.hall-list');
        out.closest('.hall-quote').remove();
        if (list && !list.children.length) list.remove();
        say('הוצאה מההיכל.');
      } catch (err) {
        say(err.message);
      }
    }
  });
})();
