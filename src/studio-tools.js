// Studio helpers for editing: a full preview of an item as visitors will see
// it (from what is in the editor, saved or not), and what a pasted Drive or
// YouTube link is (its title, audio or video) so the studio can fill it in.
import { KINDS, VISIBILITY } from './db.js';
import { json, readJson, cleanText } from './http.js';
import { getEntry, slugify } from './entries.js';
import { access } from './spaces.js';
import { entryPage } from './wings.js';
import { youtubeId, driveId } from './media.js';

// POST /api/studio/preview-page { id?, kind, spaceId, title, ..., meta, as }
// as: 'owner' (default), 'community' (a member of the item's community) or 'public'.
export async function previewPage(request, env) {
  const body = await readJson(request);
  const owner = await access(env, { role: 'owner' });
  const stored = body.id ? await getEntry(env, String(body.id)) : null;
  const spaceId = owner.byId.has(body.spaceId) ? body.spaceId : (stored?.spaceId ?? 'articles');
  const meta = body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : (stored?.meta ?? {});
  const tags = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(',');
  const now = new Date().toISOString();
  const entry = {
    id: stored?.id ?? 'preview',
    kind: KINDS.includes(body.kind) ? body.kind : (stored?.kind ?? 'article'),
    spaceId,
    slug: slugify(body.slug) || stored?.slug || 'preview',
    title: cleanText(body.title, 200),
    summary: cleanText(body.summary, 600),
    body: String(body.body ?? '').slice(0, 200_000),
    visibility: VISIBILITY.includes(body.visibility) ? body.visibility : (stored?.visibility ?? 'private'),
    status: 'published',
    tags: tags.map((t) => cleanText(t, 40)).filter(Boolean).slice(0, 20),
    meta,
    pinned: false,
    source: 'studio',
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
    publishedAt: stored?.publishedAt ?? now,
  };
  let v;
  if (body.as === 'public') {
    v = { role: 'public', member: null };
    v.acc = await access(env, v);
  } else if (body.as === 'community') {
    // A member who belongs to every community: what the item's community sees.
    v = { role: 'member', member: { id: 'preview', displayName: 'חבר.ת קהילה' } };
    v.acc = { ...owner, owner: false, member: true, pending: new Set() };
  } else {
    v = { role: 'owner', member: null, acc: owner };
  }
  const res = await entryPage(env, v, entry);
  return json({ html: await res.text() });
}

// ---------- pasted links ----------

const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|aif|aiff|wma)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v|avi|mkv|wmv)$/i;
const TIMEOUT = 6000;

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[k] ?? m);
}

// The file name from a shared Drive file's page. A file that is not shared
// answers with a redirect to sign-in, so there is nothing to read.
async function driveName(id) {
  const res = await fetch(`https://drive.google.com/file/d/${id}/view`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status !== 200) return null;
  const html = (await res.text()).slice(0, 400_000);
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  const title = og ? og[1] : html.match(/<title>([^<]*?)(?:\s+-\s+Google\s+Drive)?<\/title>/i)?.[1];
  const name = title ? decodeEntities(title).trim() : '';
  // The generic pages (sign-in, "Google Drive") are not a file name.
  return name && !/^(google drive|sign in|meet google drive)/i.test(name) ? name : null;
}

async function youtubeTitle(id) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return cleanText(data.title, 200) || null;
}

async function inspect(url) {
  const out = { url, source: null, title: null, name: null, kind: null };
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return out;
    if (u.hostname === 'drive.google.com' && /^\/drive\/(u\/\d+\/)?folders\//.test(u.pathname)) return { ...out, source: 'drive-folder' };
  } catch {
    return out;
  }
  const yt = youtubeId(url);
  const drive = driveId(url);
  try {
    if (yt && /^[\w-]+$/.test(yt)) {
      Object.assign(out, { source: 'youtube', kind: 'video' });
      out.title = await youtubeTitle(yt);
    } else if (drive && /^[\w-]+$/.test(drive)) {
      out.source = 'drive';
      const name = await driveName(drive);
      if (name) {
        out.name = name.slice(0, 200);
        out.title = out.name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim() || out.name;
        out.kind = AUDIO.test(name) ? 'audio' : VIDEO.test(name) ? 'video' : null;
      } else {
        out.private = true;
      }
    }
  } catch {
    // A slow or unreachable page leaves the title empty; the studio asks for one.
  }
  return out;
}

// POST /api/studio/link-info { urls: [...] } -> { links: [{ url, source, title, name, kind, private? }] }
// Never fails as a whole: a link it cannot read comes back without a title.
export async function linkInfo(request, env) {
  const { urls } = await readJson(request);
  const list = (Array.isArray(urls) ? urls : []).map((x) => String(x).trim().slice(0, 1000)).filter(Boolean).slice(0, 40);
  return json({ links: await Promise.all(list.map(inspect)) });
}
