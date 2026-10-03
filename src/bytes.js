// Serve stored bytes inline, inert (no script), with HTTP range support so
// players can seek.
export function serveBytes(request, value, type, cacheControl) {
  const headers = new Headers({
    'Content-Type': type ?? 'application/octet-stream',
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
  });
  // Uploads are owner-only, but keep them inert anyway. Chrome refuses to show
  // PDFs under a sandbox CSP, so PDFs get only nosniff.
  if (type !== 'application/pdf') {
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  const total = value.byteLength;
  const range = request.headers.get('Range');
  const r = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (r && (r[1] || r[2])) {
    let start = r[1] ? Number(r[1]) : total - Number(r[2]);
    let end = r[1] && r[2] ? Number(r[2]) : total - 1;
    start = Math.max(0, start);
    end = Math.min(end, total - 1);
    if (start > end) {
      headers.set('Content-Range', `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
    headers.set('Content-Length', String(end - start + 1));
    const body = request.method === 'HEAD' ? null : value.slice(start, end + 1);
    return new Response(body, { status: 206, headers });
  }
  headers.set('Content-Length', String(total));
  return new Response(request.method === 'HEAD' ? null : value, { status: 200, headers });
}
