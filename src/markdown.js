// Markdown to HTML for articles. Raw HTML in the source is shown as text, and
// links and images only keep http(s), mailto and same-site addresses, so a
// published article can never run script on the site.
import { Marked } from 'marked';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function safeUrl(href) {
  const raw = String(href ?? '').trim();
  if (/^(\/(?!\/)|#)/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) return u.href;
  } catch {
    // not an absolute address
  }
  return null;
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return text;
      const external = /^https?:/.test(url) ? ' rel="noopener nofollow"' : '';
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(url)}"${t}${external}>${text}</a>`;
    },
    image({ href, title, text }) {
      const url = safeUrl(href);
      if (!url || url.startsWith('mailto:')) return escapeHtml(text);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
  },
});

export function renderMarkdown(source) {
  return marked.parse(String(source ?? ''), { async: false });
}

// Plain-text excerpt for lists and link previews.
export function excerpt(source, max = 200) {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
