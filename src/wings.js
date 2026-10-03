// The public face of the site: the home page, a page per wing, a page per
// space inside a wing (a book, a series, a genre) and a page per item.
// Addresses:
//   /                     home
//   /music                a wing
//   /books/<space>        a space inside a wing
//   /music/<item>         an item that sits in the wing itself
//   /books/<space>/<item> an item inside a space
// Everything goes through access() (src/spaces.js), so a visitor only ever
// gets what their communities open to them.
import { escapeHtml as e, renderMarkdown } from './markdown.js';
import { db, WINGS } from './db.js';
import { card, getEntry, listFeed, listInSpace } from './entries.js';
import { entryFilter, canSee, communityOf } from './spaces.js';
import { projectView } from './projects.js';
import { renderChords, hasChords } from './chords.js';
import { mediaEmbed } from './media.js';
import { commentsBlock, commentsOf, canComment } from './comments.js';
import { render, socials, WING_INFO, KIND_LABEL, LOCK, icon, fmtDate, badge, entryPath, spacePath, wingOf } from './site.js';

const SPACE_LABEL = { book: 'ספר', series: 'סדרה', genre: 'ז\'אנר', collection: 'אוסף' };

// ---------- shared pieces ----------

function descendants(acc, rootId) {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    for (const s of acc.spaces) if (s.parentId === ids[i] && acc.visible.has(s.id)) ids.push(s.id);
  }
  return ids;
}

const children = (acc, id) => acc.spaces.filter((s) => s.parentId === id && acc.visible.has(s.id));

