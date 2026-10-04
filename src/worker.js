// Site worker: serves the static site (ASSETS), the platform (studio API,
// server-rendered home, wing and item pages; data in D1, see src/db.js) and the older API
// for the portfolio's creative sections (music, voice acting, sketches, writing).
// KV layout:
//   "items"         JSON list of every uploaded item, in display order
//   "settings"      JSON { sections: { [name]: boolean }, intros: { [name]: string } }
//   "file:<id>"     the item's file (audio, video, image or PDF)
//   "cover:<id>"    optional cover image
//
// Required bindings/secrets (see wrangler.toml and README):
//   MEDIA          KV namespace
//   DB             D1 database (platform entries, members, invites)
//   ADMIN_PASSWORD secret, the only way into the admin page

import { HttpError, json, readJson, cleanText, checkOrigin } from './http.js';
import { login, logout, isOwner, requireOwner } from './auth.js';
import { studioList, studioCreate, studioUpdate, studioDelete, getEntry, preview, publicList } from './entries.js';
import { home, wingPage, resolve, communityPage } from './wings.js';
import { WINGS } from './db.js';
import { syncOne, syncAll, cvProjects, importCv } from './projects.js';
import { currentMember, checkInvite, join, memberLogin, memberLogout, me, listCommunity, setMemberStatus, removeMember, createInvite, revokeInvite } from './members.js';
import { serveBytes } from './bytes.js';
import { access, listSpaces, requestJoin, studioSpaces, createSpace, updateSpace, deleteSpace, spaceMembers, decideMember } from './spaces.js';
import { postComment, deleteComment, studioComments, setCommentStatus, deleteCommentsOf } from './comments.js';
import { getSettings as studioSettings, saveSocials, importLegacy } from './settings.js';
import { uploadFile, listFiles, deleteFile, deleteFilesOf, serveFile } from './files.js';
import { moveEntries } from './moves.js';
import { previewPage, linkInfo } from './studio-tools.js';
import { MAX_FILE_BYTES, MAX_COVER_BYTES, SECTIONS, MEDIA_SECTIONS, fileKind, isCoverType } from './limits.js';
import { blogRoute, createPost, editPost, deletePost, studioPosts, moderatePost } from './blog.js';
import { people } from './mentions.js';

// The main address. The other custom domains (and www.) redirect here;
// the workers.dev address keeps working as is.
const CANONICAL_HOST = 'itschakshteren.com';
const REDIRECT_HOSTS = ['www.itschakshteren.com', 'izikstar.com', 'www.izikstar.com'];

export default {
  // Daily: refresh every project that has a source (see wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env).then((r) => console.log('source sync', r)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (REDIRECT_HOSTS.includes(url.hostname)) {
      return Response.redirect(`https://${CANONICAL_HOST}${url.pathname}${url.search}`, 301);
    }
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      const page = await pages(request, env, url);
      if (page) return page;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

