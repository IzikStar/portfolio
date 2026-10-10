// Lyrics with chords, as a song is usually written in a Drive doc. Two styles
// work, mixed freely:
//   inline (ChordPro):  "[Am]Shalom [F]olam"   chords sit above the word they precede
//   chords over lyrics: a line of chords alone, then the lyric line under it
// Plus a few ChordPro directives: {c: Chorus}, {soc} ... {eoc}, {title: ...}.
// Every chord is a <span class="ch"> so the page can transpose it.
import { escapeHtml as e } from './markdown.js';

const CHORD = /^[A-H](?:#|b)?(?:maj|min|m|dim|aug|sus|add|M)?[0-9]*(?:(?:maj|sus|add|b|#|\+|-)[0-9]*)*(?:\([^)]*\))?(?:\/[A-H](?:#|b)?)?$/;

export function isChord(token) {
  return CHORD.test(token);
}

function isChordLine(line) {
  const tokens = line.replace(/[|()]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => isChord(t) || /^(x\d|%|-+|\.+)$/i.test(t));
}

const ch = (c) => `<span class="ch">${e(c)}</span>`;

function inlineLine(line) {
  // "[Am]word [F]other" -> segments, each a chord over the text after it.
  const parts = line.split(/\[([^\]]{1,16})\]/);
  let out = parts[0] ? `<span class="seg"><span class="ch"></span><span>${e(parts[0])}</span></span>` : '';
  for (let i = 1; i < parts.length; i += 2) {
    const chord = parts[i].trim();
    const text = parts[i + 1] ?? '';
    out += `<span class="seg">${isChord(chord) ? ch(chord) : `<span class="ch">${e(chord)}</span>`}<span>${e(text) || '&nbsp;'}</span></span>`;
  }
  return `<div class="line">${out}</div>`;
}

export function renderChords(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let inChorus = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const directive = line.trim().match(/^\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}$/i);
    if (directive) {
      const [, name, value = ''] = directive;
      const n = name.toLowerCase();
      if (n === 'soc' || n === 'start_of_chorus') {
        if (!inChorus) html += '<div class="chorus">';
        inChorus = true;
      } else if (n === 'eoc' || n === 'end_of_chorus') {
        if (inChorus) html += '</div>';
        inChorus = false;
      } else if (['c', 'comment', 'ci', 'comment_italic'].includes(n) && value) {
        html += `<div class="comment">${e(value)}</div>`;
      }
      continue;
    }
    // A run of chords in one bracket ("[C - F - G - C  Gaug]") is a chord row, not one long chord.
    const run = line.trim().match(/^\[([^\]]+)\]$/);
    const bare = run && /\s/.test(run[1].trim()) && isChordLine(run[1]) ? run[1] : line;
    if (!line.trim()) html += '<div class="gap"></div>';
    else if (bare === line && /\[[^\]]+\]/.test(line)) html += inlineLine(line);
    else if (isChordLine(bare)) {
      html += `<div class="line chordline">${bare.replace(/[^\s]+/g, (t) => (isChord(t) ? ch(t) : e(t)))}</div>`;
    } else html += `<div class="line">${e(line)}</div>`;
  }
  if (inChorus) html += '</div>';
  // Hebrew lyrics read right to left, chord lines included (each chord is isolated in CSS).
  const dir = /[\u0590-\u05FF]/.test(source) ? 'rtl' : 'ltr';
  return `<div class="chords" dir="${dir}">${html}</div>`;
}

// Does this text have any chords in it? (A song page offers the transposer only then.)
export function hasChords(source) {
  const text = String(source ?? '');
  return /\[[A-H][^\]]{0,12}\]/.test(text) || text.split('\n').some((l) => l.trim() && isChordLine(l));
}

// Lyrics and chords filed under another kind (a sketch with a song in it):
// most of it reads as a sheet when at least two lines carry chords and they
// are a good share of the text.
export function isSheet(source) {
  const lines = String(source ?? '').split('\n').filter((l) => l.trim());
  const withChords = lines.filter((l) => isChordLine(l) || /\[[A-H][^\]]{0,12}\]/.test(l)).length;
  return withChords >= 2 && withChords >= lines.length * 0.25;
}

// Hebrew text reads right to left even when a line opens with a Latin chord.
export function textDir(source) {
  return /[\u0590-\u05FF]/.test(String(source ?? '')) ? 'rtl' : 'auto';
}
