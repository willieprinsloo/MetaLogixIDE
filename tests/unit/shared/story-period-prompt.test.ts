import { describe, it, expect } from 'vitest';
import {
  PERIOD_MAX_EVENTS,
  buildPeriodPrompt,
  parsePeriodReply,
} from '@shared/story-period-prompt';

function baseInput() {
  return {
    projectName: 'metaIDE',
    periodIndex: 2,
    periodCount: 5,
    startLabel: '14:30',
    endLabel: '15:05',
    durationLabel: '35 min',
    intents: ['claude#0 — writing tests'],
    editedFiles: ['foo.ts', 'bar.ts'],
    counts: { actions: 42, edits: 7, tests: 2, turnsEnded: 1 },
    events: [
      { ts: '2026-11-24T14:30:05.000Z', kind: 'edit', who: 'claude#0', text: 'foo.ts' },
      { ts: '2026-11-24T14:31:00.000Z', kind: 'test', who: 'claude#0', text: 'pnpm test' },
    ],
    humanQuotes: ['make sure the suite passes'],
  };
}

describe('buildPeriodPrompt', () => {
  it('names the project, the period index/count and the time range', () => {
    const p = buildPeriodPrompt(baseInput());
    expect(p).toContain('metaIDE');
    expect(p).toContain('period 2 of 5');
    expect(p).toContain('14:30 → 15:05');
    expect(p).toContain('35 min');
  });

  it('carries intents, edited files and human quotes verbatim', () => {
    const p = buildPeriodPrompt(baseInput());
    expect(p).toContain('claude#0 — writing tests');
    expect(p).toContain('`foo.ts`');
    expect(p).toContain('`bar.ts`');
    expect(p).toContain('"make sure the suite passes"');
  });

  it('asks for the strict HEADLINE: / paragraph output shape', () => {
    const p = buildPeriodPrompt(baseInput());
    expect(p).toMatch(/HEADLINE:/);
    expect(p).toMatch(/one paragraph, 2-3 sentences/);
  });

  it('shows the empty-intent fallback when there is no stated intent', () => {
    const p = buildPeriodPrompt({ ...baseInput(), intents: [] });
    expect(p).toContain('_(no stated intent in this period)_');
  });

  it('trims the event log to PERIOD_MAX_EVENTS and leaves a note', () => {
    const many = Array.from({ length: PERIOD_MAX_EVENTS + 5 }, (_, i) => ({
      ts: `2026-11-24T14:${String(30 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      kind: 'tool',
      who: 'claude#0',
      text: `event-${i}`,
    }));
    const p = buildPeriodPrompt({ ...baseInput(), events: many });
    expect(p).toMatch(/trimmed to the most recent 40/);
    // The oldest ones are dropped; event-0 shouldn't appear.
    expect(p).not.toContain('event-0 ');
    expect(p).toContain(`event-${PERIOD_MAX_EVENTS + 4}`);
  });
});

describe('parsePeriodReply', () => {
  it('splits the standard HEADLINE: / paragraph reply', () => {
    const out = parsePeriodReply('HEADLINE: Ported Ghostty tests\n\nClaude copied the renderer tests and ran the suite. Everything green.');
    expect(out.headline).toBe('Ported Ghostty tests');
    expect(out.paragraph).toBe('Claude copied the renderer tests and ran the suite. Everything green.');
  });

  it('tolerates a markdown code fence wrapping the whole reply', () => {
    const out = parsePeriodReply('```\nHEADLINE: A short run\n\nIt did a thing.\n```');
    expect(out.headline).toBe('A short run');
    expect(out.paragraph).toBe('It did a thing.');
  });

  it('strips bold markers and trailing punctuation from the headline', () => {
    const out = parsePeriodReply('**HEADLINE: Fixed the bug.**\n\nBody.');
    expect(out.headline).toBe('Fixed the bug');
  });

  it('falls back to the first line as headline when no HEADLINE: marker is present', () => {
    const out = parsePeriodReply('Tightened the diff view\n\nSome body copy here.');
    expect(out.headline).toBe('Tightened the diff view');
    expect(out.paragraph).toBe('Some body copy here.');
  });

  it('joins a multi-paragraph body into a single paragraph (we only render one)', () => {
    const out = parsePeriodReply('HEADLINE: Did a thing\n\nFirst sentence.\n\nSecond sentence.');
    expect(out.paragraph).toBe('First sentence. Second sentence.');
  });

  it('strips bullet markers and markdown headers inside the body', () => {
    const out = parsePeriodReply('HEADLINE: Something\n\n- first line\n* second line\n# header\n> quoted body');
    // The cleaner keeps the text, drops the leading markers; `>` is not
    // special, so quoted bodies pass through as a line.
    expect(out.paragraph.toLowerCase()).toContain('first line');
    expect(out.paragraph.toLowerCase()).toContain('second line');
    expect(out.paragraph).not.toMatch(/^[-*+] /);
    expect(out.paragraph).not.toMatch(/^# /);
  });

  it('returns empty strings for an empty reply', () => {
    expect(parsePeriodReply('')).toEqual({ headline: '', paragraph: '' });
    expect(parsePeriodReply('   \n   ')).toEqual({ headline: '', paragraph: '' });
  });
});