// Server-rendered platform pages. Returns null to fall through to static assets.
async function pages(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = url.pathname;
  if (path === '/') return home(env, await viewer(request, env));
  // The CV (the static portfolio page) lives at /cv; the home page is the platform.
  // The static asset layer serves public/cv.html at /cv (asking it for /index.html would redirect to /).
  if (path === '/cv') return env.ASSETS.fetch(request);
  if (path === '/cv/' || path === '/index.html') return Response.redirect(`${url.origin}/cv`, 301);
  // Older addresses.
  const old = path.match(/^\/(writing|work)(\/.*)?$/);
  if (old) return Response.redirect(`${url.origin}/${old[1] === 'writing' ? 'articles' : 'software'}${old[2] ?? ''}`, 301);
  if (path === '/community') return communityPage(env, await viewer(request, env));
  const f = path.match(/^\/files\/([a-z0-9-]+)$/);
  if (f) return (await serveFile(request, env, (await viewer(request, env)).acc, f[1])) ?? notFound(request, env);

  const parts = path.split('/').slice(1);
  if (!WINGS.some((w) => w.id === parts[0]) || parts.length > 4 || parts.some((x) => !x)) return null;
  let slugs;
  try {
    slugs = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const v = await viewer(request, env);
  // A community's blog: /<wing>/blog[/<post>] or /<wing>/<space>/blog[/<post>].
  const blog = await blogRoute(env, v, slugs);
  if (blog !== undefined) return blog ?? notFound(request, env);
  if (slugs.length > 3) return null;
  const page = slugs.length === 1 ? await wingPage(env, v, slugs[0]) : await resolve(env, v, ...slugs);
  return page ?? notFound(request, env);
}

// Who is asking (the owner, a signed-in member, or the public) and what they may open.
async function viewer(request, env) {
  let v;
  if (await isOwner(request, env)) v = { role: 'owner', member: null };
  else {
    const member = await currentMember(request, env);
    v = member ? { role: 'member', member } : { role: 'public', member: null };
  }
  v.acc = await access(env, v);
  return v;
}

async function notFound(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/404.html', request.url)));
  return new Response(res.body, { status: 404, headers: res.headers });
}

async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/site' && method === 'GET') {
    const [settings, items] = await Promise.all([getSettings(env), listItems(env)]);
    const visible = items.filter((i) => !i.hidden && settings.sections[i.section]).map(publicItem);
    return json({ sections: settings.sections, intros: settings.intros, items: visible }, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  }

  if (path === '/api/cv-projects' && method === 'GET') return cvProjects(env);
  if (path === '/api/entries' && method === 'GET') {
    const v = await viewer(request, env);
    return publicList(env, v.acc, v.role === 'public', url);
  }
  if (path === '/api/spaces' && method === 'GET') return listSpaces(env, (await viewer(request, env)).acc);
  if (path.startsWith('/api/studio/')) return studio(request, env, url);
  if (path.startsWith('/api/comments')) {
    if (method !== 'GET') checkOrigin(request, url);
    if (path === '/api/comments' && method === 'POST') return postComment(request, env, await viewer(request, env));
    const cm = path.match(/^\/api\/comments\/([a-z0-9-]+)$/);
    if (cm && method === 'DELETE') return deleteComment(env, await viewer(request, env), cm[1]);
    throw new HttpError(404, 'Not found.');
  }
  if (path.startsWith('/api/member/')) return memberApi(request, env, url);
  if (path.startsWith('/api/blog/') || path === '/api/people') return blogApi(request, env, url);

  let m = path.match(/^\/api\/(file|cover)\/([a-z0-9-]+)$/);
  if (m && (method === 'GET' || method === 'HEAD')) return media(request, env, m[1], m[2]);

  if (!path.startsWith('/api/admin/')) throw new HttpError(404, 'Not found.');

  // Everything below changes state or reveals hidden items.
  if (method !== 'GET') checkOrigin(request, url);

  if (path === '/api/admin/login' && method === 'POST') return login(request, env);
  if (path === '/api/admin/logout' && method === 'POST') return logout();

  await requireOwner(request, env);

  if (path === '/api/admin/session' && method === 'GET') return json({ ok: true });
  if (path === '/api/admin/site' && method === 'GET') {
    const [settings, items] = await Promise.all([getSettings(env), listItems(env)]);
    return json({ ...settings, items });
  }
  if (path === '/api/admin/settings' && method === 'PUT') return saveSettings(request, env);
  if (path === '/api/admin/items' && method === 'POST') return upload(request, env);
  if (path === '/api/admin/order' && method === 'PUT') return reorder(request, env);

  m = path.match(/^\/api\/admin\/items\/([a-z0-9-]+)$/);
  if (m && method === 'PATCH') return editItem(request, env, m[1]);
  if (m && method === 'DELETE') return deleteItem(env, m[1]);

  throw new HttpError(404, 'Not found.');
}

