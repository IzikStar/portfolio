// Players for media that lives elsewhere: YouTube, Google Drive, or a file
// uploaded to the site. Anything else becomes a plain link.
import { escapeHtml as e, safeUrl } from './markdown.js';

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;

export function youtubeId(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return m ? m[1] : null;
    }
  } catch {
    // not a URL
  }
  return null;
}

export function driveId(href) {
  try {
    const u = new URL(href);
    if (u.hostname !== 'drive.google.com' && u.hostname !== 'docs.google.com') return null;
    const m = u.pathname.match(/\/(?:file\/d|document\/d|presentation\/d)\/([\w-]{10,})/);
    return m ? m[1] : u.searchParams.get('id');
  } catch {
    return null;
  }
}

// kind: 'audio' | 'video' | undefined (guessed from the address).
export function mediaEmbed(href, { title = '', kind } = {}) {
  const url = safeUrl(href);
  if (!url || url.startsWith('mailto:') || url.startsWith('#')) return '';
  const t = e(title || 'נגן');
  const yt = youtubeId(url);
  if (yt && /^[\w-]+$/.test(yt)) {
    return `<div class="media"><iframe src="https://www.youtube-nocookie.com/embed/${yt}" title="${t}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  }
  const drive = driveId(url);
  if (drive && /^[\w-]+$/.test(drive)) {
    const audio = kind === 'audio' || AUDIO_EXT.test(title);
    return `<div class="media${audio ? ' audio' : ''}"><iframe src="https://drive.google.com/file/d/${drive}/preview" title="${t}" loading="lazy" allow="autoplay; fullscreen" allowfullscreen></iframe></div>`;
  }
  if (kind === 'audio' || AUDIO_EXT.test(url)) return `<div class="media audio"><audio controls preload="none" src="${e(url)}"></audio></div>`;
  if (kind === 'video' || VIDEO_EXT.test(url)) return `<div class="media"><video controls preload="metadata" playsinline src="${e(url)}"></video></div>`;
  return `<p><a class="btn" href="${e(url)}" rel="noopener">${t} ↗</a></p>`;
}
