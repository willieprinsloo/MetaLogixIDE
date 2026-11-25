// @vitest-environment jsdom
/** Exercises committed engine selection and keeps IPC races observable through the mounted radiogroup. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalEngineControl } from '@renderer/components/settings/TerminalEngineControl';
import type { IpcEvents } from '@shared/ipc-contract';
import type { TerminalEngine } from '@shared/terminal-engine';

type SettingsChanged = IpcEvents['settings:changed'];
const bridge = vi.hoisted(() => {
  const listeners = new Set<(event: SettingsChanged) => void>();
  return {
    listeners,
    invoke: vi.fn(),
    on: (_channel: 'settings:changed', listener: (event: SettingsChanged) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
});
vi.mock('@renderer/api', () => ({ api: bridge }));

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  bridge.listeners.clear();
});

function choices() {
  return {
    group: screen.getByRole('radiogroup', { name: 'Terminal engine' }),
    xterm: screen.getByRole<HTMLButtonElement>('radio', { name: 'xterm.js' }),
    ghostty: screen.getByRole<HTMLButtonElement>('radio', { name: 'Ghostty (WASM)' }),
  };
}

async function changed(key: SettingsChanged['key']) {
  await act(async () => { for (const listener of bridge.listeners) listener({ key }); });
}

it('disables choices until the load completes and uses xterm for an invalid stored engine', async () => {
  const read = Promise.withResolvers<{ value: string }>();
  bridge.invoke.mockReturnValueOnce(read.promise);
  render(<TerminalEngineControl />);
  const { xterm, ghostty } = choices();

  expect(xterm.disabled).toBe(true);
  expect(ghostty.disabled).toBe(true);
  fireEvent.click(ghostty);
  expect(bridge.invoke.mock.calls).toEqual([['settings:get', { key: 'terminal_engine' }]]);

  await act(async () => { read.resolve({ value: 'unknown-engine' }); });
  expect(xterm.disabled).toBe(false);
  expect(xterm.getAttribute('aria-checked')).toBe('true');
  expect([xterm.tabIndex, ghostty.tabIndex]).toEqual([0, -1]);
  fireEvent.click(xterm);
  expect(fireEvent.keyDown(xterm, { key: 'Home' })).toBe(false);
  expect(document.activeElement).toBe(xterm);
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});

it('reports an initial read failure without allowing an unconfirmed choice to overwrite storage', async () => {
  bridge.invoke.mockRejectedValueOnce(new Error('read failed'));
  await act(async () => { render(<TerminalEngineControl />); });

  expect(screen.getByRole('alert').textContent).toMatch(/could not read the terminal engine/i);
  const { xterm, ghostty } = choices();
  expect(xterm.getAttribute('aria-checked')).toBe('false');
  expect(ghostty.getAttribute('aria-checked')).toBe('false');
  expect(ghostty.disabled).toBe(true);
  fireEvent.click(ghostty);
  expect(bridge.invoke.mock.calls).toEqual([['settings:get', { key: 'terminal_engine' }]]);
});

it('keeps the current choice during a keyboard save, ignoring stale reads and coalescing settings changes', async () => {
  const olderRead = Promise.withResolvers<{ value: string }>();
  const save = Promise.withResolvers<{ ok: true }>();
  const queuedRead = Promise.withResolvers<{ value: string }>();
  bridge.invoke.mockResolvedValueOnce({ value: 'xterm' })
    .mockReturnValueOnce(olderRead.promise)
    .mockReturnValueOnce(save.promise)
    .mockReturnValueOnce(queuedRead.promise);
  await act(async () => { render(<TerminalEngineControl />); });
  const { group, xterm, ghostty } = choices();
  await changed('window_opacity');
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
  await changed('terminal_engine');
  expect(bridge.invoke).toHaveBeenCalledTimes(2);

  act(() => { xterm.focus(); });
  expect(fireEvent.keyDown(xterm, { key: 'Tab' })).toBe(true);
  expect(fireEvent.keyDown(xterm, { key: 'ArrowRight' })).toBe(false);
  expect(document.activeElement).toBe(ghostty);
  expect(group.getAttribute('aria-busy')).toBe('true');
  expect(xterm.getAttribute('aria-checked')).toBe('true');
  expect(ghostty.getAttribute('aria-disabled')).toBe('true');

  fireEvent.keyDown(ghostty, { key: 'Home' });
  fireEvent.click(ghostty);
  expect(document.activeElement).toBe(ghostty);
  await changed('terminal_engine');
  await changed('terminal_engine');
  await act(async () => { olderRead.resolve({ value: 'ghostty' }); });
  expect(xterm.getAttribute('aria-checked')).toBe('true');
  expect(bridge.invoke.mock.calls).toEqual([
    ['settings:get', { key: 'terminal_engine' }],
    ['settings:get', { key: 'terminal_engine' }],
    ['settings:set', { key: 'terminal_engine', value: 'ghostty' }],
  ]);

  await act(async () => { save.resolve({ ok: true }); });
  expect(group.getAttribute('aria-busy')).toBe('false');
  expect(ghostty.getAttribute('aria-checked')).toBe('true');
  expect([xterm.tabIndex, ghostty.tabIndex]).toEqual([-1, 0]);
  expect(bridge.invoke).toHaveBeenCalledTimes(4);
  expect(bridge.invoke).toHaveBeenLastCalledWith('settings:get', { key: 'terminal_engine' });

  await act(async () => { queuedRead.resolve({ value: 'xterm' }); });
  expect(xterm.getAttribute('aria-checked')).toBe('true');
  expect(ghostty.getAttribute('aria-checked')).toBe('false');
});

it('keeps the selected engine on rejection and can retry the save with End', async () => {
  let stored: TerminalEngine = 'xterm';
  bridge.invoke.mockImplementationOnce(async () => ({ value: stored }))
    .mockRejectedValueOnce(new Error('write failed'))
    .mockImplementationOnce(async (_channel, request: { value: TerminalEngine }) => {
      stored = request.value;
      return { ok: true };
    })
    .mockImplementationOnce(async () => ({ value: stored }));
  const view = render(<TerminalEngineControl />);
  await screen.findByRole('radio', { name: 'xterm.js', checked: true });
  const { group, xterm, ghostty } = choices();

  await act(async () => { fireEvent.click(ghostty); });
  expect(screen.getByRole('alert').textContent).toMatch(/could not save the terminal engine/i);
  expect(xterm.getAttribute('aria-checked')).toBe('true');
  expect(group.getAttribute('aria-busy')).toBe('false');

  await act(async () => { fireEvent.keyDown(xterm, { key: 'End' }); });
  expect(document.activeElement).toBe(ghostty);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(ghostty.getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(ghostty, { key: 'End' });
  expect(document.activeElement).toBe(ghostty);

  view.unmount();
  await changed('terminal_engine');
  expect(bridge.invoke).toHaveBeenCalledTimes(3);
  await act(async () => { render(<TerminalEngineControl />); });
  expect(choices().ghostty.getAttribute('aria-checked')).toBe('true');
  expect(bridge.invoke.mock.calls).toEqual([
    ['settings:get', { key: 'terminal_engine' }],
    ['settings:set', { key: 'terminal_engine', value: 'ghostty' }],
    ['settings:set', { key: 'terminal_engine', value: 'ghostty' }],
    ['settings:get', { key: 'terminal_engine' }],
  ]);
});