// Owner-only routes for the studio.
async function studio(request, env, url) {
  const { pathname: path } = url;
  const method = request.method;
  if (method !== 'GET') checkOrigin(request, url);
  await requireOwner(request, env);

  if (path === '/api/studio/entries' && method === 'GET') return studioList(env, url);
  if (path === '/api/studio/entries' && method === 'POST') return studioCreate(request, env);
  if (path === '/api/studio/preview' && method === 'POST') return preview(request);
  if (path === '/api/studio/entries/move' && method === 'POST') return moveEntries(request, env);
  if (path === '/api/studio/preview-page' && method === 'POST') return previewPage(request, env);
  if (path === '/api/studio/link-info' && method === 'POST') return linkInfo(request, env);
  if (path === '/api/studio/community' && method === 'GET') return listCommunity(env);
  if (path === '/api/studio/spaces' && method === 'GET') return studioSpaces(env);
  if (path === '/api/studio/spaces' && method === 'POST') return createSpace(request, env);
  const sp = path.match(/^\/api\/studio\/spaces\/([a-z0-9-]+)(\/members)?$/);
  if (sp && !sp[2] && method === 'PATCH') return updateSpace(request, env, sp[1]);
  if (sp && !sp[2] && method === 'DELETE') return deleteSpace(env, sp[1]);
  if (sp && sp[2] && method === 'GET') return spaceMembers(env, sp[1]);
  if (sp && sp[2] && method === 'PATCH') return decideMember(request, env, sp[1]);
  if (path === '/api/studio/comments' && method === 'GET') return studioComments(env, url, await access(env, { role: 'owner' }));
  const cs = path.match(/^\/api\/studio\/comments\/([a-z0-9-]+)$/);
  if (cs && method === 'PATCH') return setCommentStatus(request, env, cs[1]);
  if (path === '/api/studio/posts' && method === 'GET') return studioPosts(env, url, await access(env, { role: 'owner' }));
  const ps = path.match(/^\/api\/studio\/posts\/([a-z0-9-]+)$/);
  if (ps && method === 'PATCH') return moderatePost(request, env, ps[1]);
  if (path === '/api/studio/settings' && method === 'GET') return studioSettings(env);
  if (path === '/api/studio/settings/socials' && method === 'PUT') return saveSocials(request, env);
  if (path === '/api/studio/import-legacy' && method === 'POST') return importLegacy(env);
  if (path === '/api/studio/import-cv' && method === 'POST') return importCv(env);
  if (path === '/api/studio/files' && method === 'POST') return uploadFile(request, env);
  const fm = path.match(/^\/api\/studio\/files\/([a-z0-9-]+)$/);
  if (fm && method === 'DELETE') return deleteFile(env, fm[1]);
  const lf = path.match(/^\/api\/studio\/entries\/([a-z0-9-]+)\/files$/);
  if (lf && method === 'GET') return listFiles(env, lf[1]);
  if (path === '/api/studio/invites' && method === 'POST') return createInvite(request, env);
  let mm = path.match(/^\/api\/studio\/members\/([a-z0-9-]+)$/);
  if (mm && method === 'PATCH') return setMemberStatus(request, env, mm[1]);
  if (mm && method === 'DELETE') return removeMember(env, mm[1]);
  mm = path.match(/^\/api\/studio\/invites\/([A-Za-z0-9_-]+)$/);
  if (mm && method === 'DELETE') return revokeInvite(env, mm[1]);
  const m = path.match(/^\/api\/studio\/entries\/([a-z0-9-]+)$/);
  if (m && method === 'GET') {
    const entry = await getEntry(env, m[1]);
    if (!entry) throw new HttpError(404, 'That item no longer exists.');
    return json(entry);
  }
  if (m && method === 'PATCH') return studioUpdate(request, env, m[1]);
  const sm = path.match(/^\/api\/studio\/entries\/([a-z0-9-]+)\/sync$/);
  if (sm && method === 'POST') return syncOne(env, sm[1]);
  if (m && method === 'DELETE') {
    const res = await studioDelete(env, m[1]);
    await deleteFilesOf(env, m[1]);
    await deleteCommentsOf(env, m[1]);
    return res;
  }
  throw new HttpError(404, 'Not found.');
}

