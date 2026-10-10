import { describe, it, expect } from 'vitest';
import { renderChords } from '../src/chords.js';

describe('chord sheets', () => {
  it('renders a run of chords in one bracket as a chord row', () => {
    const html = renderChords('[C - F - G - C      Gaug]');
    expect(html).toContain('class="line chordline"');
    expect(html).toContain('<span class="ch">Gaug</span>');
    expect(html).not.toContain('class="seg"');
  });

  it('keeps a single bracketed chord and inline chords as they were', () => {
    expect(renderChords('[Am]')).toContain('class="seg"');
    expect(renderChords('[F]שלום [C]עולם')).toContain('<span class="ch">C</span><span>עולם</span>');
  });
});
