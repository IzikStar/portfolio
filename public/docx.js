// Word (.docx) to HTML that keeps the page as it was written: alignment,
// sizes, bold and italic, colors, indents, pictures, lists, tables and notes.
// Runs in the studio (the browser does the work, so a 20 MB manuscript never
// passes through the worker) and in the tests under Node; nothing here needs
// a DOM. Pictures come out as <img src="docx:<rId>"> and the caller swaps in
// real addresses once it has stored them.

// ---------- zip ----------

// The files inside a zip, read on demand: name -> () => Promise<Uint8Array>.
export function unzip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('This is not a Word file (.docx).');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map();
  const names = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('The Word file is damaged.');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    files.set(name, async () => {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + size);
      if (method === 0) return raw;
      if (method !== 8) throw new Error(`The Word file uses a compression this page can't read (${method}).`);
      return inflate(raw);
    });
  }
  return files;
}

async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- xml ----------

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unent = (s) =>
  s.indexOf('&') < 0
    ? s
    : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, k) =>
        k[0] === '#' ? String.fromCodePoint(k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)) : (ENT[k] ?? m),
      );

// A small XML reader: { name, attrs, kids } with text as plain strings.
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (let a = attrRe.exec(m[4]); a; a = attrRe.exec(m[4])) attrs[a[1]] = unent(a[2] ?? a[3]);
      const node = { name: m[3], attrs, kids: [] };
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined && stack.length > 1) top.kids.push(unent(m[6]));
  }
  return root;
}

const els = (n) => (n?.kids ?? []).filter((k) => typeof k !== 'string');
const kid = (n, name) => els(n).find((k) => k.name === name) ?? null;
const kidsNamed = (n, name) => els(n).filter((k) => k.name === name);
function find(n, name, out = []) {
  for (const k of els(n)) {
    if (k.name === name) out.push(k);
    else find(k, name, out);
  }
  return out;
}
const val = (n, name, attr = 'w:val') => kid(n, name)?.attrs[attr];
// An on/off property: present and not "false"/"0"/"none".
const onOff = (n, name) => {
  const k = kid(n, name);
  if (!k) return undefined;
  const v = k.attrs['w:val'];
  return v === undefined || !/^(false|0|off|none)$/i.test(v);
};
const textOf = (n) => (typeof n === 'string' ? '' : n.name === 'w:t' ? n.kids.join('') : n.kids.map(textOf).join(''));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- styles ----------

const HEB = /[֐-׿]/;

// Word's properties, merged: docDefaults < style chain < direct.
function runProps(rPr, into = {}) {
  if (!rPr) return into;
  for (const [k, w] of [['b', 'w:b'], ['bCs', 'w:bCs'], ['i', 'w:i'], ['iCs', 'w:iCs'], ['strike', 'w:strike'], ['dstrike', 'w:dstrike'], ['caps', 'w:caps'], ['smallCaps', 'w:smallCaps'], ['vanish', 'w:vanish'], ['rtl', 'w:rtl']]) {
    const v = onOff(rPr, w);
    if (v !== undefined) into[k] = v;
  }
  const u = val(rPr, 'w:u');
  if (u !== undefined) into.u = u !== 'none';
  const sz = val(rPr, 'w:sz');
  if (sz) into.sz = Number(sz) / 2;
  const szCs = val(rPr, 'w:szCs');
  if (szCs) into.szCs = Number(szCs) / 2;
  const color = val(rPr, 'w:color');
  if (color) into.color = color;
  const hl = val(rPr, 'w:highlight');
  if (hl) into.highlight = hl;
  const shd = kid(rPr, 'w:shd')?.attrs['w:fill'];
  if (shd && shd !== 'auto') into.shd = shd;
  const va = val(rPr, 'w:vertAlign');
  if (va) into.vertAlign = va;
  const style = val(rPr, 'w:rStyle');
  if (style) into.rStyle = style;
  return into;
}