// Community sign-up and sign-in.
async function memberApi(request, env, url) {
  const { pathname: path } = url;
  const method = request.method;
  if (method !== 'GET') checkOrigin(request, url);
  if (path === '/api/member/invite' && method === 'GET') return checkInvite(env, url);
  if (path === '/api/member/join' && method === 'POST') return join(request, env);
  if (path === '/api/member/login' && method === 'POST') return memberLogin(request, env);
  if (path === '/api/member/logout' && method === 'POST') return memberLogout();
  if (path === '/api/member/me' && method === 'GET') return me(request, env);
  const jm = path.match(/^\/api\/member\/spaces\/([a-z0-9-]+)\/join$/);
  if (jm && method === 'POST') return requestJoin(request, env, await viewer(request, env), jm[1]);
  throw new HttpError(404, 'Not found.');
}

// Community blogs (members and the owner) and who can be tagged.
async function blogApi(request, env, url) {
  const { pathname: path } = url;
  const method = request.method;
  if (method !== 'GET') checkOrigin(request, url);
  const v = await viewer(request, env);
  if (path === '/api/people' && method === 'GET') return people(env, v, url);
  const nb = path.match(/^\/api\/blog\/([a-z0-9-]+)\/posts$/);
  if (nb && method === 'POST') return createPost(request, env, v, nb[1]);
  const pm = path.match(/^\/api\/blog\/posts\/([a-z0-9-]+)$/);
  if (pm && method === 'PATCH') return editPost(request, env, v, pm[1]);
  if (pm && method === 'DELETE') return deletePost(env, v, pm[1]);
  throw new HttpError(404, 'Not found.');
}

// ---------- settings ----------

function defaultSettings() {
  return {
    sections: Object.fromEntries(SECTIONS.map((s) => [s, true])),
    intros: Object.fromEntries(MEDIA_SECTIONS.map((s) => [s, ''])),
  };
}

async function getSettings(env) {
  const stored = (await env.MEDIA.get('settings', 'json')) ?? {};
  const base = defaultSettings();
  return {
    sections: { ...base.sections, ...pickKnown(stored.sections, SECTIONS, (v) => v === true || v === false) },
    intros: { ...base.intros, ...pickKnown(stored.intros, MEDIA_SECTIONS, (v) => typeof v === 'string') },
  };
}

function pickKnown(obj, keys, valid) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([k, v]) => keys.includes(k) && valid(v)));
}

async function saveSettings(request, env) {
  const body = await readJson(request);
  const current = await getSettings(env);
  const next = {
    sections: { ...current.sections, ...pickKnown(body.sections, SECTIONS, (v) => v === true || v === false) },
    intros: { ...current.intros },
  };
  for (const [k, v] of Object.entries(pickKnown(body.intros, MEDIA_SECTIONS, (v) => typeof v === 'string'))) {
    next.intros[k] = cleanText(v, 600);
  }
  await env.MEDIA.put('settings', JSON.stringify(next));
  return json(next);
}

// ---------- items ----------

async function listItems(env) {
  return (await env.MEDIA.get('items', 'json')) ?? [];
}

async function saveItems(env, items) {
  await env.MEDIA.put('items', JSON.stringify(items));
}

function publicItem(i) {
  const { id, section, title, note, link, kind, duration, hasFile, hasCover, createdAt } = i;
  return { id, section, title, note, link, kind, duration, hasFile, hasCover, createdAt };
}

function cleanLink(value) {
  const raw = cleanText(value, 500);
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'The link is not a valid web address.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'The link must start with https://');
  return u.href;
}

