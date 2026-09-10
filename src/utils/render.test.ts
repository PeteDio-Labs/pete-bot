/**
 * PET-384 UC-2 — a long answer keeps its ending.
 *
 * Both surfaces used to do `text.slice(0, 3997) + '...'`. mtrace's deepest answers are
 * exactly the long ones — a trace across six hosts — and a trace puts its conclusion
 * last. Truncating drops the answer and keeps the preamble.
 */
import { describe, it, expect } from 'vitest';
import { answerEmbeds, EMBED_DESCRIPTION_LIMIT, MAX_EMBEDS } from './render.js';

function bodies(embeds: ReturnType<typeof answerEmbeds>): string[] {
  return embeds.map((e) => e.data.description ?? '');
}

describe('answerEmbeds', () => {
  it('renders a short answer as one embed', () => {
    const embeds = answerEmbeds('plex is up');
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.data.description).toBe('plex is up');
  });

  it('keeps the last character of a long answer', () => {
    const text = `${'a'.repeat(9000)}THE-CONCLUSION`;
    const joined = bodies(answerEmbeds(text)).join('');
    expect(joined.endsWith('THE-CONCLUSION')).toBe(true);
  });

  it('loses nothing in the middle either', () => {
    const text = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    expect(bodies(answerEmbeds(text)).join('')).toBe(text);
  });

  it('keeps every page inside Discord embed limits', () => {
    const embeds = answerEmbeds('x'.repeat(20_000));
    for (const e of embeds) {
      expect((e.data.description ?? '').length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    }
    expect(embeds.length).toBeGreaterThan(1);
  });

  it('prefers to break on a newline rather than mid-word', () => {
    const para = `${'a'.repeat(3990)}\n${'b'.repeat(3000)}`;
    const [first] = bodies(answerEmbeds(para));
    expect(first).toBe('a'.repeat(3990));
  });

  it('footers only the last page, so the timing reads once', () => {
    const embeds = answerEmbeds('y'.repeat(9000), 'routed by keyword · 6.8s');
    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds[0]!.data.footer).toBeUndefined();
    expect(embeds.at(-1)!.data.footer?.text).toBe('routed by keyword · 6.8s');
  });

  it('caps the page count and says so, rather than posting forever', () => {
    const embeds = answerEmbeds('z'.repeat(EMBED_DESCRIPTION_LIMIT * (MAX_EMBEDS + 5)));
    expect(embeds).toHaveLength(MAX_EMBEDS);
    expect(embeds.at(-1)!.data.description).toMatch(/truncated/i);
  });

  it('never returns an empty embed for an empty answer', () => {
    const embeds = answerEmbeds('');
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.data.description).toBeTruthy();
  });
});