function paraProps(pPr, into = {}) {
  if (!pPr) return into;
  const jc = val(pPr, 'w:jc');
  if (jc) into.jc = jc;
  const bidi = onOff(pPr, 'w:bidi');
  if (bidi !== undefined) into.bidi = bidi;
  const sp = kid(pPr, 'w:spacing');
  if (sp) {
    for (const k of ['before', 'after', 'line']) if (sp.attrs[`w:${k}`] !== undefined) into[k] = Number(sp.attrs[`w:${k}`]);
    if (sp.attrs['w:lineRule']) into.lineRule = sp.attrs['w:lineRule'];
  }
  const ind = kid(pPr, 'w:ind');
  if (ind) {
    const a = ind.attrs;
    const n = (x) => (x === undefined ? undefined : Number(x));
    if (a['w:start'] ?? a['w:left']) into.indStart = n(a['w:start'] ?? a['w:left']);
    if (a['w:end'] ?? a['w:right']) into.indEnd = n(a['w:end'] ?? a['w:right']);
    if (a['w:firstLine'] !== undefined) {
      into.firstLine = n(a['w:firstLine']);
      delete into.hanging;
    }
    if (a['w:hanging'] !== undefined) {
      into.hanging = n(a['w:hanging']);
      delete into.firstLine;
    }
  }
  const outline = val(pPr, 'w:outlineLvl');
  if (outline !== undefined) into.outline = Number(outline);
  if (onOff(pPr, 'w:pageBreakBefore')) into.pageBreakBefore = true;
  const numPr = kid(pPr, 'w:numPr');
  if (numPr) into.num = { id: val(numPr, 'w:numId'), lvl: Number(val(numPr, 'w:ilvl') ?? 0) };
  return into;
}

function readStyles(doc) {
  const styles = new Map();
  const root = doc ? kid(doc, 'w:styles') : null;
  const defaults = { r: {}, p: {} };
  const dd = kid(root, 'w:docDefaults');
  if (dd) {
    runProps(kid(kid(dd, 'w:rPrDefault'), 'w:rPr'), defaults.r);
    paraProps(kid(kid(dd, 'w:pPrDefault'), 'w:pPr'), defaults.p);
  }
  let normal = null;
  for (const s of kidsNamed(root, 'w:style')) {
    const id = s.attrs['w:styleId'];
    const name = (val(s, 'w:name') ?? '').toLowerCase();
    styles.set(id, { id, name, type: s.attrs['w:type'], basedOn: val(s, 'w:basedOn'), p: paraProps(kid(s, 'w:pPr')), r: runProps(kid(s, 'w:rPr')) });
    if (s.attrs['w:type'] === 'paragraph' && s.attrs['w:default'] === '1') normal = id;
  }
  const chain = (id, seen = new Set()) => {
    const s = styles.get(id);
    if (!s || seen.has(id)) return [];
    seen.add(id);
    return [...chain(s.basedOn, seen), s];
  };
  return { styles, defaults, normal, chain };
}

// ---------- numbering ----------

const HEBREW_LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';
function hebrewNumber(n) {
  // Gematria for 1-999, the way Word's hebrew1 counts.
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const hundreds = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];
  const h = Math.floor(n / 100) % 10;
  let rest = n % 100;
  if (rest === 15) return `${hundreds[h]}טו`;
  if (rest === 16) return `${hundreds[h]}טז`;
  return `${hundreds[h]}${tens[Math.floor(rest / 10)]}${ones[rest % 10]}`;
}
function roman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of map) while (n >= v) (s += r), (n -= v);
  return s;
}
function formatNumber(n, fmt) {
  switch (fmt) {
    case 'hebrew1':
      return hebrewNumber(n);
    case 'hebrew2':
      return HEBREW_LETTERS[(n - 1) % HEBREW_LETTERS.length];
    case 'lowerLetter':
      return String.fromCharCode(97 + ((n - 1) % 26));
    case 'upperLetter':
      return String.fromCharCode(65 + ((n - 1) % 26));
    case 'lowerRoman':
      return roman(n);
    case 'upperRoman':
      return roman(n).toUpperCase();
    case 'none':
      return '';
    default:
      return String(n);
  }
}
// Symbol and Wingdings bullets sit in the private use area.
const BULLETS = { '': '•', '': '▪', '': '➢', '': '❖', '': '✓', '': '○', o: '○' };