async function upload(request, env) {
  const form = await request.formData();
  const section = String(form.get('section') ?? '');
  if (!MEDIA_SECTIONS.includes(section)) throw new HttpError(400, 'Pick a section for this item.');
  const title = cleanText(form.get('title'), 120);
  if (!title) throw new HttpError(400, 'Give the item a title.');
  const link = cleanLink(form.get('link'));

  const file = form.get('file');
  const cover = form.get('cover');
  const hasFile = file instanceof File && file.size > 0;
  const hasCover = cover instanceof File && cover.size > 0;
  if (!hasFile && !link) throw new HttpError(400, 'Add a file or a link.');

  let kind = 'link';
  if (hasFile) {
    kind = fileKind(file.type);
    if (!kind) throw new HttpError(400, 'Unsupported file type. Use audio, video, PDF or an image (PNG, JPG, WebP).');
    if (file.size > MAX_FILE_BYTES) throw new HttpError(413, 'The file is over 25 MB. Compress it, or upload it to YouTube or Drive and add a link instead.');
  }
  if (hasCover) {
    if (!isCoverType(cover.type)) throw new HttpError(400, 'The cover must be a PNG, JPG or WebP image.');
    if (cover.size > MAX_COVER_BYTES) throw new HttpError(413, 'The cover image is over 2 MB.');
  }

  const id = crypto.randomUUID();
  if (hasFile) await env.MEDIA.put(`file:${id}`, await file.arrayBuffer(), { metadata: { type: file.type } });
  if (hasCover) await env.MEDIA.put(`cover:${id}`, await cover.arrayBuffer(), { metadata: { type: cover.type } });

  const duration = Number(form.get('duration'));
  const item = {
    id,
    section,
    title,
    note: cleanText(form.get('note'), 600),
    link,
    kind,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    hasFile,
    fileType: hasFile ? file.type : null,
    fileName: hasFile ? cleanText(file.name, 200) : null,
    size: hasFile ? file.size : 0,
    hasCover,
    hidden: form.get('hidden') === 'true',
    createdAt: new Date().toISOString(),
  };
  const items = await listItems(env);
  items.unshift(item);
  await saveItems(env, items);
  return json(item, 201);
}

async function editItem(request, env, id) {
  const body = await readJson(request);
  const items = await listItems(env);
  const item = items.find((i) => i.id === id);
  if (!item) throw new HttpError(404, 'That item no longer exists.');
  if ('title' in body) {
    const title = cleanText(body.title, 120);
    if (!title) throw new HttpError(400, 'Give the item a title.');
    item.title = title;
  }
  if ('note' in body) item.note = cleanText(body.note, 600);
  if ('link' in body) {
    const link = cleanLink(body.link);
    if (!link && !item.hasFile) throw new HttpError(400, 'This item has no file, so it needs a link.');
    item.link = link;
  }
  if ('hidden' in body) item.hidden = Boolean(body.hidden);
  if ('section' in body) {
    if (!MEDIA_SECTIONS.includes(body.section)) throw new HttpError(400, 'Unknown section.');
    item.section = body.section;
  }
  await saveItems(env, items);
  return json(item);
}

async function deleteItem(env, id) {
  const items = await listItems(env);
  const remaining = items.filter((i) => i.id !== id);
  if (remaining.length === items.length) throw new HttpError(404, 'That item no longer exists.');
  await saveItems(env, remaining);
  await Promise.all([env.MEDIA.delete(`file:${id}`), env.MEDIA.delete(`cover:${id}`)]);
  return json({ ok: true });
}

// The client sends the full order of one section; other sections keep their places.
async function reorder(request, env) {
  const { ids } = await readJson(request);
  if (!Array.isArray(ids)) throw new HttpError(400, 'Send the new order as a list of ids.');
  const items = await listItems(env);
  const byId = new Map(items.map((i) => [i.id, i]));
  const queue = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const moving = new Set(queue.map((i) => i.id));
  const ordered = items.map((i) => (moving.has(i.id) ? queue.shift() : i));
  await saveItems(env, ordered);
  return json(ordered);
}

// ---------- media ----------

async function media(request, env, kind, id) {
  const { value, metadata } = await env.MEDIA.getWithMetadata(`${kind}:${id}`, 'arrayBuffer');
  if (!value) throw new HttpError(404, 'Not found.');
  return serveBytes(request, value, metadata?.type, 'public, max-age=31536000, immutable');
}
