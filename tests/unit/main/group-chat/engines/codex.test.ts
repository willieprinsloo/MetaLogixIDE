// GPT through the Codex CLI: its arguments, and reading `codex exec --json` events.
// Ported from BotOffice windows/test/engine-codex.test.js (MCP-bridge cases dropped).
import { describe, it, expect } from 'vitest';
import { codexArgs, codexProgress, parseCodex } from '@main/group-chat/engines/codex';

const SANDBOX = ['-c', 'sandbox_mode="workspace-write"'];
const ev = (o: unknown) => JSON.stringify(o);
function feedAll(lines: unknown[]) {
  const p = codexProgress();
  const changes = lines.map((l) => p.feed(ev(l)));
  return { p, changes };
}

describe('codexArgs', () => {
  it('a first turn runs exec with write access to its folder, prompt on stdin', () => {
    expect(codexArgs({ text: '', engineSession: null }, { platform: 'linux' })).toEqual(['exec', '--json', '--skip-git-repo-check', ...SANDBOX, '-']);
  });

  it('a later turn resumes its thread', () => {
    expect(codexArgs({ text: '', engineSession: '019a-th' }, { platform: 'linux' })).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', ...SANDBOX, '019a-th', '-']);
  });

  it('the model is passed, an odd one is not', () => {
    expect(codexArgs({ text: '', model: 'gpt-5' }).slice(-3)).toEqual(['-m', 'gpt-5', '-']);
    expect(codexArgs({ text: '', model: '--evil' }).includes('--evil')).toBe(false);
  });

  it('on Windows, Codex’s own Windows sandbox is switched on (without it GPT is read-only)', () => {
    const win = codexArgs({ text: '' }, { platform: 'win32' });
    const i = win.indexOf('windows.sandbox="unelevated"');
    expect(i > 0 && win[i - 1] === '-c').toBe(true);
    expect(codexArgs({ text: '' }, { platform: 'linux' }).includes('windows.sandbox="unelevated"')).toBe(false);
  });
});

describe('codexProgress / parseCodex', () => {
  it('progress: thread id, steps, live text, changed files and tokens', () => {
    const { p, changes } = feedAll([
      { type: 'thread.started', thread_id: '019a-th' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls -la', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls -la', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'H:/x/a.txt', kind: 'add' }, { path: 'H:/x/b.js', kind: 'update' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'i3', type: 'web_search', query: 'lorawan gateways' } },
      { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Done: added a.txt' } },
      { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 45 } },
    ]);
    expect(p.threadId).toBe('019a-th');
    expect(p.steps).toEqual(['Ran: ls -la', 'Changed 2 files', 'Searched: lorawan gateways']);
    expect(p.changed).toEqual(['H:/x/a.txt', 'H:/x/b.js']);
    expect(p.text).toBe('Done: added a.txt');
    expect(p.tokens).toEqual({ in: 1200, out: 45 });
    expect(changes[1]).toBe(false);
    expect(changes[2]).toBe(true);
  });

  it('a running command shows once, not twice when it completes', () => {
    const { p } = feedAll([
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 1 } },
    ]);
    expect(p.steps).toEqual(['Ran: npm test']);
  });

  it('the last agent message is the reply, with the thread', () => {
    const { p } = feedAll([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
    ]);
    expect(parseCodex(p, 0)).toEqual({ ok: true, reply: 'final answer', engineSession: 't1' });
  });

  it('a failed turn reports Codex’s message and keeps the thread', () => {
    const { p } = feedAll([{ type: 'thread.started', thread_id: 't2' }, { type: 'turn.failed', error: { message: 'You exceeded your current quota' } }]);
    const r = parseCodex(p, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exceeded your current quota/);
    expect(r.engineSession).toBe('t2');
  });

  it('signed out or crashed without events says so', () => {
    const { p } = feedAll([{ type: 'error', message: 'Not logged in. Run codex login.' }]);
    expect(parseCodex(p, 1).error).toMatch(/codex login/);
    expect(parseCodex(codexProgress(), 3).error).toMatch(/Codex exited without an answer \(code 3\)/);
  });

  it('lines that aren’t JSON are ignored', () => {
    expect(codexProgress().feed('Reading prompt from stdin...')).toBe(false);
  });
});