function readNumbering(doc) {
  const root = doc ? kid(doc, 'w:numbering') : null;
  const abstract = new Map();
  for (const a of kidsNamed(root, 'w:abstractNum')) {
    const levels = new Map();
    for (const l of kidsNamed(a, 'w:lvl')) {
      levels.set(Number(l.attrs['w:ilvl']), {
        start: Number(val(l, 'w:start') ?? 1),
        fmt: val(l, 'w:numFmt') ?? 'decimal',
        text: val(l, 'w:lvlText') ?? '',
        p: paraProps(kid(l, 'w:pPr')),
      });
    }
    abstract.set(a.attrs['w:abstractNumId'], levels);
  }
  const nums = new Map();
  for (const n of kidsNamed(root, 'w:num')) nums.set(n.attrs['w:numId'], abstract.get(val(n, 'w:abstractNumId')) ?? new Map());
  const counters = new Map();
  return {
    level(id, lvl) {
      return nums.get(id)?.get(lvl) ?? null;
    },
    // The marker for the next paragraph in this list ("3.", "ב.", "•").
    next(id, lvl) {
      const levels = nums.get(id);
      const def = levels?.get(lvl);
      if (!def || id === '0') return '';
      const c = counters.get(id) ?? [];
      c[lvl] = (c[lvl] ?? def.start - 1) + 1;
      c.length = lvl + 1;
      counters.set(id, c);
      if (def.fmt === 'bullet') return BULLETS[def.text] ?? (def.text || '•');
      return def.text.replace(/%(\d)/g, (_, k) => {
        const l = Number(k) - 1;
        return formatNumber(c[l] ?? levels.get(l)?.start ?? 1, levels.get(l)?.fmt);
      });
    },
  };
}

// ---------- the document ----------

const EMU_PX = 9525;
const twipsPt = (t) => Math.round((t / 20) * 10) / 10;
const fixColor = (c) => (/^[0-9a-f]{6}$/i.test(c) ? `#${c.toLowerCase()}` : null);
const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000',
};
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/emf', wmf: 'image/wmf', svg: 'image/svg+xml' };

