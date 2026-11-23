// A Claude group member runs headless: `claude -p --output-format json`, resuming its own copy of
// the Claude tab's conversation (forked from the tab when it joined), so it keeps the tab's context
// without anything being typed into the tab.
import { describe, it, expect } from 'vitest';
import { claudeArgs, claudeProgress, parseClaude } from '@main/group-chat/engines/claude';

const SID = '11111111-2222-4333-8444-555555555555';
const FORK = '66666666-2222-4333-8444-555555555555';

describe('claudeArgs', () => {
  it('the first turn forks the tab’s conversation, so the tab itself is never touched', () => {
    expect(claudeArgs({ forkFrom: SID, engineSession: null, permission: 'auto' }))
      .toEqual(['-p', '--output-format', 'json', '--resume', SID, '--fork-session', '--permission-mode', 'auto']);
  });

  it('later turns resume the group’s own copy', () => {
    expect(claudeArgs({ forkFrom: SID, engineSession: FORK, permission: 'auto' }))
      .toEqual(['-p', '--output-format', 'json', '--resume', FORK, '--permission-mode', 'auto']);
  });

  it('follows the app’s permission choice, and a model when one is set', () => {
    expect(claudeArgs({ forkFrom: SID, engineSession: FORK, permission: 'bypass', model: 'opus' }))
      .toEqual(['-p', '--output-format', 'json', '--resume', FORK, '--dangerously-skip-permissions', '--model', 'opus']);
  });

  it('a session id that isn’t a plain id is never passed on', () => {
    expect(claudeArgs({ forkFrom: '--evil', engineSession: 'x; rm', permission: 'auto' }))
      .toEqual(['-p', '--output-format', 'json', '--permission-mode', 'auto']);
    expect(claudeArgs({ forkFrom: SID, engineSession: null, permission: 'auto', model: '--bad' })).not.toContain('--bad');
  });
});

describe('parseClaude', () => {
  const run = (lines: string[], code: number | null) => {
    const p = claudeProgress();
    for (const l of lines) p.feed(l);
    return parseClaude(p, code);
  };
  const result = (o: object) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PASS', session_id: FORK, ...o });

  it('the reply and the new session id come from the result', () => {
    expect(run([result({ result: 'I’ll take auth.ts' })], 0)).toEqual({ ok: true, reply: 'I’ll take auth.ts', engineSession: FORK });
  });

  it('an error result fails the turn with what Claude said', () => {
    expect(run([result({ is_error: true, subtype: 'error_during_execution', result: 'No conversation found' })], 1))
      .toEqual({ ok: false, reply: '', error: 'No conversation found', engineSession: FORK });
  });

  it('no result at all says it exited without an answer', () => {
    expect(run(['not json'], 1)).toEqual({ ok: false, reply: '', error: 'claude exited without an answer (code 1)' });
  });
});
