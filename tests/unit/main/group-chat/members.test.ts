import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentState } from '@shared/agent-state';
import type { TranscriptAnswer } from '@main/group-chat/transcript';
import { claudeTabTurn, headlessTurn, BRACKETED, type ClaudeTabPorts } from '@main/group-chat/members';
import type { TurnResult } from '@main/group-chat/engines/types';

const SHELL = { projectId: 1, shellIndex: 0 };
const HEADER = '[Group chat "G" in p · round 1 of 4 · members: A (Claude), B (GPT)]';
const TEXT = `${HEADER}\nline2`;

function fakeTab(over: Partial<ClaudeTabPorts> = {}) {
  const writes: string[] = [];
  const stopListeners = new Set<(path: string) => void>();
  const s = {
    shell: SHELL as typeof SHELL | null,
    state: 'idle' as AgentState,
    rows: ['────', '❯ ', '────'],
    lastInput: 0,
    answers: new Map<string, TranscriptAnswer>(),
  };
  const ports: ClaudeTabPorts = {
    shell: () => s.shell,
    state: () => s.state,
    screenRows: async () => s.rows,
    lastUserInputAt: () => s.lastInput,
    write: (_sh, data) => { writes.push(data); },
    onStop: (cb) => { stopListeners.add(cb); return () => stopListeners.delete(cb); },
    readAnswer: async (path) => s.answers.get(path) ?? { status: 'not-yet' },
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    ...over,
  };
  const stop = async (path: string) => { for (const l of [...stopListeners]) l(path); await vi.advanceTimersByTimeAsync(0); };
  return { s, ports, writes, stop, listeners: stopListeners };
}

const settle = async <T>(p: Promise<T>) => { let v: T | undefined; void p.then((x) => { v = x; }); await vi.advanceTimersByTimeAsync(0); return v; };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { vi.useRealTimers(); });

describe('claudeTabTurn', () => {
  it('waits while busy, then pastes once idle and quiet', async () => {
    const t = fakeTab();
    t.s.state = 'busy';
    const turn = claudeTabTurn(t.ports, { quietMs: 3000, pollMs: 500 });
    turn.start('line1\nline2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.writes).toEqual([]);
    expect(turn.phase()).toBe('waiting-idle');
    t.s.state = 'idle';
    await vi.advanceTimersByTimeAsync(600);
    expect(t.writes).toEqual(['\x1b[200~line1\nline2\x1b[201~', '\r']);
    expect(turn.phase()).toBe('running');
  });

  it('waits until the user has stopped typing for the quiet period', async () => {
    const t = fakeTab();
    t.s.lastInput = Date.now();
    const turn = claudeTabTurn(t.ports, { quietMs: 3000, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.writes).toHaveLength(2);
  });

  it('waits while a draft is in the input box and reports waiting-draft', async () => {
    const t = fakeTab();
    t.s.rows = ['────', '❯ half typed', '────'];
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.writes).toEqual([]);
    expect(turn.phase()).toBe('waiting-draft');
    t.s.rows = ['────', '❯ ', '────'];
    await vi.advanceTimersByTimeAsync(600);
    expect(t.writes).toHaveLength(2);
  });

  it('answers from the transcript on the next Stop', async () => {
    const t = fakeTab();
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    t.s.answers.set('/t.jsonl', { status: 'answered', text: 'my answer' });
    await t.stop('/t.jsonl');
    expect(await settle(turn.done)).toEqual({ text: 'my answer' });
  });

  it('reads the answer with the round message’s first line as the header', async () => {
    const seen: string[] = [];
    const t = fakeTab({ readAnswer: async (_p, header) => { seen.push(header); return { status: 'answered', text: 'x' }; } });
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    await t.stop('/t.jsonl');
    expect(seen).toEqual([HEADER]);
  });

  it('a Stop whose transcript does not contain our message is ignored', async () => {
    const t = fakeTab();
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    await t.stop('/other.jsonl');
    expect(await settle(turn.done)).toBeUndefined();
    t.s.answers.set('/t.jsonl', { status: 'answered', text: 'later' });
    await t.stop('/t.jsonl');
    expect(await settle(turn.done)).toEqual({ text: 'later' });
  });

  it('a Stop before the message was pasted is not read', async () => {
    const t = fakeTab();
    t.s.state = 'busy';
    t.s.answers.set('/t.jsonl', { status: 'answered', text: 'an older answer' });
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    await t.stop('/t.jsonl');
    expect(await settle(turn.done)).toBeUndefined();
  });

  it('stop while running sends Escape and fails with the reason', async () => {
    const t = fakeTab();
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    turn.stop('the group chat was stopped');
    expect(t.writes.at(-1)).toBe('\x1b');
    expect(await settle(turn.done)).toEqual({ failed: 'the group chat was stopped' });
    expect(t.listeners.size).toBe(0);
  });

  it('stop while waiting sends nothing', async () => {
    const t = fakeTab();
    t.s.state = 'busy';
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(600);
    turn.stop('stopped');
    expect(t.writes).toEqual([]);
    expect(await settle(turn.done)).toEqual({ failed: 'stopped' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.writes).toEqual([]);
  });

  it('fails when the tab is not open', async () => {
    const t = fakeTab();
    t.s.shell = null;
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    expect(await settle(turn.done)).toEqual({ failed: 'its Claude tab isn’t open' });
  });

  it('fails when the tab closes while it is answering', async () => {
    const t = fakeTab();
    const turn = claudeTabTurn(t.ports, { quietMs: 0, pollMs: 500 });
    turn.start(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    t.s.shell = null;
    await vi.advanceTimersByTimeAsync(600);
    expect(await settle(turn.done)).toEqual({ failed: 'its Claude tab was closed' });
  });
});

describe('headlessTurn', () => {
  it('resolves the reply and exposes engineSession via result()', async () => {
    const run = vi.fn(async (): Promise<TurnResult> => ({ ok: true, reply: 'hi from gpt', engineSession: 'th-1' }));
    const turn = headlessTurn({ run }, { model: 'gpt-5', engineSession: null });
    turn.start('round text');
    expect(turn.phase()).toBe('running');
    expect(await turn.done).toEqual({ text: 'hi from gpt' });
    expect(turn.result()).toEqual({ ok: true, reply: 'hi from gpt', engineSession: 'th-1' });
    expect(run.mock.calls[0]![0]).toEqual({ text: 'round text', model: 'gpt-5', engineSession: null });
  });

  it('stop aborts the run and fails', async () => {
    let signal: AbortSignal | undefined;
    const run = (_item: unknown, s: AbortSignal) => { signal = s; return new Promise<TurnResult>(() => {}); };
    const turn = headlessTurn({ run }, {});
    turn.start('x');
    turn.stop('the group chat was stopped');
    expect(signal!.aborted).toBe(true);
    expect(await turn.done).toEqual({ failed: 'the group chat was stopped' });
  });

  it('an engine error fails with its message', async () => {
    const turn = headlessTurn({ run: async () => ({ ok: false, reply: '', error: 'Codex CLI isn’t signed in' }) }, {});
    turn.start('x');
    expect(await turn.done).toEqual({ failed: 'Codex CLI isn’t signed in' });
  });

  it('a run that throws still fails the turn', async () => {
    const turn = headlessTurn({ run: async () => { throw new Error('boom'); } }, {});
    turn.start('x');
    expect(await turn.done).toEqual({ failed: 'boom' });
  });
});

describe('BRACKETED', () => {
  it('wraps text in bracketed-paste markers', () => {
    expect(BRACKETED('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
  });
});
