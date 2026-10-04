// The CV at /cv: one page for recruiters, rendered on the server from the
// owner's "cv" setting (edited in the studio's CV view) plus the projects and
// platform items he picked for it. Until he edits it, the setting is empty and
// the defaults below are exactly what the page said before it became editable.
//
// Projects keep their CV flags on the entries (meta.cv.show / meta.cv.order), so
// the project editor's checkbox and this page edit the same thing.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { safeUrl, excerpt } from './markdown.js';
import { saveEntry } from './entries.js';
import { projectView } from './projects.js';
import { access, isPublicEntry } from './spaces.js';
import { CV_PROJECTS } from './cv-seed.js';
import { LEGACY_FLAG, importLegacyData } from './settings.js';
import { renderCvPage } from './cv-page.js';

const b = (he, en) => ({ he, en });

export const SECTION_IDS = ['code', 'music', 'voice', 'sketches', 'writing', 'about', 'contact'];
// Sections that list items from the platform's wings.
export const ITEM_SECTIONS = ['music', 'voice', 'sketches', 'writing'];

export const DEFAULT_CV = {
  name: b('יצחק שטרן', 'Itschak Shteren'),
  avail: b('פנוי לעבודה מדצמבר 2026', 'Available from December 2026'),
  roles: [
    b('מפתח Full-Stack', 'Full-stack developer'),
    b('מוזיקאי', 'Musician'),
    b('כותב', 'Writer'),
    b('מדבב', 'Voice actor'),
    b('יוצר מערכונים', 'Sketch comedy'),
  ],
  lede: b(
    'בשנתיים האחרונות אני בונה מערכות פרודקשן בחיל האוויר: אימות משתמשים בארכיטקטורה של 8 שירותים, תכנון מחדש של אלגוריתמים ותשתית רגרסיה שמאמתת כ־120,000 מקרים הנדסיים.',
    'For the last two years I have built production systems in the Israeli Air Force: authentication across an 8-service architecture, algorithm redesigns, and a regression framework that validates about 120,000 engineering cases.',
  ),
  buttons: [
    { label: b('לפרויקטים', 'See projects'), href: '#code' },
    { label: b('GitHub', 'GitHub'), href: 'https://github.com/IzikStar' },
    { label: b('LinkedIn', 'LinkedIn'), href: 'https://www.linkedin.com/in/itschak-shteren-0b7a59313' },
  ],
  about: b(
    'אני מפתח Full-Stack. בשנתיים האחרונות כתבתי קוד שרץ בפרודקשן בחיל האוויר, בעיקר ב־TypeScript, React, NestJS, Java ו־PostgreSQL. הכי נהניתי לעבוד על התחברות והרשאות, על אלגוריתמים ועל בדיקות. חוץ מקוד אני גם כותב, מנגן, מדבב ועושה עוד כל מיני שטויות 😝',
    "I'm a full-stack developer. For the last two years I wrote production code in the Israeli Air Force, mostly in TypeScript, React, NestJS, Java and PostgreSQL. The parts I enjoyed most were login and permissions, algorithms and tests. Outside code I also write, play music, do voice acting and all sorts of other nonsense 😝",
  ),
  skills: ['TypeScript', 'JavaScript', 'Java', 'SQL', 'React', 'Redux Toolkit', 'NestJS', 'Node.js', 'Spring Boot', 'PostgreSQL', 'Redis', 'JWT / OAuth 2.0 / SSO', 'Docker', 'OpenShift'],
  timeline: [
    { when: b('2024 עד 2026', '2024 to 2026'), what: b('מפתח Full-Stack, חיל האוויר', 'Full-stack developer, Israeli Air Force'), detail: b('', '') },
    { when: b('דצמבר 2026', 'December 2026'), what: b('פנוי לתפקיד הבא', 'Open to the next role'), detail: b('Full-Stack או Backend', 'Full-stack or backend') },
  ],
  email: 'itschakme@gmail.com',
  contact: [
    { label: b('LinkedIn', 'LinkedIn'), href: 'https://www.linkedin.com/in/itschak-shteren-0b7a59313' },
    { label: b('GitHub', 'GitHub'), href: 'https://github.com/IzikStar' },
  ],
  footer: b('בניתי את העמוד בעצמי, עם HTML, CSS ו־Cloudflare Workers.', 'Hand-built with HTML, CSS and Cloudflare Workers.'),
  sections: [
    { id: 'code', show: true, title: b('פרויקטים', 'Projects'), nav: b('קוד', 'Code'), intro: b('קוד פתוח ב־GitHub, חוץ ממה שמסומן אחרת', 'Open source on GitHub unless noted') },
    { id: 'music', show: true, title: b('מוזיקה', 'Music'), nav: b('מוזיקה', 'Music'), intro: b('', '') },
    { id: 'voice', show: true, title: b('דיבוב', 'Voice acting'), nav: b('דיבוב', 'Voice'), intro: b('', '') },
    { id: 'sketches', show: true, title: b('מערכונים', 'Sketches'), nav: b('מערכונים', 'Sketches'), intro: b('', '') },
    { id: 'writing', show: true, title: b('כתיבה', 'Writing'), nav: b('כתיבה', 'Writing'), intro: b('', '') },
    { id: 'about', show: true, title: b('עליי', 'About'), nav: b('עליי', 'About'), intro: b('', '') },
    { id: 'contact', show: true, title: b('יצירת קשר', 'Contact'), nav: b('יצירת קשר', 'Contact'), intro: b('', '') },
  ],
};