// A chapter starts at "פרק <letters or number>" (or "פתיחה"), alone on its line.
export const CHAPTER_RE = /^\s*(?:(?:פרק|chapter)\s+[֐-׿0-9a-z]{1,4}['׳"״.]?|פתיחה|prologue)\s*:?\s*$/i;
export const OPENING = 'פתיחה';
const FRONT = '#front';

async function readRels(files, path) {
  const get = files.get(path);
  const rels = new Map();
  if (!get) return rels;
  const xml = parseXml(new TextDecoder().decode(await get()));
  for (const r of find(xml, 'Relationship')) rels.set(r.attrs.Id, { target: r.attrs.Target, type: r.attrs.Type ?? '', external: r.attrs.TargetMode === 'External' });
  return rels;
}

async function readXml(files, path) {
  const get = files.get(path);
  return get ? parseXml(new TextDecoder().decode(await get())) : null;
}

// Read a .docx: { chapters: [{ title, html, images: [key], notes }], front, media: Map(key -> { name, type, bytes() }), skipped: [names], align }.
// `align` is how the document aligns plain text ('justify', 'start'...): paragraphs say only where they differ.
// Chapters split at "פרק ..." and "פתיחה" lines. What comes before the first
// of them is the title page (front): kept apart, since the site shows the
// book's name itself. A book with no such lines is one chapter, the opening.
export async function readDocx(buffer) {
  const files = unzip(buffer);
  if (!files.has('word/document.xml')) throw new Error('This is not a Word file (.docx).');
  const [doc, stylesXml, numberingXml, footXml, endXml, rels] = await Promise.all([
    readXml(files, 'word/document.xml'),
    readXml(files, 'word/styles.xml'),
    readXml(files, 'word/numbering.xml'),
    readXml(files, 'word/footnotes.xml'),
    readXml(files, 'word/endnotes.xml'),
    readRels(files, 'word/_rels/document.xml.rels'),
  ]);
  const st = readStyles(stylesXml);
  const numbering = readNumbering(numberingXml);
  const media = new Map();
  const skipped = [];
  const noteRels = new Map([
    ['foot', await readRels(files, 'word/_rels/footnotes.xml.rels')],
    ['end', await readRels(files, 'word/_rels/endnotes.xml.rels')],
  ]);

  // The document's own base: Normal's size and alignment are what plain text looks like.
  const base = { r: { ...st.defaults.r }, p: { ...st.defaults.p } };
  for (const s of st.chain(st.normal)) {
    Object.assign(base.r, s.r);
    Object.assign(base.p, s.p);
  }
  const baseSize = base.r.szCs ?? base.r.sz ?? 11;
  const ALIGN = { left: 'start', start: 'start', right: 'end', end: 'end', center: 'center', both: 'justify', distribute: 'justify', lowKashida: 'justify', mediumKashida: 'justify', highKashida: 'justify' };
  const baseAlign = ALIGN[base.p.jc] ?? 'start';

  // The stored picture behind a relationship, as <img src="docx:..."> (attrs added as given).
  function imageRef(relId, relMap) {
    const rel = relMap.get(relId);
    if (!rel || rel.external) return null;
    const path = rel.target.startsWith('/') ? rel.target.slice(1) : `word/${rel.target}`.replace(/\/[^/]+\/\.\.\//g, '/');
    const get = files.get(path);
    if (!get) return null;
    const name = path.split('/').pop();
    const ext = name.split('.').pop().toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type || ['image/emf', 'image/wmf', 'image/tiff', 'image/svg+xml'].includes(type)) {
      skipped.push(name);
      return null;
    }
    const key = `img-${path}`;
    if (!media.has(key)) media.set(key, { name, type, bytes: get });
    return `docx:${esc(key)}`;
  }

  // Word's crop (a:srcRect, in thousandths of a percent from each side) as the
  // picture's place inside a box that hides the rest: [left, top, width, height] in %.
  function cropOf(blipFill) {
    const r = kid(blipFill, 'a:srcRect');
    if (!r) return null;
    const [l, t, rr, b] = ['l', 't', 'r', 'b'].map((k) => Number(r.attrs[k] ?? 0) / 100000);
    if (!(l || t || rr || b) || l + rr >= 1 || t + b >= 1) return null;
    const w = 1 - l - rr;
    const h = 1 - t - b;
    return [(-l / w) * 100, (-t / h) * 100, 100 / w, 100 / h];
  }
  const pct = (n) => `${Math.round(n * 100) / 100}%`;
  const cropped = (src, crop) =>
    `<img class="dx-cropped" src="${src}" alt="" style="left:${pct(crop[0])};top:${pct(crop[1])};width:${pct(crop[2])};height:${pct(crop[3])}">`;

  function addImage(relId, relMap, extent, blipFill) {
    const src = imageRef(relId, relMap);
    if (!src) return '';
    const w = extent ? Math.round(Number(extent.attrs.cx) / EMU_PX) : 0;
    const h = extent ? Math.round(Number(extent.attrs.cy) / EMU_PX) : 0;
    const crop = blipFill && w > 0 && h > 0 ? cropOf(blipFill) : null;
    if (crop) return `<span class="dx-crop" style="width:${w}px;aspect-ratio:${w} / ${h}">${cropped(src, crop)}</span>`;
    const size = w > 0 && h > 0 ? ` width="${w}" height="${h}" style="width:${w}px"` : '';
    return `<img src="${src}" alt=""${size}>`;
  }

  // A group drawn in Word (pictures and text boxes laid over each other): one
  // box the size Word gave it, each piece placed in it by percent, so it keeps
  // its composition at any width. Text inside scales with the box.
  function group(wgp, relMap, ctx, w, h) {
    const xfrm = (n) => {
      const x = kid(n, 'a:xfrm');
      if (!x) return null;
      const num = (k, a) => Number(kid(x, k)?.attrs[a] ?? 0);
      return {
        x: num('a:off', 'x'), y: num('a:off', 'y'), cx: num('a:ext', 'cx'), cy: num('a:ext', 'cy'),
        chx: num('a:chOff', 'x'), chy: num('a:chOff', 'y'), chcx: num('a:chExt', 'cx'), chcy: num('a:chExt', 'cy'),
        rot: Number(x.attrs.rot ?? 0) / 60000, flipH: x.attrs.flipH === '1', flipV: x.attrs.flipV === '1',
      };
    };
    const top = xfrm(kid(wgp, 'wpg:grpSpPr'));
    if (!top || !top.chcx || !top.chcy) return '';
    const pieces = [];
    // map: outer fraction = o + s * child coordinate.
    const walk = (node, m) => {
      for (const k of els(node)) {
        if (k.name === 'wpg:grpSp') {
          const t = xfrm(kid(k, 'wpg:grpSpPr'));
          if (!t || !t.chcx || !t.chcy) continue;
          const sx = (m.sx * t.cx) / t.chcx;
          const sy = (m.sy * t.cy) / t.chcy;
          walk(k, { sx, sy, ox: m.ox + m.sx * t.x - sx * t.chx, oy: m.oy + m.sy * t.y - sy * t.chy });
          continue;
        }
        if (k.name !== 'pic:pic' && k.name !== 'wps:wsp') continue;
        const spPr = kid(k, k.name === 'pic:pic' ? 'pic:spPr' : 'wps:spPr');
        const t = xfrm(spPr);
        if (!t || !t.cx || !t.cy) continue;
        const box = [m.ox + m.sx * t.x, m.oy + m.sy * t.y, m.sx * t.cx, m.sy * t.cy].map((v) => v * 100);
        const turn = [t.rot ? `rotate(${Math.round(t.rot * 10) / 10}deg)` : '', t.flipH ? 'scaleX(-1)' : '', t.flipV ? 'scaleY(-1)' : ''].filter(Boolean).join(' ');
        const place = `left:${pct(box[0])};top:${pct(box[1])};width:${pct(box[2])};height:${pct(box[3])}${turn ? `;transform:${turn}` : ''}`;
        let inner = '';
        const blipFill = k.name === 'pic:pic' ? kid(k, 'pic:blipFill') : kid(spPr, 'a:blipFill');
        const blip = kid(blipFill, 'a:blip');
        if (blip) {
          const src = imageRef(blip.attrs['r:embed'] ?? blip.attrs['r:link'], relMap);
          const crop = cropOf(blipFill);
          if (src) inner = crop ? cropped(src, crop) : `<img class="dx-fill" src="${src}" alt="">`;
        }
        for (const tb of find(k, 'w:txbxContent')) inner += blocks(els(tb), relMap, { ...ctx, inBox: true }).join('');
        if (inner) pieces.push(`<div class="dx-at" style="${place}">${inner}</div>`);
      }
    };
    walk(wgp, { sx: 1 / top.chcx, sy: 1 / top.chcy, ox: -top.chx / top.chcx, oy: -top.chy / top.chcy });
    if (!pieces.length) return '';
    const fs = Math.round(baseSize * (4 / 3) * 100) / 100;
    return `<div class="dx-group" style="width:${w}px;aspect-ratio:${w} / ${h};--dx-w:${w};--dx-fs:${fs}">${pieces.join('')}</div>`;
  }

  // A picture (or a group of them, or a text box) inside a run.
  function drawing(node, relMap, ctx) {
    const holder = kid(node, 'wp:inline') ?? kid(node, 'wp:anchor') ?? node;
    const extent = kid(holder, 'wp:extent');
    const anchored = holder.name === 'wp:anchor';
    const wgp = find(holder, 'wpg:wgp')[0];
    if (wgp && extent) {
      const w = Math.round(Number(extent.attrs.cx) / EMU_PX);
      const h = Math.round(Number(extent.attrs.cy) / EMU_PX);
      const html = w > 0 && h > 0 ? group(wgp, relMap, ctx, w, h) : '';
      if (html) {
        ctx.after.push(`<div class="dx-figure">${html}</div>`);
        return '';
      }
    }
    let html = '';
    const blips = find(holder, 'a:blip');
    if (blips.length === 1) {
      const fill = find(holder, 'pic:blipFill')[0] ?? find(holder, 'a:blipFill')[0];
      html = addImage(blips[0].attrs['r:embed'] ?? blips[0].attrs['r:link'], relMap, extent, fill);
    } else for (const b of blips) html += addImage(b.attrs['r:embed'], relMap, null);
    const boxes = find(holder, 'w:txbxContent');
    for (const t of boxes) ctx.after.push(`<div class="dx-box">${blocks(els(t), relMap, { ...ctx, inBox: true }).join('')}</div>`);
    if (!html) return '';
    if (anchored) {
      // A picture the text wraps around keeps its side; one standing alone gets its own line.
      const align = find(holder, 'wp:align')[0]?.kids.join('').trim();
      const wraps = find(holder, 'wp:wrapSquare').length || find(holder, 'wp:wrapTight').length || find(holder, 'wp:wrapThrough').length;
      if (wraps && (align === 'left' || align === 'right')) return html.replace(/^<(img|span) /, `<$1 class="dx-float-${align}" `).replace(/^<span class="dx-float-(\w+)" class="dx-crop"/, '<span class="dx-crop dx-float-$1"');
      ctx.after.push(`<p class="dx-figure">${html}</p>`);
      return '';
    }
    return html;
  }

  // The text of one run, with its look.
  function run(r, ctx, relMap) {
    const props = { ...ctx.pr };
    const rPr = kid(r, 'w:rPr');
    const rs = val(rPr, 'w:rStyle');
    if (rs) for (const s of st.chain(rs)) Object.assign(props, s.r);
    runProps(rPr, props);
    if (props.vanish) return '';
    let out = '';
    for (const k of els(r)) {
      if (ctx.field === 'instr' && k.name !== 'w:fldChar') continue;
      switch (k.name) {
        case 'w:t':
          out += esc(k.kids.join(''));
          break;
        case 'w:tab':
          out += '<span class="dx-tab">\t</span>';
          break;
        case 'w:br':
          if (k.attrs['w:type'] === 'page') ctx.pageBreak = true;
          else out += '<br>';
          break;
        case 'w:cr':
          out += '<br>';
          break;
        case 'w:noBreakHyphen':
          out += '‑';
          break;
        case 'w:sym': {
          const ch = String.fromCharCode(parseInt(k.attrs['w:char'] ?? '0', 16));
          out += esc(BULLETS[ch] ?? (ch < '' ? ch : ''));
          break;
        }
        case 'w:fldChar': {
          const t = k.attrs['w:fldCharType'];
          if (t === 'begin') ctx.field = 'instr';
          else if (t === 'separate') ctx.field = 'result';
          else if (t === 'end') ctx.field = null;
          break;
        }
        case 'w:drawing':
          out += drawing(k, relMap, ctx);
          break;
        case 'w:pict':
        case 'w:object': {
          const img = find(k, 'v:imagedata')[0];
          if (img) out += addImage(img.attrs['r:id'], relMap, null);
          for (const t of find(k, 'w:txbxContent')) ctx.after.push(`<div class="dx-box">${blocks(els(t), relMap, { ...ctx, inBox: true }).join('')}</div>`);
          break;
        }
        case 'mc:AlternateContent': {
          const choice = kid(k, 'mc:Choice') ?? kid(k, 'mc:Fallback');
          if (choice) out += run({ name: 'w:r', attrs: {}, kids: [rPr, ...els(choice)].filter(Boolean) }, ctx, relMap);
          break;
        }
        case 'w:footnoteReference':
        case 'w:endnoteReference': {
          const kind = k.name === 'w:footnoteReference' ? 'foot' : 'end';
          out += ctx.note(kind, k.attrs['w:id']);
          break;
        }
        default:
      }
    }
    if (!out) return '';
    return styleRun(out, props);
  }

  function styleRun(html, props) {
    const heb = HEB.test(html);
    const bold = heb ? (props.bCs ?? props.b) : (props.b ?? props.bCs);
    const italic = heb ? (props.iCs ?? props.i) : (props.i ?? props.iCs);
    const size = heb ? (props.szCs ?? props.sz) : (props.sz ?? props.szCs);
    const css = [];
    if (size && Math.abs(size - baseSize) >= 0.5) css.push(`font-size:${Math.round((size / baseSize) * 1000) / 1000}em`);
    const color = props.color && props.color !== 'auto' ? fixColor(props.color) : null;
    if (color && color !== '#000000') css.push(`color:${color}`);
    const bg = HIGHLIGHT[props.highlight] ?? (props.shd ? fixColor(props.shd) : null);
    if (bg && bg !== '#ffffff') css.push(`background-color:${bg}`);
    if (props.caps) css.push('text-transform:uppercase');
    if (props.smallCaps) css.push('font-variant:small-caps');
    let out = html;
    // A note mark is a superscript already.
    if (props.vertAlign === 'superscript' && /^<sup class="dx-note">[^]*<\/sup>$/.test(html)) props = { ...props, vertAlign: null };
    if (props.vertAlign === 'superscript') out = `<sup>${out}</sup>`;
    else if (props.vertAlign === 'subscript') out = `<sub>${out}</sub>`;
    if (props.strike || props.dstrike) out = `<s>${out}</s>`;
    if (props.u) out = `<u>${out}</u>`;
    if (italic) out = `<em>${out}</em>`;
    if (bold) out = `<strong>${out}</strong>`;
    if (css.length) out = `<span style="${css.join(';')}">${out}</span>`;
    return out;
  }

  // Everything inline inside a paragraph (runs, links, tracked insertions...).
  function inline(nodes, ctx, relMap) {
    let out = '';
    for (const n of nodes) {
      switch (n.name) {
        case 'w:r':
          out += run(n, ctx, relMap);
          break;
        case 'w:hyperlink': {
          const inner = inline(els(n), ctx, relMap);
          const rel = relMap.get(n.attrs['r:id']);
          const href = rel?.external && /^(https?:|mailto:)/i.test(rel.target) ? rel.target : null;
          out += href ? `<a href="${esc(href)}">${inner}</a>` : inner;
          break;
        }
        case 'w:ins':
        case 'w:smartTag':
        case 'w:customXml':
        case 'w:fldSimple':
        case 'w:sdtContent':
        case 'w:dir':
        case 'w:bdo':
          out += inline(els(n), ctx, relMap);
          break;
        case 'w:sdt':
          out += inline(els(kid(n, 'w:sdtContent')), ctx, relMap);
          break;
        case 'mc:AlternateContent': {
          const choice = kid(n, 'mc:Choice') ?? kid(n, 'mc:Fallback');
          if (choice) out += inline(els(choice), ctx, relMap);
          break;
        }
        default:
      }
    }
    return out;
  }

  function paragraphLook(p) {
    const pPr = kid(p, 'w:pPr');
    const styleId = val(pPr, 'w:pStyle') ?? st.normal;
    const pp = { ...st.defaults.p };
    const pr = { ...st.defaults.r };
    const chain = st.chain(styleId);
    for (const s of chain) {
      Object.assign(pp, s.p);
      Object.assign(pr, s.r);
    }
    const direct = paraProps(pPr);
    const numDef = (direct.num ?? pp.num) ? numbering.level((direct.num ?? pp.num).id, (direct.num ?? pp.num).lvl) : null;
    if (numDef) Object.assign(pp, numDef.p);
    Object.assign(pp, direct);
    // The paragraph mark's run properties are the base for its runs only when the style says so; Word applies the style's.
    const top = chain[chain.length - 1];
    const name = top?.name ?? '';
    let heading = null;
    const hm = name.match(/^(heading|כותרת)\s*(\d)$/);
    if (hm) heading = Number(hm[2]);
    else if (name === 'title') heading = 1;
    else if (pp.outline !== undefined && pp.outline < 6) heading = pp.outline + 1;
    return { pp, pr, heading, styleName: name };
  }

  function paraCss(pp) {
    const css = [];
    const align = ALIGN[pp.jc];
    // Text aligned as the document's plain text is says nothing; the page aligns the whole chapter that way.
    if ((align ?? baseAlign) !== baseAlign) css.push(`text-align:${align ?? 'start'}`);
    if (pp.indStart) css.push(`margin-inline-start:${twipsPt(pp.indStart)}pt`);
    if (pp.indEnd) css.push(`margin-inline-end:${twipsPt(pp.indEnd)}pt`);
    if (pp.firstLine) css.push(`text-indent:${twipsPt(pp.firstLine)}pt`);
    if (pp.hanging) css.push(`text-indent:-${twipsPt(pp.hanging)}pt`);
    return css;
  }

  // One paragraph: [html blocks...]
  function paragraph(p, relMap, ctx) {
    const look = paragraphLook(p);
    const local = { ...ctx, pr: look.pr, after: [], pageBreak: false, field: null };
    let text = inline(els(p), local, relMap);
    const num = look.pp.num;
    if (num && num.id && num.id !== '0') {
      const marker = numbering.next(num.id, num.lvl);
      if (marker) text = `<span class="dx-num">${esc(marker)}</span>${text}`;
    }
    const plain = textOf(p).replace(/\s+/g, ' ').trim();
    const css = paraCss(look.pp);
    const dir = look.pp.bidi === false && !HEB.test(plain) ? ' dir="ltr"' : '';
    const tag = look.heading && look.heading <= 4 && !ctx.inBox ? `h${Math.min(look.heading + 1, 4)}` : 'p';
    const out = [];
    if (look.pp.pageBreakBefore && !ctx.inBox) out.push({ pageBreak: true });
    const body = text.replace(/(<br>)+$/, '');
    const empty = !plain && !/<img /.test(body);
    out.push({
      html: empty ? '<p class="dx-gap"></p>' : `<${tag}${css.length ? ` style="${css.join(';')}"` : ''}${dir}>${body}</${tag}>`,
      plain,
      heading: look.heading,
      empty,
    });
    for (const a of local.after) out.push({ html: a, plain: '' });
    if (local.pageBreak && !ctx.inBox) out.push({ pageBreak: true });
    return out;
  }

  function table(tbl, relMap, ctx) {
    const rows = kidsNamed(tbl, 'w:tr').map((tr) => {
      const cells = kidsNamed(tr, 'w:tc').map((tc) => {
        const tcPr = kid(tc, 'w:tcPr');
        const span = Number(val(tcPr, 'w:gridSpan') ?? 1);
        const merged = kid(tcPr, 'w:vMerge') && kid(tcPr, 'w:vMerge').attrs['w:val'] !== 'restart';
        const inner = blocks(els(tc), relMap, { ...ctx, inBox: true }).join('');
        return `<td${span > 1 ? ` colspan="${span}"` : ''}>${merged ? '' : inner}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    });
    return `<table class="dx-table"><tbody>${rows.join('')}</tbody></table>`;
  }

  // Block content (a body, a cell, a text box) as html strings.
  function blocks(nodes, relMap, ctx) {
    const out = [];
    for (const n of nodes) {
      if (n.name === 'w:p') for (const b of paragraph(n, relMap, ctx)) b.html && out.push(b.html);
      else if (n.name === 'w:tbl') out.push(table(n, relMap, ctx));
      else if (n.name === 'w:sdt') out.push(...blocks(els(kid(n, 'w:sdtContent')), relMap, ctx));
      else if (n.name === 'w:customXml' || n.name === 'w:ins') out.push(...blocks(els(n), relMap, ctx));
    }
    return out;
  }

  // Notes: each one is read when its mark is met, so a chapter carries its own.
  const noteBodies = { foot: new Map(), end: new Map() };
  for (const [kind, xml, tag] of [['foot', footXml, 'w:footnote'], ['end', endXml, 'w:endnote']]) {
    for (const n of find(xml, tag)) {
      const type = n.attrs['w:type'];
      if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue;
      noteBodies[kind].set(n.attrs['w:id'], n);
    }
  }

  // Walk the body, splitting into chapters.
  const body = kid(kid(doc, 'w:document'), 'w:body');
  const chapters = [];
  let current = { title: FRONT, parts: [], notes: [] };
  let front = null;
  let noteCount = 0;
  const ctxFor = () => ({
    pr: {},
    after: [],
    note(kind, id) {
      const n = noteBodies[kind].get(id);
      if (!n) return '';
      noteCount += 1;
      const no = noteCount;
      const chapter = current;
      const relMap = noteRels.get(kind);
      // Inside the note the reference mark is the note's own number.
      const html = blocks(els(n), relMap, { ...ctxFor(), inBox: true, note: () => `<sup>${no}</sup>` })
        .join('\n')
        .replace(/^<p([^>]*)>/, `<p$1><sup>${no}</sup> `);
      chapter.notes.push({ no, html });
      return `<sup class="dx-note"><a href="#n-${no}" id="r-${no}">${no}</a></sup>`;
    },
  });
  const flush = () => {
    const parts = current.parts.slice();
    while (parts.length && parts[0].empty) parts.shift();
    while (parts.length && parts[parts.length - 1].empty) parts.pop();
    if (!parts.length && !current.notes.length && current.title === FRONT) return;
    let html = parts.map((x) => x.html).join('\n');
    if (current.notes.length) {
      html += `\n<hr class="dx-notes-rule">\n<h3 class="dx-notes-title">הערות</h3>\n${current.notes
        .map((n) => n.html.replace(/^<p([^>]*)>/, `<p$1 id="n-${n.no}" class="dx-note-text">`))
        .join('\n')}`;
    }
    const images = [...html.matchAll(/src="docx:([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const chapter = { title: current.title, html, images: [...new Set(images)], notes: current.notes.length };
    if (chapter.title === FRONT) front = chapter;
    else chapters.push(chapter);
  };

  const top = els(body).flatMap((n) => (n.name === 'w:sdt' ? els(kid(n, 'w:sdtContent')) : [n]));
  for (const n of top) {
    if (n.name === 'w:tbl') {
      current.parts.push({ html: table(n, rels, ctxFor()), plain: 'table' });
      continue;
    }
    if (n.name !== 'w:p') continue;
    const plain = textOf(n).replace(/\s+/g, ' ').trim();
    if (CHAPTER_RE.test(plain)) {
      flush();
      current = { title: plain.replace(/\s*:$/, '').replace(/['׳"״.]$/, ''), parts: [], notes: [] };
      continue;
    }
    const ctx = ctxFor();
    for (const b of paragraph(n, rels, ctx)) {
      if (b.pageBreak) continue;
      current.parts.push(b);
    }
  }
  flush();
  if (!chapters.length && front) {
    front.title = OPENING;
    chapters.push(front);
    front = null;
  }
  // How plain text sits: alignment, the space between paragraphs (pt) and line height.
  const gap = twipsPt((base.p.before ?? 0) + (base.p.after ?? 0));
  const line = base.p.line && (base.p.lineRule ?? 'auto') === 'auto' ? Math.round((base.p.line / 240) * 1.2 * 100) / 100 : null;
  return { chapters, front, media, skipped: [...new Set(skipped)], align: baseAlign, look: { align: baseAlign, gap, ...(line ? { line } : {}) } };
}

// Put stored addresses in place of the docx: placeholders.
export function placeImages(html, urls) {
  return html.replace(/src="docx:([^"]+)"/g, (m, key) => {
    const url = urls.get(key.replace(/&amp;/g, '&'));
    return url ? `src="${esc(url)}"` : m;
  });
}