// How many published items in these spaces stay closed to this viewer.
async function lockedCount(env, acc, spaceIds) {
  if (acc.owner) return 0;
  const d = await db(env);
  const f = entryFilter(acc);
  const row = await d
    .prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE status = 'published' AND visibility IN ('community', 'members')
       AND space_id IN (SELECT value FROM json_each(?)) AND NOT (${f.sql})`,
    )
    .bind(JSON.stringify(spaceIds), ...f.args)
    .first();
  return row?.n ?? 0;
}

// Where this viewer stands with the community that guards `spaceId`.
function communityBox(v, spaceId, path) {
  const { acc } = v;
  const target = acc.byId.get(communityOf(acc.byId, spaceId));
  if (!target) return '';
  const name = target.parentId ? target.title : `קהילת ה${target.title}`;
  const label = target.kind === 'book' ? `קוראי הבטא של ${target.title}` : name;
  if (acc.owner) {
    return `<div class="community-box"><p><strong>${e(label)}</strong>. כאן רואים את מה שפתוח לקהילה.</p><a class="btn small" href="/studio#space/${e(target.id)}">ניהול הקהילה</a></div>`;
  }
  if (acc.communities.has(target.id)) return `<div class="community-box"><p>את.ה ב<strong>${e(label)}</strong>, ורואים כאן גם את מה שפתוח רק לקהילה.</p></div>`;
  if (acc.pending.has(target.id)) return `<div class="community-box"><p>הבקשה להצטרף ל<strong>${e(label)}</strong> מחכה לאישור.</p></div>`;
  if (target.joinMode === 'closed') return `<div class="community-box"><p><strong>${e(label)}</strong> פתוחה בהזמנה בלבד.</p></div>`;
  const ask = target.kind === 'book' ? 'לבקש להיות קורא.ת בטא' : 'לבקש להצטרף';
  if (v.member) {
    return `<div class="community-box"><p>חלק מהדברים כאן פתוחים רק ל<strong>${e(label)}</strong>.</p><button class="btn accent" type="button" data-join="${e(target.id)}">${ask}</button><span class="msg" role="status"></span></div>`;
  }
  return `<div class="community-box"><p>חלק מהדברים כאן פתוחים רק ל<strong>${e(label)}</strong>.</p><a class="btn accent" href="/join?space=${encodeURIComponent(target.id)}&next=${encodeURIComponent(path)}">${ask}</a><a class="btn" href="/login?next=${encodeURIComponent(path)}">כבר בקהילה? כניסה</a></div>`;
}

const versionTypes = (entry) => [...new Set((entry.meta?.versions ?? []).map((x) => x.label).filter(Boolean))].slice(0, 4);

function itemCard(v, entry) {
  const href = entryPath(v.acc, entry);
  if (!href) return '';
  const c = card(entry);
  if (entry.kind === 'project' || entry.kind === 'work') {
    const p = projectView(entry);
    return `<a class="card" href="${href}">
  ${p.img ? `<img src="${e(p.img)}" alt="" loading="lazy">` : ''}
  <span class="title" dir="auto">${e(p.name.he)}</span>
  <p dir="auto">${e(p.text.he)}</p>
  ${p.stack.length ? `<ul class="chips">${p.stack.slice(0, 5).map((t) => `<li>${e(t)}</li>`).join('')}</ul>` : ''}
  <span class="meta">${badge(entry, v)}</span>
</a>`;
  }
  const chips = [entry.kind === 'song' && entry.body.trim() ? 'אקורדים' : null, ...versionTypes(entry)].filter(Boolean);
  return `<a class="card" href="${href}">
  <span class="title" dir="auto">${e(entry.title)}</span>
  ${chips.length ? `<span class="chips">${chips.map((t) => `<span class="chip on">${e(t)}</span>`).join('')}</span>` : c.summary ? `<p dir="auto">${e(c.summary)}</p>` : ''}
  <span class="meta"><span>${e(KIND_LABEL[entry.kind] ?? '')}</span>${badge(entry, v)}</span>
</a>`;
}

const lockedNote = (n, what = 'פריטים') => (n ? `<p class="lock">${LOCK} עוד ${n} ${what} פתוחים רק לקהילה</p>` : '');

// ---------- home ----------

export async function home(env, v) {
  const { acc } = v;
  const wings = WINGS.filter((w) => acc.visible.has(w.id));
  const feed = (await listFeed(env, acc, 40)).filter((x) => entryPath(acc, x)).slice(0, 8);
  const links = await socials(env);
  const tiles = wings
    .map((w) => {
      const s = acc.byId.get(w.id);
      const info = WING_INFO[w.id];
      const priv = s.visibility === 'private' ? ' · מוסתר' : '';
      return `<a class="wing-tile" data-wing="${w.id}" href="/${w.id}">
  ${icon(info.icon)}
  <span class="name">${e(s.title)}</span>
  <span class="what">${e(s.summary || info.what)}</span>
  <span class="who">${acc.communities.has(w.id) && !acc.owner ? 'את.ה בקהילה' : 'קהילה משלו'}${priv}</span>
</a>`;
    })
    .join('\n');
  const latest = feed.length
    ? `<div class="feed">${feed
        .map((x) => {
          const w = wingOf(acc, x.spaceId);
          return `<a href="${entryPath(acc, x)}" data-wing="${e(w?.id ?? '')}"><span class="w">${e(w?.title ?? '')}</span><span class="t" dir="auto">${e(x.title)}</span><span class="d">${e(fmtDate(x.publishedAt))}</span></a>`;
        })
        .join('')}</div>`
    : '<p class="empty">התוכן הראשון בדרך.</p>';
  const cta = v.member
    ? `<h2>שלום ${e(v.member.displayName)}</h2><p>בכל אגף אפשר לבקש להצטרף לקהילה שלו. אחרי שאני מאשר, נפתחים שם טיוטות, הקלטות ופרקים חדשים.</p>`
    : acc.owner
      ? `<h2>הסטודיו</h2><p>כל אגף והקהילה שלו מנוהלים מהסטודיו.</p><a class="btn primary" href="/studio">לסטודיו</a>`
      : `<h2>רוצים לראות יותר?</h2><p>מצטרפים לאגף שמעניין אתכם. אני מאשר, ומאותו רגע נפתחים הטיוטות, ההקלטות והפרקים החדשים, ואפשר להגיב.</p><div class="actions"><a class="btn primary" href="/join">לבקש הצטרפות</a><a class="btn" href="/login">כניסה</a></div>`;
  const body = `<div class="wrap">
  <section class="hero">
    <div class="copy">
      <div class="kicker">שירים · ספרים · מערכונים · קוד · תורה</div>
      <h1>כל מה<br>שאני יוצר,<br>במקום אחד.</h1>
      <p class="lede">חלק פתוח לכולם. השאר שמור לקהילות: מי שמצטרף לאגף רואה טיוטות, הקלטות גולמיות ופרקים שעוד לא יצאו.</p>
      <div class="actions"><a class="btn primary" href="/cv">קורות חיים ופרויקטים</a>${v.role === 'public' ? '<a class="btn" href="/join">להצטרף לקהילה</a>' : ''}</div>
    </div>
    ${links.length ? `<aside><span class="label">ברשתות</span>${links.map((s) => `<a href="${e(s.href)}" rel="me noopener">${e(s.label)} ↗</a>`).join('')}</aside>` : ''}
  </section>
  <section class="block">
    <div class="section-head"><h2>האגפים</h2><span>לכל אגף קהילה משלו</span></div>
    <div class="wings">${tiles}</div>
  </section>
  <section class="block split">
    <div class="main">
      <div class="section-head"><h2>חדש באתר</h2></div>
      ${latest}
    </div>
    <div class="side panel">${cta}</div>
  </section>
</div>`;
  return render(env, v, {
    title: '',
    description: 'יצחק שטרן: שירים, ספרים, מערכונים, דיבובים, דברי תורה, מאמרים ותוכנה.',
    path: '/',
    body,
  });
}

// ---------- a wing or a space ----------

function band({ wing, space, acc, path, lede, tabs = true }) {
  const kids = children(acc, wing.id);
  const nav = tabs && kids.length
    ? `<nav aria-label="${e(wing.title)}"><a href="/${wing.id}"${path === `/${wing.id}` ? ' aria-current="page"' : ''}>הכל</a>${kids
        .map((k) => `<a href="${spacePath(acc, k)}"${space?.id === k.id ? ' aria-current="page"' : ''}>${e(k.title)}</a>`)
        .join('')}</nav>`
    : '<div class="spacer"></div>';
  const crumbs = space ? `<div class="crumbs"><a href="/${wing.id}">${e(wing.title)}</a></div>` : '';
  return `<section class="band"><div class="wrap">
  ${crumbs}
  <h1 dir="auto">${e(space?.title ?? wing.title)}</h1>
  ${lede ? `<p class="lede" dir="auto">${e(lede)}</p>` : ''}
  ${nav}
</div></section>`;
}

export async function wingPage(env, v, wingId) {
  const { acc } = v;
  const wing = acc.byId.get(wingId);
  if (!wing || !acc.visible.has(wingId)) return null;
  const path = `/${wingId}`;
  const ids = descendants(acc, wingId);
  const [items, locked] = await Promise.all([listInSpace(env, acc, ids), lockedCount(env, acc, ids)]);
  const kids = children(acc, wingId);
  const shelf = kids.length
    ? `<section class="block"><div class="cards">${kids
        .map((k) => {
          const n = items.filter((x) => descendants(acc, k.id).includes(x.spaceId)).length;
          return `<a class="card${k.kind === 'book' ? ' book' : ''}" href="${spacePath(acc, k)}">
  <span class="title" dir="auto">${e(k.title)}</span>
  ${k.summary ? `<p dir="auto">${e(k.summary)}</p>` : ''}
  <span class="meta"><span>${e(SPACE_LABEL[k.kind] ?? '')}</span>${n ? `<span>${n} פריטים</span>` : ''}${acc.owner && k.visibility !== 'public' ? `<span class="badge vis-${e(k.visibility)}">${k.visibility === 'private' ? 'פרטי' : 'לקהילה'}</span>` : ''}</span>
</a>`;
        })
        .join('')}</div></section>`
    : '';
  // Items that sit in the wing itself, plus the newest from inside its spaces.
  const loose = items.filter((x) => x.spaceId === wingId);
  const grid = loose.length ? `<div class="cards">${loose.map((x) => itemCard(v, x)).join('')}</div>` : kids.length ? '' : '<p class="empty">עוד אין כאן כלום. בקרוב.</p>';
  const body = `${band({ wing, acc, path, lede: wing.summary || WING_INFO[wingId].what })}
<div class="wrap">
  ${shelf}
  <section class="block">${grid}${lockedNote(locked)}</section>
  ${communityBox(v, wingId, path)}
</div>`;
  return render(env, v, { title: wing.title, description: wing.summary || WING_INFO[wingId].what, path, wing: wingId, body, script: true });
}

const byOrder = (a, b) => (a.meta?.order ?? 1e9) - (b.meta?.order ?? 1e9) || String(a.publishedAt).localeCompare(String(b.publishedAt));

export async function spacePage(env, v, space) {
  const { acc } = v;
  const wing = wingOf(acc, space.id);
  const path = spacePath(acc, space);
  const ids = descendants(acc, space.id);
  const [items, locked] = await Promise.all([listInSpace(env, acc, ids), lockedCount(env, acc, ids)]);
  let body;
  if (space.kind === 'book') {
    const chapters = items.filter((x) => x.spaceId === space.id).sort(byOrder);
    const cover = space.meta?.cover && /^(https:\/\/|\/(?!\/))/.test(space.meta.cover) ? `<img src="${e(space.meta.cover)}" alt="">` : `<span class="t" dir="auto">${e(space.title)}</span><span>יצחק שטרן</span>`;
    const status = space.meta?.status ? `${e(space.meta.status)}` : 'ספר';
    const toc = chapters.length
      ? `<ol class="toc">${chapters
          .map((c, i) => `<li><a href="${entryPath(acc, c)}"><span dir="auto">${e(c.title)}</span><span class="n">${c.visibility === 'public' ? `פרק ${i + 1}` : `פרק ${i + 1} · לקוראי בטא`}</span></a></li>`)
          .join('')}${locked ? `<li><span class="locked"><span>עוד ${locked} פרקים</span><span class="lock">${LOCK} לקוראי בטא</span></span></li>` : ''}</ol>`
      : locked
        ? `<p class="lock">${LOCK} ${locked} פרקים פתוחים לקוראי בטא</p>`
        : '<p class="empty">הפרקים בדרך.</p>';
    const beta = acc.owner || acc.communities.has(communityOf(acc.byId, space.id))
      ? communityBox(v, space.id, path)
      : `<div class="panel tinted"><h2>להיות קורא.ת בטא</h2><ol class="steps"><li>שולחים בקשה עם כמה מילים</li><li>אני מאשר</li><li>כל הספר נפתח, כולל פרקים חדשים כשהם עולים, ואפשר להגיב על כל פרק</li></ol>${communityBox(v, space.id, path)}</div>`;
    body = `<div class="wrap" data-wing="books">
  <div class="crumbs back"><a href="/${wing.id}">${e(wing.title)}</a></div>
  <section class="book-head">
    <div class="cover">${cover}</div>
    <div class="copy">
      <div class="kicker">${status}</div>
      <h1 dir="auto">${e(space.title)}</h1>
      ${space.summary ? `<p class="lede" dir="auto">${e(space.summary)}</p>` : ''}
      ${beta}
    </div>
  </section>
  <section class="block"><div class="section-head"><h2>פרקים</h2></div>${toc}</section>
</div>`;
  } else {
    const kids = children(acc, space.id);
    const sub = kids.length
      ? `<section class="block"><div class="cards">${kids.map((k) => `<a class="card" href="${spacePath(acc, k)}"><span class="title" dir="auto">${e(k.title)}</span>${k.summary ? `<p dir="auto">${e(k.summary)}</p>` : ''}<span class="meta">${e(SPACE_LABEL[k.kind] ?? '')}</span></a>`).join('')}</div></section>`
      : '';
    const own = items.filter((x) => x.spaceId === space.id).sort(space.kind === 'series' ? byOrder : () => 0);
    const grid = own.length ? `<div class="cards">${own.map((x) => itemCard(v, x)).join('')}</div>` : kids.length ? '' : '<p class="empty">עוד אין כאן כלום. בקרוב.</p>';
    body = `${band({ wing, space, acc, path, lede: space.summary })}
<div class="wrap">
  ${sub}
  <section class="block">${grid}${lockedNote(locked)}</section>
  ${communityBox(v, space.id, path)}
</div>`;
  }
  const noindex = space.visibility !== 'public';
  return render(env, v, { title: space.title, description: space.summary, path, wing: wing.id, body, noindex, script: true });
}

// ---------- one item ----------

function versionsBlock(v, entry) {
  const { acc } = v;
  const versions = Array.isArray(entry.meta?.versions) ? entry.meta.versions.filter((x) => x && typeof x.url === 'string') : [];
  const inCommunity = acc.owner || acc.communities.has(communityOf(acc.byId, entry.spaceId));
  const tabs = [];
  if (entry.kind === 'song' && entry.body.trim()) {
    const chords = hasChords(entry.body);
    const tools = chords
      ? `<div class="tools" data-transpose><span>${entry.meta?.capo ? `קאפו ${e(entry.meta.capo)} · ` : ''}${entry.meta?.key ? `סולם ${e(entry.meta.key)} · ` : ''}טרנספוזיציה</span><button type="button" data-step="-1" aria-label="חצי טון למטה">−</button><output>0</output><button type="button" data-step="1" aria-label="חצי טון למעלה">+</button><button type="button" data-plain aria-pressed="false">בלי אקורדים</button></div>`
      : '';
    tabs.push({ label: chords ? 'מילים ואקורדים' : 'מילים', html: `<div class="sheet">${tools}${renderChords(entry.body)}</div>` });
  }
  for (const x of versions.slice(0, 20)) {
    const label = String(x.label || 'נגן').slice(0, 40);
    if (x.visibility === 'community' && !inCommunity) {
      tabs.push({ label, html: `<p class="lock">${LOCK} הגרסה הזאת פתוחה רק לקהילה</p>`, locked: true });
      continue;
    }
    const player = mediaEmbed(x.url, { title: label, kind: x.kind });
    if (player) tabs.push({ label, html: `${player}${x.note ? `<p class="media-note" dir="auto">${e(String(x.note).slice(0, 300))}</p>` : ''}` });
  }
  if (!tabs.length) return '';
  if (tabs.length === 1) return `<section class="block">${tabs[0].html}</section>`;
  return `<section class="block" data-versions>
  <div class="versions" role="tablist">${tabs.map((t, i) => `<button type="button" role="tab" id="vt${i}" aria-controls="vp${i}" aria-selected="${i === 0}">${e(t.label)}${t.locked ? ` ${LOCK}` : ''}</button>`).join('')}</div>
  ${tabs.map((t, i) => `<div class="version" role="tabpanel" id="vp${i}" aria-labelledby="vt${i}"${i ? ' hidden' : ''}>${t.html}</div>`).join('\n  ')}
</section>`;
}

async function siblings(env, v, entry) {
  const items = (await listInSpace(env, v.acc, [entry.spaceId])).sort(byOrder);
  const i = items.findIndex((x) => x.id === entry.id);
  return { prev: i > 0 ? items[i - 1] : null, next: i >= 0 && i < items.length - 1 ? items[i + 1] : null };
}

const LINK_LABEL = { code: 'קוד', live: 'אתר חי', playGame: 'לשחק' };

export async function entryPage(env, v, entry) {
  const { acc } = v;
  const path = entryPath(acc, entry);
  const space = acc.byId.get(entry.spaceId);
  const wing = wingOf(acc, entry.spaceId);
  const edit = acc.owner ? `<a class="btn small" href="/studio#item/${e(entry.id)}">עריכה</a>` : '';
  const crumbs = `<a href="/${wing.id}">${e(wing.title)}</a>${space.parentId ? ` · <a href="${spacePath(acc, space)}">${e(space.title)}</a>` : ''}`;
  let header;
  let main;
  if (entry.kind === 'project' || entry.kind === 'work') {
    const p = projectView(entry);
    const s = entry.meta?.synced ?? {};
    const repo = entry.meta?.source?.type === 'github' ? entry.meta.source.repo : null;
    const readmeBase = repo ? { link: `https://github.com/${repo}/blob/${s.branch || 'HEAD'}/`, image: `https://raw.githubusercontent.com/${repo}/${s.branch || 'HEAD'}/` } : null;
    const content = entry.body.trim() ? renderMarkdown(entry.body) : s.readme ? renderMarkdown(s.readme, { base: readmeBase }) : '';
    header = `<div class="meta">${crumbs}${p.tag.he ? `<span>${e(p.tag.he)}</span>` : ''}${s.pushedAt ? `<span>עודכן ב־GitHub ${e(fmtDate(s.pushedAt))}</span>` : ''}${badge(entry, v)}${edit}</div>
    <h1 dir="auto">${e(p.name.he)}</h1>
    ${p.text.he ? `<p class="lede" dir="auto">${e(p.text.he)}</p>` : ''}
    ${p.stack.length ? `<ul class="chips">${p.stack.map((t) => `<li>${e(t)}</li>`).join('')}</ul>` : ''}
    ${p.links.length ? `<div class="links">${p.links.map((l) => `<a href="${e(l.href)}" rel="noopener">${e(LINK_LABEL[l.k] ?? l.k)} ↗</a>`).join('')}</div>` : ''}`;
    main = `${p.img ? `<img class="hero-img" src="${e(p.img)}" alt="">` : ''}${content ? `<div class="prose" dir="auto">${content}</div>` : ''}`;
  } else {
    header = `<div class="meta">${crumbs}${entry.publishedAt ? `<time datetime="${e(entry.publishedAt)}">${e(fmtDate(entry.publishedAt))}</time>` : ''}${badge(entry, v)}${edit}</div>
    <span class="kind">${e(KIND_LABEL[entry.kind] ?? '')}</span>
    <h1 dir="auto">${e(entry.title)}</h1>
    ${entry.summary ? `<p class="lede" dir="auto">${e(entry.summary)}</p>` : ''}
    ${entry.tags.length ? `<ul class="chips">${entry.tags.map((t) => `<li>${e(t)}</li>`).join('')}</ul>` : ''}`;
    const reading = entry.kind === 'chapter' ? 'paper prose' : entry.kind === 'article' || entry.kind === 'torah' ? 'prose read' : 'prose';
    const anchors = canComment(v, entry) ? ' data-anchors' : '';
    const text = entry.kind !== 'song' && entry.body.trim() ? `<div class="${reading}" dir="auto"${anchors}>${renderMarkdown(entry.body)}</div>` : '';
    main = `${versionsBlock(v, entry)}${text}`;
    if (entry.kind === 'chapter' || space.kind === 'series') {
      const { prev, next } = await siblings(env, v, entry);
      main += `<nav class="pager" aria-label="ניווט">${next ? `<a href="${entryPath(acc, next)}">→ ${e(next.title)}</a>` : '<span></span>'}${prev ? `<a href="${entryPath(acc, prev)}">${e(prev.title)} ←</a>` : '<span></span>'}</nav>`;
    }
  }
  const body = `<article class="wrap article">
  <header>
    ${header}
  </header>
  ${main}
  ${commentsBlock(v, entry, canComment(v, entry) ? await commentsOf(env, entry.id) : [])}
  <p class="back"><a href="${spacePath(acc, space)}">חזרה ל${e(space.title)}</a></p>
</article>`;
  const isPublic = entry.visibility === 'public' && entry.status === 'published' && acc.visible.has(entry.spaceId);
  return render(env, v, {
    title: entry.title || projectView(entry).name.he,
    description: entry.summary || card(entry).summary,
    path,
    wing: wing.id,
    body,
    noindex: !isPublic,
    script: true,
  });
}

