export const MAX_FILE_BYTES = 25 * 1024 * 1024; // KV value limit
export const MAX_COVER_BYTES = 2 * 1024 * 1024;

// Sections in page order. "media" sections hold uploaded items.
export const SECTIONS = ['code', 'music', 'voice', 'sketches', 'writing', 'about', 'contact'];
export const MEDIA_SECTIONS = ['music', 'voice', 'sketches', 'writing'];

// Only types the browser plays or shows safely from our own origin (no SVG or HTML).
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export function fileKind(type) {
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (IMAGE_TYPES.includes(type)) return 'image';
  return null;
}
export const isCoverType = (type) => IMAGE_TYPES.includes(type);

// Cubase projects and their archives (.cpr, Cubase's .bak backups, .zip):
// working files the owner hands out as downloads. They are stored as opaque
// bytes and always served as attachments, never shown inline.
export const DOWNLOAD_TYPE = 'application/octet-stream';
const DOWNLOAD_EXT = { cpr: 'cubase', bak: 'cubase', zip: 'zip' };
export function downloadKind(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  return (m && DOWNLOAD_EXT[m[1].toLowerCase()]) || null;
}
