/**
 * Unit tests for the Story prompt builder. We care about:
 *  - the shape of the prompt (so Claude reliably produces prose, not bullets)
 *  - truncation of the event log and quotes
 *  - parseStoryReply stripping headings and bullet markers if the model
 *    forgets the "prose only" rule
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_EVENTS,
  buildStoryPrompt,
  parseStoryReply,
  type StoryPromptEvent,
} from '@shared/story-prompt';

function event(ts: string, kind: string, who: string, text: string): StoryPromptEvent {
  return { ts, kind, who, text };
}

const BASE_INPUT = {
  projectName: 'metaIDE',
  windowDescription: '14:30–14:45 · 15 min window',
  intents: ['claude#0 — writing tests', 'codex#1 — refactoring auth'],
  editedFiles: ['src/foo.ts', 'src/bar.ts'],
  counts: {
    shells: 2,
    actions: 37,
    edits: 12,
    tests: 2,
    turnsEnded: 3,
    humanMessages: 1,
    agentMessages: 4,
  },
  events: [
    event('2026-11-25T14:31:12.000Z', 'edit', 'claude#0', 'Edit · foo.ts'),
    event('2026-11-25T14:33:40.000Z', 'test', 'claude#0', 'Bash · pnpm test'),
  ],
  humanQuotes: ['push to git main'],
};

describe('buildStoryPrompt', () => {
  it('includes the project name and the window line', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p).toContain('metaIDE');
    expect(p).toContain('14:30–14:45');
    expect(p).toContain('15 min window');
  });

  it('includes the headline shape so Claude can gauge scale', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p).toContain('2 shells');
    expect(p).toContain('37 actions');
    expect(p).toContain('12 edits');
  });

  it('tells Claude to write prose, not bullets or headers', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p.toLowerCase()).toContain('two to four short paragraphs');
    expect(p.toLowerCase()).toContain('no bullet lists');
    expect(p.toLowerCase()).toContain('no headings');
  });

  it('matches the CLAUDE.md house style rule ("lead with what a human would notice")', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p.toLowerCase()).toContain('lead with');
    expect(p.toLowerCase()).toContain('human would notice');
  });

  it('lists intents and edited files so prose can ground itself', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p).toContain('claude#0 — writing tests');
    expect(p).toContain('`src/foo.ts`');
    expect(p).toContain('`src/bar.ts`');
  });

  it('quotes the human verbatim', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p).toContain('"push to git main"');
  });

  it('prints a placeholder when a slot is empty so Claude does not invent one', () => {
    const p = buildStoryPrompt({
      ...BASE_INPUT,
      intents: [],
      editedFiles: [],
      humanQuotes: [],
    });
    expect(p).toContain('agents did not advertise an intent');
    expect(p).toContain('no files were edited');
    expect(p).toContain('the human was quiet in this window');
  });

  it('includes an event line per event, with HH:MM:SS and kind', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p).toContain('14:31:12  edit');
    expect(p).toContain('14:33:40  test');
    expect(p).toContain('pnpm test');
  });

  it('truncates the event log to the last MAX_EVENTS and flags the cut', () => {
    const events: StoryPromptEvent[] = [];
    for (let i = 0; i < MAX_EVENTS + 20; i += 1) {
      const minute = String(i % 60).padStart(2, '0');
      events.push(event(`2026-11-25T14:${minute}:00.000Z`, 'tool', 'claude#0', `n=${i}`));
    }
    const p = buildStoryPrompt({ ...BASE_INPUT, events });
    expect(p).toContain(`trimmed to the most recent ${MAX_EVENTS}`);
    // The last event is kept, the first (n=0) is dropped.
    expect(p).toContain(`n=${MAX_EVENTS + 19}`);
    expect(p).not.toContain('n=0 ');
  });

  it('wraps the event log in a ``` fence so Claude treats it as data', () => {
    const p = buildStoryPrompt(BASE_INPUT);
    expect(p).toContain('```\n');
    expect(p).toMatch(/```[\s\S]*?```/);
  });

  it('ends with an explicit "start writing now" directive', () => {
    const p = buildStoryPrompt(BASE_INPUT).trim();
    expect(p.endsWith('Start writing now.')).toBe(true);
  });
});

describe('parseStoryReply', () => {
  it('splits paragraphs on blank lines', () => {
    const out = parseStoryReply('First paragraph.\n\nSecond one.\n\nThird.');
    expect(out).toEqual(['First paragraph.', 'Second one.', 'Third.']);
  });

  it('strips leading markdown headers and bullet markers', () => {
    const out = parseStoryReply(
      '# Big heading\n\n- bullet one\n- bullet two with more words\n\n1. numbered\n2. also numbered',
    );
    expect(out).toEqual([
      'Big heading',
      'bullet one bullet two with more words',
      'numbered also numbered',
    ]);
  });

  it('collapses soft-wrapped lines inside a paragraph into one line', () => {
    const out = parseStoryReply('Line one of a wrapped paragraph\nline two of the same paragraph.');
    expect(out).toEqual(['Line one of a wrapped paragraph line two of the same paragraph.']);
  });

  it('returns [] for an empty reply', () => {
    expect(parseStoryReply('')).toEqual([]);
    expect(parseStoryReply('   \n\n  ')).toEqual([]);
  });

  it('handles Windows line endings', () => {
    const out = parseStoryReply('One.\r\n\r\nTwo.');
    expect(out).toEqual(['One.', 'Two.']);
  });
});
