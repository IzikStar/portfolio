// Chapters imported from Word keep their page as HTML (public/docx.js writes
// it in the studio). Only the owner writes these, but the page still shows
// nothing that could run: a fixed list of tags, attributes and style
// properties survives and everything else is dropped, text kept as text.
import { escapeHtml, safeUrl } from './markdown.js';

const TAGS = new Set(['p', 'h2', 'h3', 'h4', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sup', 'sub', 'br', 'hr', 'a', 'img', 'div', 'table', 'tbody', 'tr', 'td', 'th', 'blockquote', 'ul', 'ol', 'li']);
const VOID = new Set(['br', 'hr', 'img']);
// Their content goes too, not just the tag.
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'title', 'head']);

const STYLE = {
  'text-align': /^(start|end|left|right|center|justify)$/,
  'font-size': /^\d{1,2}(\.\d{1,3})?em$/,
  'font-weight': /^(bold|normal|[1-9]00)$/,
  'font-style': /^(italic|normal)$/,
  'font-variant': /^(small-caps|normal)$/,
  'text-transform': /^(uppercase|lowercase|none)$/,
  color: /^#[0-9a-f]{3,6}$/i,
  'background-color': /^#[0-9a-f]{3,6}$/i,
  'text-indent': /^-?\d{1,3}(\.\d)?pt$/,
  'margin-inline-start': /^\d{1,3}(\.\d)?pt$/,
  'margin-inline-end': /^\d{1,3}(\.\d)?pt$/,
  width: /^(\d{1,4}px|-?\d{1,4}(\.\d{1,2})?%)$/,
  // A Word group's pieces are placed by percent inside the group's own box.
  left: /^-?\d{1,4}(\.\d{1,2})?%$/,
  top: /^-?\d{1,4}(\.\d{1,2})?%$/,
  height: /^-?\d{1,4}(\.\d{1,2})?%$/,
  'aspect-ratio': /^\d{1,4} \/ \d{1,4}$/,
  transform: /^(rotate\(-?\d{1,3}(\.\d)?deg\))?( ?scale[XY]\(-1\)){0,2}$/,
  '--dx-w': /^\d{1,4}$/,
  '--dx-fs': /^\d{1,2}(\.\d{1,2})?$/,
};
const CLASS = /^dx-[a-z-]+$/;
const ID = /^[nr]-\d{1,4}$/;

function cleanStyle(value) {
  const kept = [];
  for (const decl of String(value).split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const v = decl.slice(at + 1).trim();
    if (STYLE[prop]?.test(v)) kept.push(`${prop}:${v}`);
  }
  return kept.join(';');
}

function cleanAttrs(tag, raw) {
  const out = [];
  const re = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const name = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? m[4] ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    if (name === 'style') {
      const s = cleanStyle(value);
      if (s) out.push(`style="${escapeHtml(s)}"`);
    } else if (name === 'class') {
      const c = value.split(/\s+/).filter((x) => CLASS.test(x)).join(' ');
      if (c) out.push(`class="${c}"`);
    } else if (name === 'id' && ID.test(value)) out.push(`id="${value}"`);
    else if (name === 'dir' && /^(rtl|ltr|auto)$/.test(value)) out.push(`dir="${value}"`);
    else if ((name === 'colspan' || name === 'rowspan') && /^\d{1,2}$/.test(value)) out.push(`${name}="${value}"`);
    else if (tag === 'img' && (name === 'width' || name === 'height') && /^\d{1,4}$/.test(value)) out.push(`${name}="${value}"`);
    else if (tag === 'img' && name === 'alt') out.push(`alt="${escapeHtml(value.slice(0, 300))}"`);
    else if (tag === 'img' && name === 'src') {
      const url = safeUrl(value);
      if (url && !url.startsWith('mailto:') && !url.startsWith('#')) out.push(`src="${escapeHtml(url)}"`);
    } else if (tag === 'a' && name === 'href') {
      const url = safeUrl(value);
      if (url) out.push(`href="${escapeHtml(url)}"`, ...(/^https?:/.test(url) ? ['rel="noopener nofollow"'] : []));
    }
  }
  if (tag === 'img') {
    if (!out.some((a) => a.startsWith('src='))) return null;
    out.push('loading="lazy"');
  }
  return out;
}

export function sanitizeHtml(source) {
  const html = String(source ?? '');
  const out = [];
  const open = [];
  let skip = null;
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|<|[^<]+/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const token = m[0];
    const name = m[1]?.toLowerCase();
    const closing = token.startsWith('</');
    if (skip) {
      if (closing && name === skip) skip = null;
      continue;
    }
    if (token.startsWith('<!--')) continue;
    if (!name) {
      // Text (a lone "<" is text too). Entities already written stay as they are.
      out.push(token === '<' ? '&lt;' : token.replace(/&(?!(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});)/gi, '&amp;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
      continue;
    }
    if (DROP.has(name)) {
      if (!closing && !token.endsWith('/>')) skip = name;
      continue;
    }
    if (!TAGS.has(name)) continue;
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    const attrs = cleanAttrs(name, m[2] ?? '');
    if (!attrs) continue;
    out.push(`<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
    if (!VOID.has(name)) open.push(name);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}

// The chapter's own alignment, paragraph spacing and line height, as a style attribute.
export function richLook(look) {
  if (!look || typeof look !== 'object') return '';
  const css = [];
  if (/^(start|end|center|justify)$/.test(look.align)) css.push(`text-align:${look.align}`);
  const gap = Number(look.gap);
  if (Number.isFinite(gap) && gap >= 0 && gap <= 72) css.push(`--dx-gap:${gap}pt`);
  const line = Number(look.line);
  if (Number.isFinite(line) && line > 0) css.push(`--dx-line:${Math.min(2.6, Math.max(1.3, line))}`);
  return css.length ? ` style="${css.join(';')}"` : '';
}

// Which bodies are HTML: those the Word import wrote.
export const isRich = (entry) => entry?.meta?.format === 'html';

