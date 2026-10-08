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
import { entryFilter, canSee, inAny } from './spaces.js';
import { outsideOf, knows, pathOf } from './communities.js';
import { projectView } from './projects.js';
import { renderChords, hasChords, isSheet, textDir } from './chords.js';
import { mediaEmbed } from './media.js';
import { commentsBlock, commentsOf, canComment } from './comments.js';
import { projectFilesBlock } from './project-files.js';
import { movedTo } from './moves.js';
import { render, socials, WING_INFO, KIND_LABEL, LOCK, icon, fmtDate, badge, entryPath, spacePath, wingOf } from './site.js';
import { creditsLine, memberBlock } from './tagged.js';

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

// The published items in these spaces this viewer cannot open but may know
// about: how many, and the communities that would open them. Items open only
// to hidden communities stay out of it entirely.
async function lockedIn(env, acc, spaceIds) {
  if (acc.owner) return { n: 0, ids: [], members: false };
  const d = await db(env);
  const f = entryFilter(acc);
  const { results } = await d
    .prepare(
      `SELECT visibility, communities FROM entries WHERE status = 'published' AND kind != 'idea' AND visibility IN ('community', 'members')
       AND space_id IN (SELECT value FROM json_each(?)) AND NOT (${f.sql}) LIMIT 1000`,
    )
    .bind(JSON.stringify(spaceIds), ...f.args)
    .all();
  let n = 0;
  let members = false;
  const ids = new Set();
  for (const r of results) {
    if (r.visibility === 'members') {
      n++;
      members = true;
      continue;
    }
    const open = outsideOf(acc, JSON.parse(r.communities || '[]'));
    if (!open.length) continue;
    n++;
    for (const c of open) ids.add(c.id);
  }
  return { n, ids: [...ids], members };
}

// Where this viewer stands with these communities: what they are in, and a
// way to ask for the rest. Hidden communities never show to outsiders.
export function communityBox(v, ids, path, { members = false, intro = 'חלק מהדברים כאן פתוחים רק ל' } = {}) {
  const { acc } = v;
  if (acc.owner) return '';
  const outside = outsideOf(acc, ids);
  const inside = (ids ?? []).map((id) => acc.commById.get(id)).filter((c) => c && acc.communities.has(c.id));
  const link = (c) => `<a href="${pathOf(c)}">${e(c.title)}</a>`;
  const rows = outside.map((c) => {
    if (acc.pending.has(c.id)) return `<li>${link(c)} <span class="state">הבקשה מחכה לאישור</span></li>`;
    if (c.joinMode === 'closed') return `<li>${link(c)} <span class="state">נכנסים רק בהזמנה</span></li>`;
    if (v.member) return `<li>${link(c)} <button class="btn small accent" type="button" data-join="${e(c.id)}">בקשת הצטרפות</button><span class="msg" role="status"></span></li>`;
    return `<li>${link(c)} <a class="btn small accent" href="/join?community=${encodeURIComponent(c.id)}&next=${encodeURIComponent(path)}">בקשת הצטרפות</a></li>`;
  });
  const login = v.role === 'public' ? `<a class="btn small" href="/login?next=${encodeURIComponent(path)}">כבר בפנים? כניסה</a>` : '';
  if (rows.length) {
    return `<div class="community-box"><p>${intro}${outside.length === 1 ? 'קהילה' : 'קהילות'}:</p><ul class="community-list">${rows.join('')}</ul>${login}</div>`;
  }
  if (members && v.role === 'public') {
    return `<div class="community-box"><p>חלק מהדברים כאן פתוחים רק למי שנרשם.</p><a class="btn accent small" href="/join?next=${encodeURIComponent(path)}">הרשמה</a>${login}</div>`;
  }
  if (inside.length) return `<div class="community-box"><p>אתם ב${inside.map(link).join(', ')}, אז רואים כאן גם את מה שפתוח רק לכם.</p></div>`;
  return '';
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
  const chips = [(entry.kind === 'song' && entry.body.trim()) || isSheet(entry.body) ? 'אקורדים' : null, ...versionTypes(entry)].filter(Boolean);
  return `<a class="card" href="${href}">
  <span class="title" dir="auto">${e(entry.title)}</span>
  ${chips.length ? `<span class="chips">${chips.map((t) => `<span class="chip on">${e(t)}</span>`).join('')}</span>` : c.summary ? `<p dir="auto">${e(c.summary)}</p>` : ''}
  <span class="meta"><span>${e(KIND_LABEL[entry.kind] ?? '')}</span>${badge(entry, v)}</span>
</a>`;
}

