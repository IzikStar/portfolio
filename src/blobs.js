// The bytes of uploaded files, in KV. A KV value holds at most 25 MB, so a
// bigger file (a phone video) is kept in pieces: "blob:<id>:0", ":1", ...,
// and "blob:<id>" itself holds only a note of how many pieces there are.
// Files up to one piece stay a single value, as they always were.
import { serveBytes } from './bytes.js';

export const PIECE = 20 * 1024 * 1024;

const key = (id, n) => (n === undefined ? `blob:${id}` : `blob:${id}:${n}`);

// Store `input` (an ArrayBuffer or a stream of bytes). Returns the size;
// throws a RangeError, and keeps nothing, when it passes `max` bytes.
export async function putBlob(env, id, input, type, max = Infinity) {
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const buf = input instanceof ArrayBuffer ? input : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    if (buf.byteLength > max) throw new RangeError('too big');
    if (buf.byteLength <= PIECE) {
      await env.MEDIA.put(key(id), buf, { metadata: { type } });
      return buf.byteLength;
    }
    input = new Blob([buf]).stream();
  }
  // Read the stream a piece at a time, so a big file never sits in memory whole.
  const reader = input.getReader();
  const pending = [];
  let held = 0;
  let size = 0;
  let pieces = 0;
  const take = (n) => {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = pending[0];
      const want = n - at;
      if (head.byteLength <= want) {
        out.set(head, at);
        at += head.byteLength;
        pending.shift();
      } else {
        out.set(head.subarray(0, want), at);
        pending[0] = head.subarray(want);
        at += want;
      }
    }
    held -= n;
    return out;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > max) throw new RangeError('too big');
      pending.push(chunk);
      held += chunk.byteLength;
      while (held > PIECE) await env.MEDIA.put(key(id, pieces++), take(PIECE));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    await Promise.all(Array.from({ length: pieces }, (_, n) => env.MEDIA.delete(key(id, n))));
    throw err;
  }
  const rest = take(held);
  if (!pieces) {
    await env.MEDIA.put(key(id), rest, { metadata: { type } });
  } else {
    await env.MEDIA.put(key(id, pieces++), rest);
    await env.MEDIA.put(key(id), JSON.stringify({ pieces, size }), { metadata: { type, pieces, size } });
  }
  return size;
}

// The whole file as one ArrayBuffer (for the backup ZIP), or null.
export async function getBlob(env, id) {
  const { value, metadata } = await env.MEDIA.getWithMetadata(key(id), 'arrayBuffer');
  if (!value) return null;
  if (!metadata?.pieces) return value;
  const out = new Uint8Array(metadata.size);
  let at = 0;
  for (let n = 0; n < metadata.pieces; n++) {
    const part = await env.MEDIA.get(key(id, n), 'arrayBuffer');
    if (!part) return null;
    const bytes = part instanceof ArrayBuffer ? new Uint8Array(part) : new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return out.buffer;
}

export async function deleteBlob(env, id) {
  const { metadata } = await env.MEDIA.getWithMetadata(key(id));
  const pieces = metadata?.pieces ?? 0;
  await Promise.all([env.MEDIA.delete(key(id)), ...Array.from({ length: pieces }, (_, n) => env.MEDIA.delete(key(id, n)))]);
}

// Serve a stored file with range support. Null when the bytes are gone.
export async function serveBlob(request, env, id, type, cacheControl) {
  const { value, metadata } = await env.MEDIA.getWithMetadata(key(id), 'arrayBuffer');
  if (!value) return null;
  if (!metadata?.pieces) return serveBytes(request, value, type, cacheControl);

  const total = metadata.size;
  // Work out the range with serveBytes' rules by asking it about an empty
  // stand-in of the same length: it answers with the headers we need.
  const probe = serveBytes(new Request(request.url, { method: 'HEAD', headers: request.headers }), { byteLength: total }, type, cacheControl);
  if (probe.status === 416 || request.method === 'HEAD') return new Response(null, { status: probe.status, headers: probe.headers });
  const cr = probe.headers.get('Content-Range');
  const [start, end] = cr ? cr.match(/bytes (\d+)-(\d+)/).slice(1).map(Number) : [0, total - 1];
  let n = Math.floor(start / PIECE);
  const last = Math.floor(end / PIECE);
  const body = new ReadableStream({
    async pull(controller) {
      if (n > last) return controller.close();
      const part = await env.MEDIA.get(key(id, n), 'arrayBuffer');
      if (!part) return controller.error(new Error('missing piece'));
      const bytes = part instanceof ArrayBuffer ? new Uint8Array(part) : new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      const from = n === Math.floor(start / PIECE) ? start - n * PIECE : 0;
      const to = n === last ? end - n * PIECE + 1 : bytes.byteLength;
      controller.enqueue(bytes.subarray(from, to));
      n++;
    },
  });
  return new Response(body, { status: probe.status, headers: probe.headers });
}