// ---------- routing ----------

// /<wing>/<a>[/<b>]: a space, or an item in the wing or in a space.
export async function resolve(env, v, wingId, a, b) {
  const { acc } = v;
  if (!WINGS.some((w) => w.id === wingId) || !acc.visible.has(wingId)) return null;
  const d = await db(env);
  const find = async (spaceId, slug) => {
    const { results } = await d.prepare('SELECT * FROM entries WHERE space_id = ? AND slug = ?').bind(spaceId, slug).all();
    for (const r of results) {
      const entry = await getEntry(env, r.id);
      if (entry && canSee(acc, entry)) return entry;
    }
    return null;
  };
  const space = acc.spaces.find((s) => s.wing === wingId && s.parentId && s.slug === a && acc.visible.has(s.id));
  if (b === undefined) {
    if (space) return spacePage(env, v, space);
    const entry = await find(wingId, a);
    return entry ? entryPage(env, v, entry) : null;
  }
  if (!space) return null;
  const entry = await find(space.id, b);
  return entry ? entryPage(env, v, entry) : null;
}

// Members' own page: what is new in the communities they belong to.
export async function communityPage(env, v) {
  const { acc, member } = v;
  if (v.role === 'public') {
    const body = `<div class="wrap narrow block">
  <div class="section-head"><h2>קהילה</h2></div>
  <p class="lede">לכל אגף באתר יש קהילה משלו, ולכל ספר יש קוראי בטא. מי שמצטרף רואה טיוטות, הקלטות ופרקים שעוד לא יצאו, ויכול להגיב.</p>
  <div class="actions" style="margin-top:24px"><a class="btn primary" href="/join">בקשת הצטרפות</a><a class="btn" href="/login">כניסה</a></div>
</div>`;
    return render(env, v, { title: 'קהילה', description: 'הקהילות של יצחק שטרן.', path: '/community', body });
  }
  const feed = (await listFeed(env, acc, 60)).filter((x) => entryPath(acc, x) && (acc.owner || x.visibility !== 'public'));
  const mine = acc.spaces.filter((s) => acc.communities.has(s.id) && (s.ownCommunity || !s.parentId));
  const items = feed.length
    ? `<div class="feed">${feed
        .map((x) => {
          const w = wingOf(acc, x.spaceId);
          return `<a href="${entryPath(acc, x)}" data-wing="${e(w?.id ?? '')}"><span class="w">${e(w?.title ?? '')}</span><span class="t" dir="auto">${e(x.title)}</span><span class="d">${e(fmtDate(x.publishedAt))}</span></a>`;
        })
        .join('')}</div>`
    : '<p class="empty">עוד אין כאן תוכן לקהילה. בקרוב.</p>';
  const body = `<div class="wrap block">
  <div class="section-head"><h2>${member ? `שלום ${e(member.displayName)}` : 'קהילה'}</h2></div>
  ${!acc.owner ? `<p class="lede">${mine.length ? `את.ה ב${mine.map((s) => e(s.parentId ? s.title : `קהילת ה${s.title}`)).join(', ')}.` : 'עוד לא הצטרפת לאף אגף. בכל אגף יש כפתור לבקשת הצטרפות.'}</p>` : ''}
  <div class="section-head" style="margin-top:32px"><h2>רק לקהילה</h2></div>
  ${items}
</div>`;
  return render(env, v, { title: 'קהילה', path: '/community', body, noindex: true });
}