const lockedNote = (n) => (n ? `<p class="lock">${LOCK} ${n === 1 ? 'עוד פריט אחד פתוח' : `עוד ${n} פריטים פתוחים`} רק לקהילות</p>` : '');

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
      const priv = s.visibility === 'private' ? ' · רק אני' : '';
      return `<a class="wing-tile" data-wing="${w.id}" href="/${w.id}">
  ${icon(info.icon)}
  <span class="name">${e(s.title)}</span>
  <span class="what">${e(s.summary || info.what)}</span>
  ${priv ? `<span class="who">${priv.slice(3)}</span>` : ''}
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
    : '<p class="empty">עוד לא העליתי כלום. בקרוב.</p>';
  const cta = v.member
    ? `<h2>שלום ${e(v.member.displayName)}</h2><p>בעמוד הקהילות רואים לאילו קהילות אתם שייכים ואפשר לבקש להצטרף לעוד.</p><a class="btn" href="/community">לקהילות</a>`
    : acc.owner
      ? `<h2>הסטודיו</h2><p>הטיוטות, הבקשות והתגובות מחכות שם.</p><a class="btn primary" href="/studio">לסטודיו</a>`
      : `<h2>רוצים לראות יותר?</h2><p>חלק מהדברים פתוחים רק לקהילות. מצטרפים, ואחרי שאני מאשר רואים גם אותם ואפשר להגיב.</p><div class="actions"><a class="btn primary" href="/community">הקהילות</a><a class="btn" href="/login">כניסה</a></div>`;
  const body = `<div class="wrap">
  <section class="hero">
    <div class="copy">
      <div class="kicker">שירים · ספרים · מערכונים · קוד · תורה</div>
      <h1>היי,<br>אני יצחק.</h1>
      <p class="lede">פה אני מעלה את מה שאני כותב, מנגן, מדבב ובונה. חלק פתוח לכולם. טיוטות, הקלטות גולמיות ופרקים שעוד לא יצאו פתוחים רק לקהילות.</p>
      <div class="actions"><a class="btn primary" href="/cv">קורות חיים ופרויקטים</a>${v.role === 'public' ? '<a class="btn" href="/join">בקשת הצטרפות</a>' : ''}</div>
    </div>
    ${links.length ? `<aside><span class="label">ברשתות</span>${links.map((s) => `<a href="${e(s.href)}" rel="me noopener">${e(s.label)} ↗</a>`).join('')}</aside>` : ''}
  </section>
  <section class="block">
    <div class="section-head"><h2>האגפים</h2></div>
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
    description: 'שירים, ספרים, מערכונים, דיבובים, דברי תורה, מאמרים ותוכנה של יצחק שטרן.',
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
  const [items, locked] = await Promise.all([listInSpace(env, acc, ids), lockedIn(env, acc, ids)]);
  const kids = children(acc, wingId);
  const shelf = kids.length
    ? `<section class="block"><div class="cards">${kids
        .map((k) => {
          const n = items.filter((x) => descendants(acc, k.id).includes(x.spaceId)).length;
          return `<a class="card${k.kind === 'book' ? ' book' : ''}" href="${spacePath(acc, k)}">
  <span class="title" dir="auto">${e(k.title)}</span>
  ${k.summary ? `<p dir="auto">${e(k.summary)}</p>` : ''}
  <span class="meta"><span>${e(SPACE_LABEL[k.kind] ?? '')}</span>${n ? `<span>${n === 1 ? 'פריט אחד' : `${n} פריטים`}</span>` : ''}${acc.owner && k.visibility !== 'public' ? `<span class="badge vis-${e(k.visibility)}">${k.visibility === 'private' ? 'רק אני' : k.visibility === 'members' ? 'לחברים' : 'לקהילות'}</span>` : ''}</span>
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
  <section class="block">${grid}${lockedNote(locked.n)}</section>
  ${communityBox(v, locked.ids, path, { members: locked.members })}
