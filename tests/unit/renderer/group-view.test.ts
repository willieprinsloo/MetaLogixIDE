// The group panel's helpers: the status line and the transcript.
// Ported from BotOffice shared/dashboard/test/group-view.test.js (folder matching dropped: groups
// here belong to a project id).
import { describe, it, expect } from 'vitest';
import type { GroupView, MemberInfo } from '@shared/group-chat';
import { lines, statusLine } from '@renderer/group-chat/group-view';

const info = (name: string, engine: MemberInfo['engine'], over: Partial<MemberInfo> = {}): MemberInfo =>
  ({ name, kind: engine === 'claude' ? 'claude-tab' : 'headless', engine, model: null, available: true, phase: null, ...over });
const G = (over: Partial<GroupView> = {}): GroupView => ({
  id: 'g1', projectId: 1, projectName: 'shop', name: 'Group chat 1', members: ['boss', 'gpt'], maxRounds: 4,
  status: 'idle', round: null, k: 0, seq: 0, held: [], joined: [], log: [], createdAt: '', updatedAt: '',
  memberInfo: { boss: info('Folder review (Claude)', 'claude'), gpt: info('Review (GPT)', 'codex'), llama: info('Notes (Ollama)', 'ollama') },
  ...over,
});

describe('statusLine', () => {
  it('Ready, the round and who it waits for, or how it ended', () => {
    expect(statusLine(G())).toBe('Ready');
    expect(statusLine(G({ status: 'running', k: 2, round: { n: 7, waiting: ['gpt'], answers: {} } }))).toBe('Round 2 of 4 · waiting for Review (GPT)');
    expect(statusLine(G({ status: 'running', k: 1, round: { n: 1, waiting: ['boss', 'gpt', 'llama'], answers: {} } })))
      .toBe('Round 1 of 4 · waiting for Folder review (Claude), Review (GPT) and Notes (Ollama)');
    expect(statusLine(G({ log: [{ at: '', kind: 'end', text: 'Ended after 4 rounds' }] }))).toBe('Ended after 4 rounds');
    expect(statusLine(G({ status: 'stopped', log: [{ at: '', kind: 'end', text: 'Stopped by Martin' }] }))).toBe('Stopped by Martin');
  });

  it('waiting-draft phase reads "waiting for you to send or clear your draft in Main (Claude)"', () => {
    const g = G({
      status: 'running', k: 1, round: { n: 1, waiting: ['boss'], answers: {} },
      memberInfo: { boss: info('Main (Claude)', 'claude', { phase: 'waiting-draft' }), gpt: info('Review (GPT)', 'codex') },
    });
    expect(statusLine(g)).toBe('Round 1 of 4 · waiting for you to send or clear your draft in Main (Claude)');
  });
});

describe('lines', () => {
  it('the transcript: you, replies, failures, round and member notes, in order, with names and engines', () => {
    const log = [
      { at: '1', kind: 'start' as const, text: 'go' },
      { at: '2', kind: 'round' as const, text: 'Round 1 of 4', round: 1 },
      { at: '3', kind: 'reply' as const, from: 'boss', text: 'on it', round: 1 },
      { at: '4', kind: 'fail' as const, from: 'gpt', text: 'timeout', round: 1 },
      { at: '5', kind: 'you' as const, text: 'faster please' },
      { at: '6', kind: 'member' as const, from: 'llama', text: 'Notes (Ollama) joined' },
      { at: '7', kind: 'end' as const, text: 'Stopped by Martin' },
    ];
    expect(lines(G({ log })).map((l) => [l.kind, l.who ?? '', l.engine ?? '', l.text])).toEqual([
      ['you', '', '', 'go'],
      ['round', '', '', 'Round 1 of 4'],
      ['reply', 'Folder review (Claude)', 'claude', 'on it'],
      ['fail', 'Review (GPT)', 'codex', 'timeout'],
      ['you', '', '', 'faster please'],
      ['note', '', '', 'Notes (Ollama) joined'],
      ['note', '', '', 'Stopped by Martin'],
    ]);
  });

  it('a reply from a member who has since left still shows, under a plain name', () => {
    const l = lines(G({ log: [{ at: '1', kind: 'reply', from: 'gone', text: 'bye' }] }));
    expect(l[0]).toMatchObject({ kind: 'reply', who: 'A former member', text: 'bye' });
  });
});
