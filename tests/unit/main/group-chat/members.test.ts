import { describe, it, expect, vi } from 'vitest';
import { headlessTurn } from '@main/group-chat/members';
import type { TurnResult } from '@main/group-chat/engines/types';

describe('headlessTurn', () => {
  it('resolves the reply and exposes engineSession via result()', async () => {
    const run = vi.fn(async (_item: unknown, _signal: AbortSignal): Promise<TurnResult> => ({ ok: true, reply: 'hi from gpt', engineSession: 'th-1' }));
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
