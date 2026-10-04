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
