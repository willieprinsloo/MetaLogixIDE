import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTerminalEngine } from '@renderer/terminal/terminal-engine-setting';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { invoke } }));

afterEach(() => {
  invoke.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the setting at each terminal opening', () => {
  it('reads the last committed choice again, and never chooses an invalid value', async () => {
    invoke.mockResolvedValueOnce({ value: 'ghostty' }).mockResolvedValueOnce({ value: '/wasm' });
    expect(await readTerminalEngine(new AbortController().signal)).toBe('ghostty');
    expect(await readTerminalEngine(new AbortController().signal)).toBe('xterm');
    expect(invoke.mock.calls).toEqual([['settings:get', { key: 'terminal_engine' }], ['settings:get', { key: 'terminal_engine' }]]);
  });

  it('falls back on a timeout instead of using a stale Ghostty choice', async () => {
    vi.useFakeTimers();
    const reply = Promise.withResolvers<{ value: string }>();
    invoke.mockResolvedValueOnce({ value: 'ghostty' }).mockReturnValueOnce(reply.promise);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readTerminalEngine(new AbortController().signal)).toBe('ghostty');
    const opening = readTerminalEngine(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(750);
    expect(await opening).toBe('xterm');
    reply.resolve({ value: 'ghostty' });
    expect(warning).toHaveBeenCalledOnce();
  });

  it('does not keep waiting for a closed view or diagnose cancellation as a failure', async () => {
    const controller = new AbortController();
    invoke.mockReturnValue(new Promise(() => {}));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opening = readTerminalEngine(controller.signal);
    controller.abort();
    expect(await opening).toBe('xterm');
    expect(await readTerminalEngine(controller.signal)).toBe('xterm');
    expect(invoke).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
  });
});