</div>`;
  return render(env, v, { title: wing.title, description: wing.summary || WING_INFO[wingId].what, path, wing: wingId, body, script: true });
}

const byOrder = (a, b) => (a.meta?.order ?? 1e9) - (b.meta?.order ?? 1e9) || String(a.publishedAt).localeCompare(String(b.publishedAt));

export async function spacePage(env, v, space) {
  const { acc } = v;
  const wing = wingOf(acc, space.id);
  const path = spacePath(acc, space);
  const ids = descendants(acc, space.id);
  const [items, lockedInfo] = await Promise.all([listInSpace(env, acc, ids), lockedIn(env, acc, ids)]);
  const locked = lockedInfo.n;
  // The communities this page answers to: its own, then whatever opens the locked items.
  const guards = [...new Set([...space.communities, ...lockedInfo.ids])];
  let body;
  if (space.kind === 'book') {
    const chapters = items.filter((x) => x.spaceId === space.id).sort(byOrder);
    const cover = space.meta?.cover && /^(https:\/\/|\/(?!\/))/.test(space.meta.cover) ? `<img src="${e(space.meta.cover)}" alt="">` : `<span class="t" dir="auto">${e(space.title)}</span><span>יצחק שטרן</span>`;
    const status = space.meta?.status ? `${e(space.meta.status)}` : 'ספר';
    const toc = chapters.length
      ? `<ol class="toc">${chapters
          .map((c, i) => `<li><a href="${entryPath(acc, c)}"><span dir="auto">${e(c.title)}</span><span class="n">${c.visibility === 'public' ? `פרק ${i + 1}` : `פרק ${i + 1} · לקוראי בטא`}</span></a></li>`)
          .join('')}${locked ? `<li><span class="locked"><span>${locked === 1 ? 'עוד פרק אחד' : `עוד ${locked} פרקים`}</span><span class="lock">${LOCK} לקוראי בטא</span></span></li>` : ''}</ol>`
      : locked
        ? `<p class="lock">${LOCK} ${locked === 1 ? 'פרק אחד פתוח' : `${locked} פרקים פתוחים`} לקוראי בטא</p>`
        : '<p class="empty">הפרקים בדרך.</p>';
    const asking = outsideOf(acc, guards).some((c) => c.joinMode === 'request' && !acc.pending.has(c.id));
    const beta = asking
      ? `<div class="panel tinted"><h2>קריאת בטא</h2><ol class="steps"><li>שולחים בקשה עם כמה מילים</li><li>אני מאשר</li><li>קוראים את כל הספר, גם פרקים חדשים כשהם עולים, ומגיבים על כל פרק</li></ol>${communityBox(v, guards, path, { members: lockedInfo.members })}</div>`
      : communityBox(v, guards, path, { members: lockedInfo.members });
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
  ${communityBox(v, guards, path, { members: lockedInfo.members })}
</div>`;
  }
  const noindex = space.visibility !== 'public';
  return render(env, v, { title: space.title, description: space.summary, path, wing: wing.id, body, noindex, script: true });
}

// ---------- one item ----------

