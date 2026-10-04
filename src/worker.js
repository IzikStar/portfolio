// Site worker: serves the static site (ASSETS), the platform (studio API,
// server-rendered home, wing and item pages; data in D1, see src/db.js) and the CV at /cv.
// KV holds uploaded files ("blob:<id>"). The old admin page's keys ("items",
// "settings", "file:<id>", "cover:<id>") are only read once, by importLegacyOnce.
//
// Required bindings/secrets (see wrangler.toml and README):
//   MEDIA          KV namespace
//   DB             D1 database (platform entries, members, invites)
//   ADMIN_PASSWORD secret, the only way into the studio

import { HttpError, json, checkOrigin } from './http.js';
import { login, logout, isOwner, requireOwner } from './auth.js';
import { studioList, studioCreate, studioUpdate, studioDelete, getEntry, preview, publicList } from './entries.js';
import { home, wingPage, resolve, communityPage } from './wings.js';
import { WINGS } from './db.js';
import { syncOne, syncAll, cvProjects, importCv } from './projects.js';
import { currentMember, checkInvite, join, memberLogin, memberLogout, me, listCommunity, setMemberStatus, removeMember, createInvite, revokeInvite } from './members.js';
import { access, listSpaces, requestJoin, studioSpaces, createSpace, updateSpace, deleteSpace, spaceMembers, decideMember } from './spaces.js';
import { postComment, deleteComment, studioComments, setCommentStatus, deleteCommentsOf } from './comments.js';
import { getSettings as studioSettings, saveSocials, importLegacy } from './settings.js';
import { uploadFile, listFiles, deleteFile, deleteFilesOf, serveFile } from './files.js';
import { cvPage, studioCv, saveCv, previewCv, importLegacyOnce } from './cv.js';
import { moveEntries } from './moves.js';
import { previewPage, linkInfo } from './studio-tools.js';
import { listIdeas, captureIdea, updateIdea, growIdea, getSparks, saveSparks } from './ideas.js';
import { blogRoute, createPost, editPost, deletePost, studioPosts, moderatePost } from './blog.js';
import { people } from './mentions.js';

// The main address. The other custom domains (and www.) redirect here;
// the workers.dev address keeps working as is.
const CANONICAL_HOST = 'itschakshteren.com';
const REDIRECT_HOSTS = ['www.itschakshteren.com', 'izikstar.com', 'www.izikstar.com'];

export default {
  // Daily: refresh every project that has a source (see wrangler.toml), and
  // move the old admin page's items into the wings if that has not happened yet.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env).then((r) => console.log('source sync', r)));
    ctx.waitUntil(importLegacyOnce(env).then((r) => r && console.log('legacy import', r)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (REDIRECT_HOSTS.includes(url.hostname)) {
      return Response.redirect(`https://${CANONICAL_HOST}${url.pathname}${url.search}`, 301);
    }
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url, ctx);
      const page = await pages(request, env, url, ctx);
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
async function pages(request, env, url, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = url.pathname;
  if (path === '/') return home(env, await viewer(request, env));
  // The CV lives at /cv (src/cv.js); the home page is the platform.
  if (path === '/cv') {
    // Its default items are the ones moved from the old admin page, so make sure they were.
    await later(ctx, importLegacyOnce(env));
    return cvPage(request, env, url);
  }
  if (path === '/cv/' || path === '/index.html') return Response.redirect(`${url.origin}/cv`, 301);
  // The old admin page is gone; the CV is managed in the studio now.
  if (path === '/admin' || path === '/admin.html' || path === '/admin/') return Response.redirect(`${url.origin}/studio#cv`, 302);
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

async function api(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;

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

  if (!path.startsWith('/api/admin/')) throw new HttpError(404, 'Not found.');

  // Everything below changes state or reveals hidden items.
  if (method !== 'GET') checkOrigin(request, url);

  if (path === '/api/admin/login' && method === 'POST') return login(request, env);
  if (path === '/api/admin/logout' && method === 'POST') return logout();

  await requireOwner(request, env);

  if (path === '/api/admin/session' && method === 'GET') {
    // The owner opened the studio: a good moment to move the old admin items, once.
    await later(ctx, importLegacyOnce(env));
    return json({ ok: true });
  }

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
  // The idea notebook (see src/ideas.js).
  if (path === '/api/studio/ideas' && method === 'GET') return listIdeas(env);
  if (path === '/api/studio/ideas' && method === 'POST') return captureIdea(request, env);
  const gi = path.match(/^\/api\/studio\/ideas\/([a-z0-9-]+)(\/grow)?$/);
  if (gi && !gi[2] && method === 'PATCH') return updateIdea(request, env, gi[1]);
  if (gi && gi[2] && method === 'POST') return growIdea(request, env, gi[1]);
  if (path === '/api/studio/sparks' && method === 'GET') return getSparks(env);
  if (path === '/api/studio/sparks' && method === 'PUT') return saveSparks(request, env);
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
  if (path === '/api/studio/cv' && method === 'GET') return studioCv(env);
  if (path === '/api/studio/cv' && method === 'PUT') return saveCv(request, env);
  if (path === '/api/studio/cv/preview' && method === 'POST') return previewCv(request, env);
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

// Background work after the response when the runtime offers it (tests have no ctx).
async function later(ctx, promise) {
  const safe = promise.catch((err) => console.error(err));
  if (ctx?.waitUntil) ctx.waitUntil(safe);
  else await safe;
}