// ---------- reading and cleaning the setting ----------

const bi = (v, max) => ({ he: cleanText(v?.he, max), en: cleanText(v?.en, max) });

// Addresses on the CV: web pages, mail, a section of the page (#about) or a
// page on this site (/music) when the owner wants to link there.
function href(value, what) {
  const raw = cleanText(value, 500);
  if (!raw) return '';
  const url = safeUrl(raw);
  if (!url) throw new HttpError(400, `"${raw}" (${what}) is not a link the CV can use. Use https://, mailto:, #section or /page.`);
  return url;
}

const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const ids = (v) => [...new Set(list(v, 60).map((x) => String(x ?? '')).filter((x) => /^[a-z0-9-]{1,64}$/.test(x)))];

// Whatever the studio sends, cleaned. Missing fields keep their defaults.
export function cleanCv(body) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const k of ['name', 'avail', 'lede', 'footer']) if (k in src) out[k] = bi(src[k], k === 'lede' ? 1200 : 200);
  if ('about' in src) out.about = bi(src.about, 5000);
  if ('roles' in src) out.roles = list(src.roles, 10).map((r) => bi(r, 80)).filter((r) => r.he || r.en);
  if ('buttons' in src) {
    out.buttons = list(src.buttons, 8)
      .map((x) => ({ label: bi(x?.label, 60), href: href(x?.href, 'button') }))
      .filter((x) => (x.label.he || x.label.en) && x.href);
  }
  if ('contact' in src) {
    out.contact = list(src.contact, 12)
      .map((x) => ({ label: bi(x?.label, 60), href: href(x?.href, 'contact link') }))
      .filter((x) => (x.label.he || x.label.en) && x.href);
  }
  if ('skills' in src) out.skills = [...new Set(list(src.skills, 80).map((s) => cleanText(s, 60)).filter(Boolean))];
  if ('timeline' in src) {
    out.timeline = list(src.timeline, 40)
      .map((x) => ({ when: bi(x?.when, 80), what: bi(x?.what, 200), detail: bi(x?.detail, 400) }))
      .filter((x) => x.when.he || x.when.en || x.what.he || x.what.en);
  }
  if ('email' in src) {
    const email = cleanText(src.email, 200);
    if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw new HttpError(400, 'That email address does not look right.');
    out.email = email;
  }
  if ('sections' in src) {
    const seen = new Set();
    out.sections = [];
    for (const s of list(src.sections, 20)) {
      if (!SECTION_IDS.includes(s?.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      out.sections.push({ id: s.id, show: s.show !== false, title: bi(s.title, 80), nav: bi(s.nav, 40), intro: bi(s.intro, 1000) });
    }
    // A section the client forgot keeps its default place at the end.
    for (const d of DEFAULT_CV.sections) if (!seen.has(d.id)) out.sections.push(structuredClone(d));
  }
  if ('items' in src && src.items && typeof src.items === 'object') {
    out.items = {};
    for (const s of ITEM_SECTIONS) if (Array.isArray(src.items[s])) out.items[s] = ids(src.items[s]);
  }
  return out;
}

async function readSetting(env, key) {
  const d = await db(env);
  const row = await d.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function writeSetting(env, key, value) {
  const d = await db(env);
  await d.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, JSON.stringify(value)).run();
}

// The stored setting over the defaults. A section keeps default titles for
// any language the owner left empty.
export function mergeCv(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const cv = structuredClone(DEFAULT_CV);
  for (const k of Object.keys(DEFAULT_CV)) if (k !== 'sections' && k in s) cv[k] = s[k];
  if (Array.isArray(s.sections)) {
    cv.sections = s.sections.map((x) => {
      const d = DEFAULT_CV.sections.find((y) => y.id === x.id);
      return { ...x, title: { he: x.title?.he || d.title.he, en: x.title?.en || d.title.en } };
    });
  }
  cv.items = s.items && typeof s.items === 'object' ? s.items : {};
  return cv;
}

export async function getCv(env) {
  return mergeCv(await readSetting(env, 'cv'));
}

// ---------- what goes on the page ----------

const rowToEntry = (r) => ({
  id: r.id,
  kind: r.kind,
  spaceId: r.space_id ?? null,
  slug: r.slug,
  title: r.title,
  summary: r.summary,
  body: r.body,
  visibility: r.visibility,
  status: r.status,
  tags: JSON.parse(r.tags || '[]'),
  meta: JSON.parse(r.meta || '{}'),
  pinned: Boolean(r.pinned),
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  publishedAt: r.published_at,
});

// Where items moved from the old admin page land by default (its sections).
const LEGACY_SECTION = { song: 'music', dub: 'voice', sketch: 'sketches', article: 'writing' };

function legacyDefaults(entries) {
  const out = Object.fromEntries(ITEM_SECTIONS.map((s) => [s, []]));
  const old = entries
    .filter((x) => x.meta?.legacy?.id)
    .sort((a, b) => (a.meta.legacy.order ?? 1e9) - (b.meta.legacy.order ?? 1e9) || String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const x of old) {
    const section = x.meta.legacy.section ?? LEGACY_SECTION[x.kind];
    if (out[section]) out[section].push(x.id);
  }
  return out;
}

const seedProjects = () =>
  CV_PROJECTS.map((p, i) =>
    projectView({ id: `seed-${i}`, kind: 'project', slug: '', title: p.title, summary: p.summary, body: '', tags: p.tags, meta: p.meta, updatedAt: '' }),
  );

const onCv = (entries) =>
  entries
    .filter((x) => (x.kind === 'project' || x.kind === 'work') && x.meta?.cv?.show)
    .sort((a, b) => (a.meta.cv.order ?? 999) - (b.meta.cv.order ?? 999))
    .map((x) => x.id);

// The address an item may link to from the CV: the web, or a file on this site.
// Pages of the platform are left out so the CV stays on its own.
function outward(url) {
  const u = safeUrl(url);
  if (!u) return null;
  if (/^https?:\/\//.test(u) || /^\/files\/[a-z0-9-]+$/.test(u)) return u;
  return null;
}

export function itemView(entry) {
  const m = entry.meta ?? {};
  const body = String(entry.body ?? '');
  const versions = (Array.isArray(m.versions) ? m.versions : [])
    .filter((v) => v && typeof v.url === 'string' && v.visibility !== 'community')
    .map((v) => ({ label: cleanText(v.label, 40), url: outward(v.url), kind: v.kind === 'audio' || v.kind === 'video' ? v.kind : '' }))
    .filter((v) => v.url)
    .slice(0, 6);
  const images = [...body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map((x) => outward(x[1])).filter(Boolean);
  const links = [...body.matchAll(/(?<!!)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)]
    .map((x) => ({ label: cleanText(x[1], 60), href: outward(x[2]) }))
    .filter((l) => l.href)
    .slice(0, 3);
  return {
    id: entry.id,
    title: entry.title || 'בלי כותרת',
    summary: entry.summary || excerpt(body, 220),
    cover: outward(m.cover) || images[0] || '',
    versions,
    links,
  };
}

// Everything the page needs. draft = an unsaved CV from the studio's preview
// (its projects list included); without it, the saved setting.
export async function cvData(env, draft = null) {
  const d = await db(env);
  const cv = draft ? mergeCv(draft) : await getCv(env);
  const { results } = await d.prepare(`SELECT * FROM entries WHERE kind != 'idea'`).all();
  const entries = results.map(rowToEntry);
  const acc = await access(env, { role: 'public', member: null });
  const byId = new Map(entries.map((x) => [x.id, x]));
  const shows = (x) => x && isPublicEntry(acc, x);

  const projectEntries = entries.filter((x) => x.kind === 'project' || x.kind === 'work');
  const projectIds = draft && Array.isArray(draft.projects) ? ids(draft.projects) : onCv(entries);
  const projects = projectEntries.length
    ? projectIds.map((id) => byId.get(id)).filter((x) => shows(x) && (x.kind === 'project' || x.kind === 'work')).map(projectView)
    : seedProjects();

  const fallback = legacyDefaults(entries);
  const picked = {};
  const items = {};
  for (const s of ITEM_SECTIONS) {
    picked[s] = Array.isArray(cv.items[s]) ? cv.items[s] : fallback[s];
    items[s] = picked[s].map((id) => byId.get(id)).filter((x) => shows(x) && x.kind !== 'project').map(itemView);
  }
  return { cv, projects, items, picked, projectIds, entries, acc, seeded: !projectEntries.length };
}

// ---------- the page ----------

const COOKIE = 'cv_lang';

function pickLang(request, url) {
  const q = url.searchParams.get('lang');
  if (q === 'he' || q === 'en') return q;
  const cookie = (request.headers.get('Cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=(he|en)`));
  if (cookie) return cookie[1];
  const accept = request.headers.get('Accept-Language');
  if (!accept) return 'he';
  return /^\s*(he|iw)\b/i.test(accept) ? 'he' : 'en';
}

export async function cvPage(request, env, url) {
  const lang = pickLang(request, url);
  const data = await cvData(env);
  return new Response(renderCvPage({ ...data, lang }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Edits in the studio should show on the next visit.
      'Cache-Control': 'no-cache',
      Vary: 'Cookie, Accept-Language',
      'Content-Language': lang,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    },
  });
}

// ---------- studio ----------

const KIND_SECTION = { song: 'music', dub: 'voice', humor: 'voice', sketch: 'sketches', article: 'writing', torah: 'writing', chapter: 'writing', video: 'sketches' };

async function studioPayload(env) {
  const data = await cvData(env);
  const { cv, picked, projectIds, entries, acc, seeded } = data;
  return {
    cv: { ...cv, items: picked, projects: projectIds },
    defaults: structuredClone(DEFAULT_CV),
    entries: entries
      .map((x) => ({
        id: x.id,
        kind: x.kind,
        spaceId: x.spaceId,
        title: x.title || x.meta?.synced?.name || '',
        status: x.status,
        visibility: x.visibility,
        shows: isPublicEntry(acc, x),
        section: x.kind === 'project' || x.kind === 'work' ? 'code' : KIND_SECTION[x.kind] ?? null,
        updatedAt: x.updatedAt,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    seeded,
    legacy: await readSetting(env, LEGACY_FLAG),
  };
}

export async function studioCv(env) {
  return json(await studioPayload(env));
}

export async function saveCv(request, env) {
  const body = await readJson(request);
  const clean = cleanCv(body.cv ?? body);
  const stored = (await readSetting(env, 'cv')) ?? {};
  const next = { ...stored, ...clean };
  if (clean.items) next.items = { ...(stored.items ?? {}), ...clean.items };
  await writeSetting(env, 'cv', next);

  // The projects list lives on the entries: show and order what was sent, hide the rest.
  const sent = body.cv?.projects ?? body.projects;
  if (Array.isArray(sent)) {
    const order = ids(sent);
    const d = await db(env);
    const { results } = await d.prepare(`SELECT * FROM entries WHERE kind IN ('project', 'work')`).all();
    for (const entry of results.map(rowToEntry)) {
      const i = order.indexOf(entry.id);
      const cv = entry.meta.cv ?? {};
      const want = i >= 0 ? { show: true, order: i + 1 } : { show: false, order: cv.order ?? 999 };
      if (Boolean(cv.show) === want.show && (!want.show || cv.order === want.order)) continue;
      entry.meta = { ...entry.meta, cv: want };
      await saveEntry(env, entry);
    }
  }
  return json(await studioPayload(env));
}

// The page as it would look with the studio's unsaved form.
export async function previewCv(request, env) {
  const body = await readJson(request);
  const draft = { ...cleanCv(body.cv ?? {}), projects: body.cv?.projects };
  const lang = body.lang === 'en' ? 'en' : 'he';
  const data = await cvData(env, draft);
  return json({ html: renderCvPage({ ...data, lang, preview: true }) });
}

// ---------- moving off the old admin page ----------

let legacyDone = false;

// The old admin page's section switches and intro lines become the CV's
// starting point, so nothing visible changes when the old routes go away.
export async function seedFromOldSettings(env) {
  if (await readSetting(env, 'cv')) return false;
  const old = await env.MEDIA?.get('settings', 'json');
  if (!old || typeof old !== 'object') return false;
  const sections = structuredClone(DEFAULT_CV.sections);
  for (const s of sections) {
    if (old.sections?.[s.id] === false) s.show = false;
    const intro = typeof old.intros?.[s.id] === 'string' ? cleanText(old.intros[s.id], 1000) : '';
    if (intro) s.intro = { he: intro, en: intro };
  }
  const roleFor = ['code', 'music', 'writing', 'voice', 'sketches'];
  const roles = DEFAULT_CV.roles.filter((_, i) => old.sections?.[roleFor[i]] !== false);
  await writeSetting(env, 'cv', { sections, roles });
  return true;
}

// Runs importLegacy once, the first time anything asks after a deploy (the
// cron, the owner's studio or a visit to /cv). The flag is claimed first so
// two requests never import side by side; a failed run gives the claim back.
// Nothing in KV is deleted.
export async function importLegacyOnce(env) {
  if (legacyDone || !env.MEDIA || !env.DB) return null;
  const d = await db(env);
  const flag = await readSetting(env, LEGACY_FLAG);
  if (flag?.state === 'done') {
    legacyDone = true;
    return null;
  }
  const now = new Date().toISOString();
  const stale = flag?.state === 'running' && Date.now() - Date.parse(flag.at) > 15 * 60_000;
  const claim = stale
    ? await d.prepare(`UPDATE settings SET value = ? WHERE key = ? AND value = ?`).bind(JSON.stringify({ state: 'running', at: now }), LEGACY_FLAG, JSON.stringify(flag)).run()
    : await d.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).bind(LEGACY_FLAG, JSON.stringify({ state: 'running', at: now })).run();
  if (!claim.meta.changes) return null;
  try {
    const result = await importLegacyData(env);
    await seedFromOldSettings(env);
    const done = { state: 'done', at: new Date().toISOString(), created: result.created.length, skipped: result.skipped, total: result.total };
    await writeSetting(env, LEGACY_FLAG, done);
    legacyDone = true;
    return done;
  } catch (err) {
    console.error('legacy import failed', err);
    await d.prepare(`DELETE FROM settings WHERE key = ?`).bind(LEGACY_FLAG).run();
    return { state: 'failed', error: String(err?.message ?? err) };
  }
}

// For tests: forget that this worker instance already saw the flag.
export function _resetLegacyMemo() {
  legacyDone = false;
}
