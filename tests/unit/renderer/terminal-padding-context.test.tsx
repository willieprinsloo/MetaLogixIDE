// @vitest-environment jsdom
/** Exercises independent settings refreshes and cancellation through mounted padding consumers. */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalPaddingProvider, useTerminalPadding } from '@renderer/terminal/terminal-padding-context';
import type { IpcEvents } from '@shared/ipc-contract';

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
  vi.restoreAllMocks();
});

async function changed(key: SettingsChanged['key']) {
  await act(async () => { for (const listener of bridge.listeners) listener({ key }); });
}

it('provides the default spacing sentinel when no provider owns the window', () => {
  const { result } = renderHook(useTerminalPadding);
  expect(result.current).toEqual({ horizontal: null, vertical: null });
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it('refreshes only the changed axis and does not overwrite the latest value with an older read', async () => {
  const older = Promise.withResolvers<{ value: number }>();
  bridge.invoke.mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce({ value: 14 })
    .mockResolvedValueOnce({ value: 0 })
    .mockResolvedValueOnce({ value: null });
  const { result } = renderHook(useTerminalPadding, { wrapper: TerminalPaddingProvider });
  expect(result.current).toEqual({ horizontal: null, vertical: null });

  await changed('window_opacity');
  expect(result.current).toEqual({ horizontal: null, vertical: 14 });
  expect(bridge.invoke.mock.calls).toEqual([
    ['settings:get', { key: 'terminal_padding_horizontal' }],
    ['settings:get', { key: 'terminal_padding_vertical' }],
  ]);

  await changed('terminal_padding_horizontal');
  expect(result.current).toEqual({ horizontal: 0, vertical: 14 });
  await act(async () => { older.resolve({ value: 9 }); });
  expect(result.current).toEqual({ horizontal: 0, vertical: 14 });

  await changed('terminal_padding_vertical');
  expect(result.current).toEqual({ horizontal: 0, vertical: null });
  expect(bridge.invoke).toHaveBeenCalledTimes(4);
  expect(bridge.invoke).toHaveBeenNthCalledWith(3, 'settings:get', { key: 'terminal_padding_horizontal' });
  expect(bridge.invoke).toHaveBeenNthCalledWith(4, 'settings:get', { key: 'terminal_padding_vertical' });
});

it('keeps known padding on invalid data or read failure, and unsubscribes both axes on unmount', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new Error('settings read failed');
  const abandoned = Promise.withResolvers<{ value: number }>();
  bridge.invoke.mockResolvedValueOnce({ value: 9 })
    .mockResolvedValueOnce({ value: 14 })
    .mockResolvedValueOnce({ value: 14.5 })
    .mockRejectedValueOnce(failure)
    .mockReturnValueOnce(abandoned.promise);
  const { result, unmount } = renderHook(useTerminalPadding, { wrapper: TerminalPaddingProvider });
  await act(async () => {});
  expect(result.current).toEqual({ horizontal: 9, vertical: 14 });

  await changed('terminal_padding_vertical');
  expect(result.current).toEqual({ horizontal: 9, vertical: 14 });
  expect(warning).not.toHaveBeenCalled();

  await changed('terminal_padding_vertical');
  expect(result.current).toEqual({ horizontal: 9, vertical: 14 });
  expect(warning).toHaveBeenCalledWith('Could not load terminal_padding_vertical', failure);

  await changed('terminal_padding_horizontal');
  unmount();
  await act(async () => { abandoned.reject(new Error('reply arrived after unmount')); });
  expect(warning).toHaveBeenCalledTimes(1);
  await changed('terminal_padding_horizontal');
  await changed('terminal_padding_vertical');
  expect(bridge.invoke).toHaveBeenCalledTimes(5);
});
