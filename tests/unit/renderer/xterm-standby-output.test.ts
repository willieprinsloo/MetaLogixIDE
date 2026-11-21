import { describe, expect, it, vi } from 'vitest';
import { createXtermStandbyOutput } from '@renderer/terminal/xterm-standby-output';

function parser() {
  const pending: { data: string; parsed?: () => void }[] = [];
  const history: string[] = [];
  const effects: string[] = [];
  let enabled = false;
  const enable = vi.fn(() => { enabled = true; });
  const view = createXtermStandbyOutput({ write(data, parsed) { pending.push({ data, parsed }); } });
  function parseQueued(): void {
    for (const { data, parsed } of pending.splice(0)) {
      if (data) {
        history.push(data);
        if (enabled) effects.push(data);
      }
      parsed?.();
    }
  }
  return { view, history, effects, parseQueued, enable };
}

describe('xterm standby output handoff', () => {
  it('preserves FIFO output, including output during promotion, before enabling effects', async () => {
    const { view, history, effects, parseQueued, enable } = parser();
    view.write('replay');
    view.write('same-live');
    const promoted = view.promote(new AbortController().signal, enable);
    parseQueued();
    expect(history).toEqual(['replay', 'same-live']);
    view.write('same-live');
    view.write('final-output');
    await Promise.resolve();
    await Promise.resolve();
    expect(enable).not.toHaveBeenCalled();
    parseQueued();
    await promoted;
    expect(history).toEqual(['replay', 'same-live', 'same-live', 'final-output']);
    expect(effects).toEqual([]);
    expect(enable).toHaveBeenCalledOnce();
    view.write('fresh-output');
    parseQueued();
    expect(effects).toEqual(['fresh-output']);
  });

  it('never enables effects when canceled, including a late parser callback', async () => {
    const { view, enable, parseQueued } = parser();
    const controller = new AbortController();
    const promoted = view.promote(controller.signal, enable);
    controller.abort();
    await expect(promoted).rejects.toBe(controller.signal.reason);
    parseQueued();
    expect(enable).not.toHaveBeenCalled();
  });

  it('does not transfer ownership twice, even when another promotion is pending', async () => {
    const { view, enable, parseQueued } = parser();
    const { signal } = new AbortController();
    const first = view.promote(signal, enable);
    await expect(view.promote(signal, enable)).rejects.toThrow('already attempted');
    parseQueued();
    await first;
    expect(enable).toHaveBeenCalledOnce();
  });
});
