// Projects: entries of kind "project" (code) or "work" (anything else). Each
// can point at a source, a GitHub repo or any web page, and the site pulls
// details from it: on demand from the studio and once a day from the cron.
// What the owner typed always wins over what was pulled.
import { db } from './db.js';
import { HttpError, json } from './http.js';
import { getEntry, saveEntry, slugify } from './entries.js';
import { CV_PROJECTS } from './cv-seed.js';

const UA = 'itschakshteren.com (personal site sync)';
const MAX_README = 100_000;
const MAX_PAGE = 512 * 1024;

// ---------- sources ----------

async function github(env, path, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept, 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new HttpError(502, 'GitHub is rate-limiting the site right now. Try again later, or add a GITHUB_TOKEN secret.');
  if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status}.`);
  return accept.includes('raw') ? res.text() : res.json();
}

async function fromGithub(env, repo) {
  const info = await github(env, `/repos/${repo}`);
  if (!info) throw new HttpError(404, env.GITHUB_TOKEN ? 'GitHub has no such repo, or the token cannot see it.' : 'GitHub has no such public repo. Private repos need a GITHUB_TOKEN secret.');
  const [languages, readme] = await Promise.all([
    github(env, `/repos/${repo}/languages`).catch(() => null),
    github(env, `/repos/${repo}/readme`, 'application/vnd.github.raw+json').catch(() => null),
  ]);
  return {
    name: info.name,
    description: info.description ?? '',
    topics: info.topics ?? [],
    homepage: info.homepage ?? '',
    url: info.html_url,
    private: Boolean(info.private),
    stars: info.stargazers_count ?? 0,
    pushedAt: info.pushed_at ?? null,
    branch: info.default_branch ?? 'HEAD',
    languages: Object.keys(languages ?? {}),
    readme: typeof readme === 'string' ? readme.slice(0, MAX_README) : '',
  };
}

function metaTag(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? '';
}

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

async function fromUrl(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new HttpError(502, `The page answered ${res.status}.`);
  const html = (await res.text()).slice(0, MAX_PAGE);
  const abs = (v) => {
    try {
      return v ? new URL(v, res.url || url).href : '';
    } catch {
      return '';
    }
  };
  return {
    name: decode(metaTag(html, 'og:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || ''),
    description: decode(metaTag(html, 'og:description') || metaTag(html, 'description')),
    image: abs(decode(metaTag(html, 'og:image'))),
    url: res.url || url,
  };
}

export async function syncEntry(env, entry) {
  const source = entry.meta?.source;
  if (!source) throw new HttpError(400, 'This item has no source to sync from.');
  const pulled = source.type === 'github' ? await fromGithub(env, source.repo) : await fromUrl(source.url);
  entry.meta = { ...entry.meta, synced: { ...pulled, syncedAt: new Date().toISOString() } };
  delete entry.meta.syncError;
  return saveEntry(env, entry);
}

export async function syncOne(env, id) {
  const entry = await getEntry(env, id);
  if (!entry) throw new HttpError(404, 'That item no longer exists.');
  return json(await syncEntry(env, entry));
}

// Cron: refresh every item that has a source, one at a time, keeping errors on the item.
export async function syncAll(env) {
  const d = await db(env);
  const { results } = await d.prepare(`SELECT id FROM entries WHERE meta LIKE '%"source":{%'`).all();
  let ok = 0;
  for (const { id } of results) {
    const entry = await getEntry(env, id);
    if (!entry?.meta?.source) continue;
    try {
      await syncEntry(env, entry);
      ok++;
    } catch (err) {
      entry.meta = { ...entry.meta, syncError: String(err?.message ?? err) };
      await saveEntry(env, entry).catch(() => {});
    }
  }
  return { checked: results.length, ok };
}

// ---------- what visitors see ----------

const LINK_KINDS = ['code', 'live', 'playGame'];

// Owner fields first, synced fields as the fallback.
export function projectView(entry) {
  const m = entry.meta ?? {};
  const s = m.synced ?? {};
  const links = (m.links ?? []).filter((l) => LINK_KINDS.includes(l.k) && /^https?:\/\//.test(l.href));
  if (m.source?.type === 'github' && !s.private && s.url && !links.some((l) => l.k === 'code')) links.push({ k: 'code', href: s.url });
  if (s.homepage && /^https?:\/\//.test(s.homepage) && !links.some((l) => l.k === 'live' || l.k === 'playGame')) links.unshift({ k: 'live', href: s.homepage });
  const stack = entry.tags.length ? entry.tags : (s.topics?.length ? s.topics : s.languages ?? []);
  return {
    id: entry.id,
    kind: entry.kind,
    slug: entry.slug,
    name: { he: entry.title || s.name || '', en: m.en?.title || entry.title || s.name || '' },
    text: { he: entry.summary || s.description || '', en: m.en?.summary || s.description || entry.summary || '' },
    tag: { he: m.tag ?? '', en: m.en?.tag || m.tag || '' },
    note: m.note || m.en?.note ? { he: m.note ?? '', en: m.en?.note || m.note || '' } : null,
    stack,
    img: [m.image, s.image].find((u) => typeof u === 'string' && (/^https?:\/\//.test(u) || /^\/(?!\/)/.test(u))) ?? '',
    facts: Array.isArray(m.facts) ? m.facts : [],
    links,
    updatedAt: s.pushedAt || entry.updatedAt,
    hasPage: Boolean(entry.body.trim() || s.readme),
  };
}

// The projects the CV page shows, in the owner's order.
export async function cvProjects(env) {
  const d = await db(env);
  const { results } = await d
    .prepare(`SELECT * FROM entries WHERE kind IN ('project', 'work') AND status = 'published' AND visibility = 'public'`)
    .all();
  const rows = results
    .map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]'), meta: JSON.parse(r.meta || '{}') }))
    .filter((r) => r.meta.cv?.show)
    .sort((a, b) => (a.meta.cv.order ?? 999) - (b.meta.cv.order ?? 999));
  const projects = rows.map((r) => projectView({ ...r, title: r.title, summary: r.summary, body: r.body, updatedAt: r.updated_at }));
  return json({ projects }, 200, { 'Cache-Control': 'public, max-age=60' });
}

// ---------- one-time import of the CV's projects ----------

export async function importCv(env) {
  const d = await db(env);
  let created = 0;
  for (const p of CV_PROJECTS) {
    const slug = slugify(p.meta.en.title);
    const exists = await d.prepare(`SELECT id FROM entries WHERE kind = 'project' AND slug = ?`).bind(slug).first();
    if (exists) continue;
    const now = new Date().toISOString();
    await saveEntry(
      env,
      {
        id: crypto.randomUUID(),
        kind: 'project',
        spaceId: 'software',
        slug,
        title: p.title,
        summary: p.summary,
        body: '',
        visibility: 'public',
        status: 'published',
        tags: p.tags,
        meta: p.meta,
        pinned: false,
        source: 'import',
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
      },
      true,
    );
    created++;
  }
  return json({ created, total: CV_PROJECTS.length });
}