function versionsBlock(v, entry) {
  const { acc } = v;
  const versions = Array.isArray(entry.meta?.versions) ? entry.meta.versions.filter((x) => x && typeof x.url === 'string') : [];
  const inCommunity = inAny(acc, entry.communities);
  // A locked version shows only when one of its communities is not hidden from this viewer.
  const showLock = outsideOf(acc, entry.communities).length > 0;
  const tabs = [];
  if ((entry.kind === 'song' && entry.body.trim()) || isSheet(entry.body)) {
    const chords = hasChords(entry.body);
    const tools = chords
      ? `<div class="tools" data-transpose><span>${entry.meta?.capo ? `קאפו ${e(entry.meta.capo)} · ` : ''}${entry.meta?.key ? `סולם ${e(entry.meta.key)} · ` : ''}טרנספוזיציה</span><button type="button" data-step="-1" aria-label="חצי טון למטה">−</button><output>0</output><button type="button" data-step="1" aria-label="חצי טון למעלה">+</button><button type="button" data-plain aria-pressed="false">בלי אקורדים</button></div>`
      : '';
    tabs.push({ label: chords ? 'מילים ואקורדים' : 'מילים', html: `<div class="sheet">${tools}${renderChords(entry.body)}</div>` });
  }
  for (const x of versions.slice(0, 20)) {
    const label = String(x.label || 'נגן').slice(0, 40);
    if (x.visibility === 'community' && !inCommunity) {
      if (showLock) tabs.push({ label, html: `<p class="lock">${LOCK} הגרסה הזאת פתוחה רק לקהילה</p>`, locked: true });
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
    const text = entry.kind !== 'song' && entry.body.trim() && !isSheet(entry.body) ? `<div class="${reading}" dir="${textDir(entry.body)}"${anchors}>${renderMarkdown(entry.body)}</div>` : '';
    main = `${versionsBlock(v, entry)}${text}${projectFilesBlock(v, entry)}`;
    if (entry.kind === 'chapter' || space.kind === 'series') {
      const { prev, next } = await siblings(env, v, entry);
      main += `<nav class="pager" aria-label="ניווט">${next ? `<a href="${entryPath(acc, next)}">→ ${e(next.title)}</a>` : '<span></span>'}${prev ? `<a href="${entryPath(acc, prev)}">${e(prev.title)} ←</a>` : '<span></span>'}</nav>`;
    }
  }
  const body = `<article class="wrap article">
  <header>
    ${header}
    ${await creditsLine(env, entry)}
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

// /<wing>/<a>[/<b>]: a space, or an item in the wing or in a space. An
// address an item moved away from sends the visitor on to where it lives now.
export async function resolve(env, v, wingId, a, b) {
  const page = await resolvePage(env, v, wingId, a, b);
  if (page) return page;
  const entry = await movedTo(env, v.acc, `/${[wingId, a, b].filter((x) => x !== undefined).join('/')}`);
  const to = entry && entryPath(v.acc, entry);
  if (!to) return null;
  const cache = v.role === 'public' && entry.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store';
  return new Response(null, { status: 301, headers: { Location: to, 'Cache-Control': cache, Vary: 'Cookie' } });
}

async function resolvePage(env, v, wingId, a, b) {
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

// /community: the communities a visitor may know about, where they stand in
// each, and for members what is new for them and where they were tagged.
export async function communityPage(env, v) {
  const { acc, member } = v;
  const shown = acc.comms.filter((c) => knows(acc, c));
  const mine = shown.filter((c) => !acc.owner && acc.communities.has(c.id));
  const others = shown.filter((c) => acc.owner || !acc.communities.has(c.id));
  const state = (c) => {
    if (acc.owner) return `<span class="state">${c.hidden ? 'נסתרת · ' : ''}${c.joinMode === 'closed' ? 'רק בהזמנה' : 'אפשר לבקש'}</span>`;
    if (acc.communities.has(c.id)) return '<span class="state">אתם בפנים</span>';
    if (acc.pending.has(c.id)) return '<span class="state">הבקשה מחכה לאישור</span>';
    if (c.joinMode === 'closed') return '<span class="state">נכנסים רק בהזמנה</span>';
    if (member) return `<button class="btn small accent" type="button" data-join="${e(c.id)}">בקשת הצטרפות</button><span class="msg" role="status"></span>`;
    return `<a class="btn small accent" href="/join?community=${encodeURIComponent(c.id)}">בקשת הצטרפות</a>`;
  };
  const cards = (list) =>
    `<div class="cards">${list
      .map(
        (c) => `<div class="card community-card">
  <a class="title" href="${pathOf(c)}" dir="auto">${e(c.title)}</a>
  ${c.summary ? `<p dir="auto">${e(c.summary)}</p>` : ''}
  <span class="meta">${state(c)}</span>
</div>`,
      )
      .join('')}</div>`;
  if (v.role === 'public') {
    const body = `<div class="wrap block">
  <div class="section-head"><h2>הקהילות</h2></div>
  <p class="lede">חלק ממה שאני יוצר פתוח רק לקהילות. מי שמצטרף רואה טיוטות, הקלטות ופרקים שעוד לא יצאו, ויכול להגיב.</p>
  ${others.length ? cards(others) : '<p class="empty">עוד אין קהילות פתוחות. בקרוב.</p>'}
  <div class="actions" style="margin-top:24px"><a class="btn" href="/join">הרשמה</a><a class="btn" href="/login">כבר בפנים? כניסה</a></div>
</div>`;
    return render(env, v, { title: 'קהילות', description: 'הקהילות של יצחק שטרן.', path: '/community', body, script: true });
  }
  const feed = (await listFeed(env, acc, 60)).filter((x) => entryPath(acc, x) && (acc.owner || x.visibility !== 'public'));
  const items = feed.length
    ? `<div class="feed">${feed
        .map((x) => {
          const w = wingOf(acc, x.spaceId);
          return `<a href="${entryPath(acc, x)}" data-wing="${e(w?.id ?? '')}"><span class="w">${e(w?.title ?? '')}</span><span class="t" dir="auto">${e(x.title)}</span><span class="d">${e(fmtDate(x.publishedAt))}</span></a>`;
        })
        .join('')}</div>`
    : '<p class="empty">עוד אין כאן כלום שפתוח רק לכם. בקרוב.</p>';
  const body = `<div class="wrap block">
  <div class="section-head"><h2>${member ? `שלום ${e(member.displayName)}` : 'הקהילות'}</h2>${acc.owner ? '<a class="btn small" href="/studio#communities">ניהול</a>' : ''}</div>
  ${mine.length ? `<div class="section-head"><h2>הקהילות שלכם</h2></div>${cards(mine)}` : !acc.owner ? '<p class="lede">עוד לא הצטרפתם לאף קהילה.</p>' : ''}
  ${others.length ? `<div class="section-head" style="margin-top:32px"><h2>${acc.owner ? 'כל הקהילות' : 'עוד קהילות'}</h2></div>${cards(others)}` : ''}
  ${await memberBlock(env, v)}
  <div class="section-head" style="margin-top:32px"><h2>רק לכם</h2></div>
  ${items}
</div>`;
  return render(env, v, { title: 'קהילות', path: '/community', body, noindex: true, script: true });
}
