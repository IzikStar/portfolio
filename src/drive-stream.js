// Recordings and videos kept in Google Drive, played by the site's own
// <audio> and <video> players instead of Drive's preview frame (which is
// cramped for audio and awkward on a phone). The worker asks Drive for the
// file and passes the bytes through, ranges included, so players can seek.
// It only does so for a Drive file that a version of an item names, and only
// to someone who may see that version; the owner may play any file.
// Drive still has to share the file with "anyone with the link". When it
// does not (or Drive answers with a page instead of the file), this answers
// 502 and the page falls back to Drive's own frame.
import { db } from './db.js';
import { fromRow } from './entries.js';
import { canSee, inAny, isPublicEntry } from './spaces.js';
import { driveId } from './media.js';

const TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const GUESS = { audio: 'audio/mpeg', video: 'video/mp4' };

// Which versions name this Drive file, and may this viewer play one of them?
// → null (no), or { isPublic } for the cache header.
export async function mayPlay(env, acc, id) {
  if (acc.owner) return { isPublic: false };
  const d = await db(env);
  // A rough filter in SQL (_ is a wildcard in LIKE), the exact check below.
  const { results } = await d
    .prepare(`SELECT * FROM entries WHERE status = 'published' AND meta LIKE ? LIMIT 50`)
    .bind(`%${id}%`)
    .all();
  let found = null;
  for (const entry of results.map(fromRow)) {
    if (!canSee(acc, entry)) continue;
    for (const v of entry.meta?.versions ?? []) {
      if (!v || typeof v.url !== 'string' || driveId(v.url) !== id) continue;
      if (v.visibility === 'community' && !inAny(acc, entry.communities)) continue;
      const isPublic = isPublicEntry(acc, entry) && v.visibility !== 'community';
      if (isPublic) return { isPublic };
      found = { isPublic };
    }
  }
  return found;
}

// The file's name from Drive's Content-Disposition, to tell its type.
function fileName(disposition) {
  if (!disposition) return '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through to the plain name
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? '';
}

export async function streamDrive(request, env, acc, id, kind) {
  if (!/^[\w-]{10,}$/.test(id)) return null;
  const ok = await mayPlay(env, acc, id);
  if (!ok) return null;
  const headers = {};
  const range = request.headers.get('Range');
  if (range && /^bytes=\d*-\d*$/.test(range.trim())) headers.Range = range.trim();
  let up;
  try {
    up = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, { headers, redirect: 'follow' });
  } catch {
    return new Response('Drive did not answer.', { status: 502 });
  }
  const upType = (up.headers.get('Content-Type') ?? '').split(';')[0].trim();
  // A sign-in page, a "too many downloads" page or an error: not the file.
  if ((up.status !== 200 && up.status !== 206) || upType.startsWith('text/')) {
    up.body?.cancel();
    return new Response('Drive did not give the file. Is it shared with anyone who has the link?', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const ext = fileName(up.headers.get('Content-Disposition')).split('.').pop()?.toLowerCase() ?? '';
  const type = TYPES[ext] ?? (/^(audio|video)\//.test(upType) ? upType : GUESS[kind] ?? 'application/octet-stream');
  const out = new Headers({
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': ok.isPublic ? 'public, max-age=86400' : 'private, max-age=3600',
    Vary: 'Cookie',
  });
  for (const h of ['Content-Length', 'Content-Range']) {
    const value = up.headers.get(h);
    if (value) out.set(h, value);
  }
  return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
}
