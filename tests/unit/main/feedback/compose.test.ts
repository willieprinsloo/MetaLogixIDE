import { describe, expect, it } from 'vitest';
import { composeTicket } from '@main/feedback/compose';
import type { FeedbackReport } from '@shared/feedback';

const base: Omit<FeedbackReport, 'source'> = {
  type: 'bug',
  title: 'ctrl+v does not paste in the terminal',
  description: 'On Windows 11 nothing happens when I press Ctrl+V.',
  context: {
    appVersion: '0.3.6',
    osPlatform: 'win32',
    osRelease: '10.0.22631',
    terminalEngine: 'xterm',
    composedAt: '2026-11-27T12:00:00.000Z',
  },
};

describe('composeTicket', () => {
  it('prefixes the title with [bug] or [idea] so a reader scanning the board can tell them apart', () => {
    const bug = composeTicket({ ...base, type: 'bug', source: { kind: 'user' } });
    expect(bug.name.startsWith('[bug] ')).toBe(true);
    const idea = composeTicket({ ...base, type: 'idea', source: { kind: 'user' } });
    expect(idea.name.startsWith('[idea] ')).toBe(true);
  });

  it('labels a user report `user-feedback` and an agent report `agent-reported`', () => {
    expect(composeTicket({ ...base, source: { kind: 'user' } }).labels).toEqual(['user-feedback']);
    expect(composeTicket({ ...base, source: { kind: 'agent', agent: 'claude', shellIndex: 0 } }).labels).toEqual(['agent-reported']);
  });

  it('names the agent + shell on the body for agent reports — the human reader needs to know who filed it', () => {
    const body = composeTicket({ ...base, source: { kind: 'agent', agent: 'claude', shellIndex: 2 } }).body;
    expect(body).toContain('**claude**');
    expect(body).toContain('shell 2');
  });

  it('keeps the agent shell suffix off when it is 0 — the common case stays quiet', () => {
    const body = composeTicket({ ...base, source: { kind: 'agent', agent: 'codex', shellIndex: 0 } }).body;
    expect(body).toContain('**codex**');
    expect(body).not.toContain('shell');
  });

  it('skips the "What happened" heading when the description is blank so empty-body reports still read cleanly', () => {
    const body = composeTicket({ ...base, description: '   ', source: { kind: 'user' } }).body;
    expect(body).not.toContain('## What happened');
    expect(body).toContain('## Environment');
  });

  it('always lists version, OS and terminal engine in the environment block', () => {
    const body = composeTicket({ ...base, source: { kind: 'user' } }).body;
    expect(body).toContain('0.3.6');
    expect(body).toContain('Windows');
    expect(body).toContain('xterm');
  });

  it('ellipsizes titles beyond the shared cap rather than silently truncating', () => {
    const long = 'a'.repeat(300);
    const t = composeTicket({ ...base, title: long, source: { kind: 'user' } });
    expect(t.name.endsWith('…')).toBe(true);
    expect(t.name.length).toBeLessThanOrEqual(160);
  });
});
