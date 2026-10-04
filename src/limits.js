export const MAX_FILE_BYTES = 25 * 1024 * 1024; // KV value limit

// Only types the browser plays or shows safely from our own origin (no SVG or HTML).
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export function fileKind(type) {
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (IMAGE_TYPES.includes(type)) return 'image';
  return null;
}

// Cubase projects and their archives (.cpr, Cubase's .bak backups, .zip):
// working files the owner hands out as downloads. They are stored as opaque
// bytes and always served as attachments, never shown inline.
export const DOWNLOAD_TYPE = 'application/octet-stream';
const DOWNLOAD_EXT = { cpr: 'cubase', bak: 'cubase', zip: 'zip' };
export function downloadKind(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  return (m && DOWNLOAD_EXT[m[1].toLowerCase()]) || null;
}
