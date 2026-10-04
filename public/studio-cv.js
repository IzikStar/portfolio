// Studio: the CV view (#cv). Everything on /cv in Hebrew and English, which
// sections show and in what order, and which projects and items fill them.
// The preview on the side renders the unsaved form on the server.
// studio.js calls window.studioCv(api) once and routes #cv to open().
window.studioCv = ({ call, send, h, AuthError, wingOf }) => {
  const $ = (id) => document.getElementById(id);
  const VIS = { private: 'רק אני', community: 'קהילה', members: 'חברים', public: 'ציבורי' };
  const KIND = {
    song: 'שיר', chapter: 'פרק', sketch: 'מערכון', dub: 'דיבוב', humor: 'הומור', torah: 'דבר תורה',
    article: 'מאמר', project: 'פרויקט', work: 'יצירה', video: 'סרטון', blog: 'פוסט',
  };
  // The wing whose items fit each section best; its items come first in the list.
  const HOME_WING = { music: 'music', voice: 'humor', sketches: 'sketches', writing: 'articles' };
  const SECTION_NOTE = {
    code: 'הפרויקטים מאגף התוכנה, בסדר שתבחר.',
    music: 'כל פריט עם הקלטה מקבל כפתור נגינה.',
    voice: 'כל פריט עם הקלטה מקבל כפתור נגינה.',
    sketches: 'סרטון מיוטיוב או מהדרייב מוטמע בכרטיס.',
    writing: 'כרטיס לכל פריט, עם התמונה והקישורים שבו.',
    about: 'הטקסט, ציר הזמן והכלים.',
    contact: 'המייל והקישורים בסוף העמוד, וגם בכרטיס שלמעלה.',
  };
  const ST = { cv: null, defaults: null, entries: [], byId: new Map(), seeded: false, dirty: false, lang: 'he', width: 'desk', built: false, open: new Set() };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const fmtTime = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });

  function status(text, err = false) {
    $('cv-status').textContent = text;
    $('cv-status').classList.toggle('err', err);
  }

  function changed() {
    ST.dirty = true;
    status('לא נשמר');
    preview();
  }

  // ---------- small form parts ----------

  // A field in both languages, side by side (stacked on a phone).
  function bi(label, obj, key, { area = false, rows = 3, hint = '' } = {}) {
    obj[key] = { he: obj[key]?.he ?? '', en: obj[key]?.en ?? '' };
    const input = (lang) => {
      const n = h(area ? 'textarea' : 'input', { value: obj[key][lang], dir: lang === 'he' ? 'rtl' : 'ltr', lang });
      if (area) n.rows = rows;
      else n.type = 'text';
      n.setAttribute('aria-label', `${label} (${lang === 'he' ? 'עברית' : 'English'})`);
      n.placeholder = lang === 'he' ? 'עברית' : 'English';
      n.addEventListener('input', () => {
        obj[key][lang] = n.value;
        changed();
      });
      return n;
    };
    return h('div', { className: 'cvs-field' }, h('span', { className: 'lbl' }, label, hint ? h('small', { textContent: ` ${hint}` }) : null), h('div', { className: 'cvs-bi' }, input('he'), input('en')));
  }

  function text(label, obj, key, { dir = 'auto', hint = '', placeholder = '' } = {}) {
    const n = h('input', { type: 'text', value: obj[key] ?? '', dir, placeholder });
    n.addEventListener('input', () => {
      obj[key] = n.value;
      changed();
    });
    return h('label', { className: 'cvs-field' }, h('span', { className: 'lbl' }, label, hint ? h('small', { textContent: ` ${hint}` }) : null), n);
  }

  const small = (label, title, onclick, cls = '') => h('button', { className: `btn small ${cls}`, type: 'button', textContent: label, title, onclick });

  // A list the owner can add to, remove from and reorder. row(item) builds the
  // fields for one item; blank() makes a new one.
  function listEditor(arr, row, blank, addLabel) {
    const box = h('div', { className: 'cvs-list' });
    const draw = () => {
      box.replaceChildren(
        ...arr.map((item, i) =>
          h(
            'div',
            { className: 'cvs-row' },
            h('div', { className: 'cvs-row-fields' }, ...[].concat(row(item, i))),
            h(
              'div',
              { className: 'cvs-row-tools' },
              small('↑', 'למעלה', () => move(i, -1)),
              small('↓', 'למטה', () => move(i, 1)),
              small('✕', 'הסרה', () => {
                arr.splice(i, 1);
                draw();
                changed();
              }, 'danger'),
            ),
          ),
        ),
        h('div', { className: 'toolbar' }, small(addLabel, '', () => {
          arr.push(blank());
          draw();
          changed();
          box.querySelectorAll('.cvs-row')[arr.length - 1]?.querySelector('input, textarea')?.focus();
        })),
      );
    };
    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      draw();
      changed();
    };
    draw();
    return box;
  }

  const linkRow = (x) => [bi('שם', x, 'label'), text('קישור', x, 'href', { dir: 'ltr', placeholder: 'https://... או #code' })];

  // Why an entry would not show on the CV right now.
  function why(e) {
    if (e.status !== 'published') return 'טיוטה';
    if (e.visibility !== 'public') return VIS[e.visibility];
    return 'באוסף שלא פתוח לכולם';
  }

  // Pick entries for a section: the chosen ones in order, and a list to add from.
  function picker(ids, filter, homeWing) {
    const box = h('div', { className: 'cvs-picker' });
    const draw = () => {
      const chosen = ids.map((id) => ST.byId.get(id)).filter(Boolean);
      // Ids of entries that were deleted since: drop them quietly.
      if (chosen.length !== ids.length) ids.splice(0, ids.length, ...chosen.map((e) => e.id));
      const rest = ST.entries.filter((e) => filter(e) && !ids.includes(e.id));
      const groups = new Map();
      for (const e of rest) {
        const w = wingOf(e.spaceId);
        const key = w?.id ?? '';
        if (!groups.has(key)) groups.set(key, { title: w?.title ?? 'בלי אגף', items: [] });
        groups.get(key).items.push(e);
      }
      const order = [...groups.keys()].sort((a, b) => (b === homeWing) - (a === homeWing));
      const add = h(
        'select',
        { ariaLabel: 'הוספה' },
        h('option', { value: '', textContent: rest.length ? 'הוספה מהפריטים שלך…' : 'אין עוד מה להוסיף' }),
        ...order.map((k) =>
          h('optgroup', { label: groups.get(k).title }, ...groups.get(k).items.map((e) => h('option', { value: e.id, textContent: `${e.title || 'בלי כותרת'}${e.shows ? '' : ` (${why(e)})`}` }))),
        ),
      );
      add.disabled = !rest.length;
      add.addEventListener('change', () => {
        if (!add.value) return;
        ids.push(add.value);
        draw();
        changed();
      });
      box.replaceChildren(
        h(
          'ol',
          { className: 'cvs-picks' },
          ...chosen.map((e, i) =>
            h(
              'li',
              { className: e.shows ? '' : 'off' },
              h('span', { className: 'n', textContent: String(i + 1) }),
              h(
                'span',
                { className: 't' },
                h('span', { dir: 'auto', textContent: e.title || 'בלי כותרת' }),
                h('small', {}, h('span', { textContent: KIND[e.kind] ?? e.kind }), e.shows ? null : h('span', { className: 'badge draft', textContent: `לא יופיע: ${why(e)}` })),
              ),
              h(
                'span',
                { className: 'cvs-row-tools' },
                small('↑', 'למעלה', () => swap(i, -1)),
                small('↓', 'למטה', () => swap(i, 1)),
                small('✕', 'להוריד מקורות החיים', () => {
                  ids.splice(i, 1);
                  draw();
                  changed();
                }, 'danger'),
              ),
            ),
          ),
        ),
        ...(chosen.length ? [] : [h('p', { className: 'empty', textContent: 'עוד לא בחרת כלום, אז המקטע לא מופיע.' })]),
        add,
      );
    };
    const swap = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      draw();
      changed();
    };
    draw();
    return box;
  }

  const PICK_HINT = 'בקורות החיים מופיע רק מה שפורסם ופתוח לכולם. אפשר לבחור גם טיוטה או פריט פרטי: הוא יחכה כאן ויופיע כשתפרסם אותו לכולם.';

  // ---------- what each section holds ----------

  function sectionBody(s) {
    const cv = ST.cv;
    const parts = [
      h('p', { className: 'hint', textContent: SECTION_NOTE[s.id] }),
      bi('כותרת', s, 'title'),
      bi('בתפריט למעלה', s, 'nav', { hint: 'ריק = הכותרת' }),
      bi(s.id === 'code' ? 'שורה מתחת לכותרת' : 'פתיח', s, 'intro', { area: true, rows: 2 }),
    ];
    if (s.id === 'code') {
      parts.push(h('h4', { textContent: 'פרויקטים' }), h('p', { className: 'hint', textContent: PICK_HINT }));
      if (ST.seeded) {
        parts.push(
          h(
            'div',
            { className: 'cvs-note' },
            h('p', { textContent: 'הפרויקטים עוד לא בסטודיו, אז העמוד מציג את הרשימה שהייתה כתובה בו. אחרי הייבוא תוכל לבחור ולסדר אותם כאן, ולערוך כל אחד באגף התוכנה.' }),
            small('ייבוא הפרויקטים לסטודיו', '', importProjects, 'primary'),
          ),
        );
      } else {
        parts.push(picker(cv.projects, (e) => e.kind === 'project' || e.kind === 'work', 'software'));
      }
    } else if (HOME_WING[s.id]) {
      parts.push(h('h4', { textContent: 'מה מופיע כאן' }), h('p', { className: 'hint', textContent: PICK_HINT }));
      cv.items[s.id] ??= [];
      parts.push(picker(cv.items[s.id], (e) => e.kind !== 'project' && e.kind !== 'work', HOME_WING[s.id]));
    } else if (s.id === 'about') {
      parts.push(
        bi('הטקסט', cv, 'about', { area: true, rows: 6, hint: 'שורה ריקה = פסקה חדשה' }),
        h('h4', { textContent: 'בקצרה (ציר זמן)' }),
        listEditor(cv.timeline, (x) => [bi('מתי', x, 'when'), bi('מה', x, 'what'), bi('פירוט', x, 'detail')], () => ({ when: { he: '', en: '' }, what: { he: '', en: '' }, detail: { he: '', en: '' } }), 'הוספת שורה'),
        h('h4', { textContent: 'כלים ושפות' }),
        skillsField(cv),
      );
    } else if (s.id === 'contact') {
      parts.push(
        text('מייל', cv, 'email', { dir: 'ltr', placeholder: 'name@example.com' }),
        h('h4', { textContent: 'קישורים' }),
        listEditor(cv.contact, linkRow, () => ({ label: { he: '', en: '' }, href: '' }), 'הוספת קישור'),
      );
    }
    return parts;
  }

  function skillsField(cv) {
    const area = h('textarea', { rows: 3, dir: 'ltr', value: cv.skills.join(', ') });
    area.setAttribute('aria-label', 'כלים ושפות');
    area.addEventListener('input', () => {
      cv.skills = area.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
      changed();
    });
    return h('label', { className: 'cvs-field' }, h('span', { className: 'lbl' }, 'מופרדים בפסיק', h('small', { textContent: ' כל אחד הופך לתגית' })), area);
  }

  function sectionsEditor() {
    const box = h('div', { className: 'cvs-sections' });
    const draw = () => {
      box.replaceChildren(
        ...ST.cv.sections.map((s, i) => {
          const show = h('input', { type: 'checkbox', checked: s.show });
          show.setAttribute('aria-label', `להציג את ${s.title.he}`);
          show.addEventListener('change', () => {
            s.show = show.checked;
            node.classList.toggle('off', !s.show);
            changed();
          });
          // The checkbox and arrows sit in the summary; keep clicks on them from toggling it.
          const stop = (n) => {
            n.addEventListener('click', (e) => e.stopPropagation());
            return n;
          };
          const node = h(
            'details',
            { className: `cvs-sec${s.show ? '' : ' off'}`, open: ST.open.has(s.id) },
            h(
              'summary',
              {},
              stop(h('label', { className: 'cvs-show', title: 'מופיע בעמוד' }, show)),
              h('span', { className: 'num', textContent: String(i + 1).padStart(2, '0') }),
              h('span', { className: 't', textContent: s.title.he || s.id }),
              stop(h('span', { className: 'cvs-row-tools' }, small('↑', 'למעלה', () => move(i, -1)), small('↓', 'למטה', () => move(i, 1)))),
            ),
            h('div', { className: 'cvs-sec-body' }, ...sectionBody(s)),
          );
          node.dataset.id = s.id;
          // Sections stay open across a save or an import, which redraw the form.
          node.addEventListener('toggle', () => (node.open ? ST.open.add(s.id) : ST.open.delete(s.id)));
          return node;
        }),
      );
    };
    const move = (i, d) => {
      const list = ST.cv.sections;
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      draw();
      changed();
    };
    draw();
    return box;
  }

  function box(title, hint, ...kids) {
    return h('section', { className: 'box cvs-box' }, h('h2', { textContent: title }), hint ? h('p', { className: 'hint', textContent: hint }) : null, ...kids);
  }

  function buildForm() {
    const cv = ST.cv;
    $('cv-form').replaceChildren(
      box(
        'למעלה בעמוד',
        'מה שמגייס רואה קודם. כל שדה בעברית ובאנגלית; שדה אנגלי ריק מציג את העברית.',
        bi('שורת זמינות', cv, 'avail', { hint: 'ריק = בלי השורה' }),
        bi('שם', cv, 'name'),
        h('h4', { textContent: 'תפקידים' }),
        listEditor(cv.roles, (r, i) => [bi(i === 0 ? 'תפקיד (הראשון מודגש)' : 'תפקיד', cv.roles, i)], () => ({ he: '', en: '' }), 'הוספת תפקיד'),
        bi('פתיח', cv, 'lede', { area: true, rows: 4 }),
        h('h4', { textContent: 'כפתורים' }),
        h('p', { className: 'hint', textContent: 'הראשון בולט. קישור יכול להיות כתובת https://, מייל (mailto:) או מקטע בעמוד, כמו #code או #contact.' }),
        listEditor(cv.buttons, linkRow, () => ({ label: { he: '', en: '' }, href: '' }), 'הוספת כפתור'),
      ),
      box('המקטעים', 'סמן מה מופיע, סדר בחצים, ופתח מקטע כדי לערוך אותו. מקטע בלי תוכן לא מופיע גם כשהוא מסומן.', sectionsEditor()),
      box(
        'בתחתית',
        '',
        bi('שורה בתחתית העמוד', cv, 'footer'),
        h('div', { className: 'toolbar' }, small('החזרת כל הטקסטים להתחלה', 'הבחירות של פרויקטים ופריטים נשארות', resetTexts)),
      ),
    );
  }

  // ---------- loading, saving, preview ----------

  function take(data) {
    ST.cv = clone(data.cv);
    ST.defaults = data.defaults;
    ST.entries = data.entries;
    ST.byId = new Map(data.entries.map((e) => [e.id, e]));
    ST.seeded = data.seeded;
  }

  async function open() {
    if (!ST.built) wire();
    if (ST.dirty && ST.cv) return void preview.now();
    status('טוען...');
    try {
      take(await call('/api/studio/cv'));
      buildForm();
      ST.dirty = false;
      status('');
      preview.now();
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, true);
    }
  }

  async function save() {
    if (!ST.cv) return;
    status('שומר...');
    try {
      take(await send('/api/studio/cv', 'PUT', { cv: ST.cv }));
      buildForm();
      ST.dirty = false;
      status(`נשמר ${fmtTime.format(new Date())}`);
      preview.now();
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, true);
    }
  }

  async function importProjects() {
    status('מייבא...');
    try {
      await send('/api/studio/import-cv', 'POST');
      const keep = ST.dirty ? ST.cv : null;
      take(await call('/api/studio/cv'));
      // Keep what was typed but not saved yet; the project list comes from the import.
      if (keep) ST.cv = { ...keep, projects: ST.cv.projects };
      buildForm();
      status(ST.dirty ? 'הפרויקטים יובאו. יש שינויים שלא נשמרו' : 'הפרויקטים יובאו');
      preview.now();
    } catch (err) {
      if (!(err instanceof AuthError)) status(err.message, true);
    }
  }

  function resetTexts() {
    if (!confirm('להחזיר את כל הטקסטים והמקטעים למה שהיה בהתחלה? הבחירה של פרויקטים ופריטים נשארת.')) return;
    ST.cv = { ...clone(ST.defaults), items: ST.cv.items, projects: ST.cv.projects };
    buildForm();
    changed();
  }

  let timer = null;
  let seq = 0;
  async function render() {
    clearTimeout(timer);
    if (!ST.cv || $('view-cv').hidden) return;
    const mine = ++seq;
    try {
      const { html } = await send('/api/studio/cv/preview', 'POST', { cv: ST.cv, lang: ST.lang });
      if (mine !== seq) return;
      const frame = $('cv-frame');
      const y = frame.contentWindow?.scrollY ?? 0;
      frame.onload = () => {
        frame.contentWindow?.scrollTo(0, y);
        fit();
      };
      frame.srcdoc = html;
    } catch (err) {
      // A field the server refuses (a bad link) shows here; the preview waits for a fix.
      if (!(err instanceof AuthError)) status(err.message, true);
    }
  }
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 700);
  };
  preview.now = render;

  // The preview is drawn at a real screen width and scaled to fit its pane.
  function fit() {
    const wrap = $('cv-frame-wrap');
    const frame = $('cv-frame');
    const width = ST.width === 'phone' ? 390 : 1280;
    const scale = Math.min(1, wrap.clientWidth / width);
    frame.style.width = `${width}px`;
    frame.style.height = `${wrap.clientHeight / scale}px`;
    frame.style.transform = `scale(${scale})`;
  }

  function wire() {
    ST.built = true;
    $('cv-save').addEventListener('click', save);
    const group = (id, key, after) =>
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        ST[key] = b.dataset.v;
        for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
        after();
      });
    group('cv-lang', 'lang', render);
    group('cv-width', 'width', fit);
    // On a phone the preview starts at phone width.
    if (window.innerWidth < 700) $('cv-width').querySelector('[data-v="phone"]').click();
    $('cv-switch').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('view-cv').dataset.pane = b.dataset.pane;
      for (const x of $('cv-switch').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      if (b.dataset.pane === 'preview') {
        fit();
        render();
      }
    });
    window.addEventListener('resize', fit);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$('view-cv').hidden) {
        e.preventDefault();
        save();
      }
    });
  }

  return {
    open,
    dirty: () => ST.dirty,
    // Leaving with unsaved changes the owner agreed to drop: load fresh next time.
    clean: () => {
      ST.dirty = false;
    },
  };
};
