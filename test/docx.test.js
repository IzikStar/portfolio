import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readDocx, placeImages, parseXml, unzip } from '../public/docx.js';

// A zip built by hand: enough of the format for unzip() to read.
function zip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const data = deflateRawSync(raw);
    const n = enc.encode(name);
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    Buffer.from(n).copy(local, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    Buffer.from(n).copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const size = centrals.reduce((s, c) => s + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const NS = 'xmlns:w="w" xmlns:r="r" xmlns:wp="wp" xmlns:a="a" xmlns:pic="pic" xmlns:wpg="wpg" xmlns:wps="wps" xmlns:mc="mc"';
const p = (text, pPr = '', rPr = '') => `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const picture = (rid, cx, cy) =>
  `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

function book(bodyXml, extra = {}) {
  return zip({
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`,
    'word/styles.xml': `<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:bidi/><w:jc w:val="both"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`,
    'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId5" Type="image" Target="media/image1.png"/><Relationship Id="rId6" Type="image" Target="media/image2.emf"/><Relationship Id="rId7" Type="hyperlink" Target="https://example.com/x?a=1&amp;b=2" TargetMode="External"/></Relationships>`,
    'word/media/image1.png': new Uint8Array([137, 80, 78, 71]),
    'word/media/image2.emf': new Uint8Array([1, 2, 3]),
    ...extra,
  });
}

describe('xml and zip', () => {
  it('reads elements, attributes, entities and CDATA', () => {
    const x = parseXml('<?xml version="1.0"?><a k="1 &amp; 2"><b/>x &lt; y<![CDATA[<raw>]]></a>');
    const a = x.kids[0];
    expect(a.name).toBe('a');
    expect(a.attrs.k).toBe('1 & 2');
    expect(a.kids[0].name).toBe('b');
    expect(a.kids.slice(1).join('')).toBe('x < y<raw>');
  });
  it('lists and inflates the files in a zip', async () => {
    const files = unzip(zip({ 'a.txt': 'שלום', 'b/c.txt': 'x' }));
    expect([...files.keys()]).toEqual(['a.txt', 'b/c.txt']);
    expect(new TextDecoder().decode(await files.get('a.txt')())).toBe('שלום');
  });
  it('refuses what is not a zip', () => {
    expect(() => unzip(new Uint8Array(40))).toThrow(/Word/);
  });
});

describe('readDocx', () => {
  it('splits at chapter lines and keeps the title page apart', async () => {
    const doc = await readDocx(
      book(
        p('הרפתקאות גרגמיץ', '<w:jc w:val="center"/>') +
          p('פתיחה') +
          p('היה זה יום שני.') +
          p('♦♦♦', '<w:jc w:val="center"/>') +
          p('פרק א') +
          p('פודינג וניל') +
          p('פרק ב׳') +
          p('סוף.'),
      ),
    );
    expect(doc.front.html).toContain('הרפתקאות גרגמיץ');
    expect(doc.align).toBe('justify');
    expect(doc.look).toEqual({ align: 'justify', gap: 0 });
    expect(doc.chapters.map((c) => c.title)).toEqual(['פתיחה', 'פרק א', 'פרק ב']);
    expect(doc.chapters[0].html).toContain('<p>היה זה יום שני.</p>');
    expect(doc.chapters[0].html).toContain('<p style="text-align:center">♦♦♦</p>');
  });

  it('keeps alignment, indents, sizes, bold (Hebrew uses the complex-script flags) and color', async () => {
    const doc = await readDocx(
      book(
        p('פרק א') +
          p('כותרת משנה', '<w:jc w:val="center"/><w:ind w:right="720" w:firstLine="360"/>', '<w:bCs/><w:szCs w:val="36"/><w:color w:val="C00000"/>') +
          p('רגיל', '<w:jc w:val="left"/>', '<w:b w:val="0"/><w:iCs/>'),
      ),
    );
    const html = doc.chapters[0].html;
    expect(html).toContain('<p style="text-align:center;margin-inline-end:36pt;text-indent:18pt"><span style="font-size:1.5em;color:#c00000"><strong>כותרת משנה</strong></span></p>');
    // The document is justified by default, so a start-aligned paragraph says so.
    expect(html).toContain('<p style="text-align:start"><em>רגיל</em></p>');
  });

  it('turns pictures into placeholders with their size, and skips formats a browser cannot show', async () => {
    const doc = await readDocx(book(p('פרק א') + picture('rId5', 952500, 476250) + picture('rId6', 9525, 9525)));
    const ch = doc.chapters[0];
    expect(ch.html).toContain('<p style="text-align:center"><img src="docx:img-word/media/image1.png" alt="" width="100" height="50" style="width:100px"></p>');
    expect(ch.images).toEqual(['img-word/media/image1.png']);
    expect(doc.skipped).toEqual(['image2.emf']);
    const m = doc.media.get('img-word/media/image1.png');
    expect(m.type).toBe('image/png');
    expect([...(await m.bytes())]).toEqual([137, 80, 78, 71]);
    expect(placeImages(ch.html, new Map([['img-word/media/image1.png', '/files/abc']]))).toContain('src="/files/abc"');
  });

  it('lays out a group drawn in Word as one box, pieces in place, crops kept', async () => {
    const xf = (x, y, cx, cy, more = '') => `<a:xfrm${more}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
    const pic = (rid, x, y, cx, cy, fill = '', more = '') => `<pic:pic><pic:blipFill><a:blip r:embed="${rid}"/>${fill}</pic:blipFill><pic:spPr>${xf(x, y, cx, cy, more)}</pic:spPr></pic:pic>`;
    const grp = `<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><wp:anchor><wp:extent cx="1905000" cy="952500"/><a:graphic><a:graphicData><wpg:wgp>
      <wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/><a:chOff x="1000" y="2000"/><a:chExt cx="2000" cy="1000"/></a:xfrm></wpg:grpSpPr>
      ${pic('rId5', 1000, 2000, 2000, 1000)}
      ${pic('rId5', 2000, 2500, 500, 250, '<a:srcRect l="25000" r="25000"/>', ' flipH="1"')}
      <wps:wsp><wps:spPr>${xf(1500, 2200, 1000, 400)}</wps:spPr><wps:txbx><w:txbxContent>${p('כותרת', '<w:jc w:val="center"/>')}</w:txbxContent></wps:txbx></wps:wsp>
      <wpg:grpSp><wpg:grpSpPr><a:xfrm><a:off x="1000" y="2000"/><a:ext cx="1000" cy="500"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></wpg:grpSpPr>${pic('rId5', 50, 50, 50, 50)}</wpg:grpSp>
      </wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p>`;
    const doc = await readDocx(book(p('פרק א') + grp));
    const html = doc.chapters[0].html;
    const src = 'src="docx:img-word/media/image1.png"';
    expect(html).toContain('<div class="dx-figure"><div class="dx-group" style="width:200px;aspect-ratio:200 / 100;--dx-w:200;--dx-fs:16">');
    expect(html).toContain(`<div class="dx-at" style="left:0%;top:0%;width:100%;height:100%"><img class="dx-fill" ${src} alt=""></div>`);
    expect(html).toContain(`<div class="dx-at" style="left:50%;top:50%;width:25%;height:25%;transform:scaleX(-1)"><img class="dx-cropped" ${src} alt="" style="left:-50%;top:0%;width:200%;height:100%"></div>`);
    expect(html).toContain('<div class="dx-at" style="left:25%;top:20%;width:50%;height:40%"><p style="text-align:center">כותרת</p></div>');
    expect(html).toContain('<div class="dx-at" style="left:25%;top:25%;width:25%;height:25%">');
    expect(html).not.toContain('dx-box');
    expect(doc.chapters[0].images).toEqual(['img-word/media/image1.png']);
  });

  it('numbers footnotes through the book and gathers each chapter\'s notes at its end', async () => {
    const ref = (id) => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
    const notes = `<w:footnotes ${NS}><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>הערה אחת</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>הערה שתיים</w:t></w:r></w:p><w:p><w:r><w:t>המשך</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const doc = await readDocx(
      book(p('פרק א') + `<w:p><w:r><w:t>מילה</w:t></w:r>${ref(1)}</w:p>` + p('פרק ב') + `<w:p><w:r><w:t>עוד</w:t></w:r>${ref(2)}</w:p>`, { 'word/footnotes.xml': notes }),
    );
    const [a, b] = doc.chapters;
    expect(a.html).toContain('מילה<sup class="dx-note"><a href="#n-1" id="r-1">1</a></sup>');
    expect(a.html).toContain('<h3 class="dx-notes-title">הערות</h3>');
    expect(a.html).toContain('<p id="n-1" class="dx-note-text"><sup>1</sup> הערה אחת</p>');
    expect(b.html).toContain('href="#n-2"');
    expect(b.html).toContain('<p id="n-2" class="dx-note-text"><sup>2</sup> הערה שתיים</p>\n<p>המשך</p>');
    expect(a.notes).toBe(1);
  });

  it('writes list markers as Word counts them, Hebrew letters too', async () => {
    const numbering = `<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:right="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="hebrew1"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const item = (n, t) => p(t, `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${n}"/></w:numPr>`);
    const doc = await readDocx(book(p('פרק א') + item(1, 'הגומי זינק') + item(1, 'שני') + item(2, 'א') + item(2, 'ב'), { 'word/numbering.xml': numbering }));
    const html = doc.chapters[0].html;
    expect(html).toContain('<p style="margin-inline-end:36pt;text-indent:-18pt"><span class="dx-num">1.</span>הגומי זינק</p>');
    expect(html).toContain('<span class="dx-num">2.</span>שני');
    expect(html).toContain('<span class="dx-num">ב)</span>ב');
  });

  it('keeps links, line breaks and empty lines, and drops deleted or hidden text', async () => {
    const doc = await readDocx(
      book(
        p('פרק א') +
          `<w:p><w:hyperlink r:id="rId7"><w:r><w:t>קישור</w:t></w:r></w:hyperlink><w:r><w:br/><w:t>שורה</w:t></w:r><w:del><w:r><w:delText>נמחק</w:delText></w:r></w:del><w:r><w:rPr><w:vanish/></w:rPr><w:t>מוסתר</w:t></w:r></w:p>` +
          '<w:p/>' +
          p('אחרי'),
      ),
    );
    const html = doc.chapters[0].html;
    expect(html).toContain('<a href="https://example.com/x?a=1&amp;b=2">קישור</a><br>שורה</p>');
    expect(html).not.toContain('נמחק');
    expect(html).not.toContain('מוסתר');
    expect(html).toContain('<p class="dx-gap"></p>');
  });

  it('makes one opening chapter from a book with no chapter lines', async () => {
    const doc = await readDocx(book(p('רק טקסט')));
    expect(doc.front).toBeNull();
    expect(doc.chapters.map((c) => c.title)).toEqual(['פתיחה']);
  });
});
