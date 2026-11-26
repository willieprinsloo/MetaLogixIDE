// @vitest-environment jsdom
/** Exercises padding drafts and commits with the real provider and an in-process settings bridge. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalPaddingControl } from '@renderer/components/settings/TerminalPaddingControl';
import { TerminalPaddingProvider, useTerminalPadding } from '@renderer/terminal/terminal-padding-context';
import type { IpcEvents, IpcRequest } from '@shared/ipc-contract';
import type { TerminalPaddingAxis, TerminalPaddingValue } from '@shared/terminal-padding';

type SettingsChanged = IpcEvents['settings:changed'];
const bridge = vi.hoisted(() => {
  const listeners = new Set<(event: SettingsChanged) => void>();
  return {
    listeners,
    invoke: vi.fn<(channel: string, request: IpcRequest<'settings:get'>) => Promise<unknown>>(),
    on: (_channel: 'settings:changed', listener: (event: SettingsChanged) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
});
vi.mock('@renderer/api', () => ({ api: bridge }));

const stored: Record<TerminalPaddingAxis, TerminalPaddingValue> = { horizontal: 8, vertical: 16 };

beforeEach(() => {
  stored.horizontal = 8;
  stored.vertical = 16;
  bridge.invoke.mockImplementation(async (channel, { key }) => {
    if (channel === 'settings:get' && key === 'terminal_padding_horizontal') return { value: stored.horizontal };
    if (channel === 'settings:get' && key === 'terminal_padding_vertical') return { value: stored.vertical };
    throw new Error(`Unexpected settings call: ${channel} ${key}`);
  });
});

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  bridge.listeners.clear();
});

function AppliedPadding() {
  const { horizontal, vertical } = useTerminalPadding();
  return <output>{`Applied padding: ${horizontal ?? 'default'} × ${vertical ?? 'default'}`}</output>;
}

async function mount() {
  await act(async () => {
    render(
      <TerminalPaddingProvider>
        <TerminalPaddingControl axis="horizontal" />
        <TerminalPaddingControl axis="vertical" />
        <AppliedPadding />
      </TerminalPaddingProvider>,
    );
  });
}

function field(axis: TerminalPaddingAxis) {
  return screen.getByRole<HTMLInputElement>('spinbutton', { name: `Terminal ${axis} padding` });
}

async function publish(key: SettingsChanged['key']) {
  await act(async () => { for (const listener of bridge.listeners) listener({ key }); });
}

function writes() {
  return bridge.invoke.mock.calls.filter(([channel]) => channel === 'settings:set');
}

it('keeps a draft out of the applied spacing and commits zero once with Enter, even if the field blurs while saving', async () => {
  await mount();
  const horizontal = field('horizontal');
  const write = Promise.withResolvers<{ ok: true }>();
  bridge.invoke.mockReturnValueOnce(write.promise);
  expect(horizontal.value).toBe('8');

  fireEvent.change(horizontal, { target: { value: '0' } });
  expect(horizontal.value).toBe('0');
  expect(screen.getByRole('status').textContent).toBe('Applied padding: 8 × 16');
  expect(writes()).toEqual([]);

  expect(fireEvent.keyDown(horizontal, { key: 'Enter' })).toBe(false);
  expect(horizontal.readOnly).toBe(true);
  fireEvent.blur(horizontal);
  expect(writes()).toEqual([['settings:set', { key: 'terminal_padding_horizontal', value: 0 }]]);
  expect(screen.getByRole('status').textContent).toBe('Applied padding: 8 × 16');

  stored.horizontal = 0;
  await publish('terminal_padding_horizontal');
  await act(async () => { write.resolve({ ok: true }); });
  expect(screen.getByRole('status').textContent).toBe('Applied padding: 0 × 16');
  expect(horizontal.value).toBe('0');
  expect(horizontal.readOnly).toBe(false);
  expect(field('vertical').value).toBe('16');
});

it.each(['', '-1', '1.5', '33'])('rejects the draft %j without persisting it', async (value) => {
  await mount();
  const horizontal = field('horizontal');
  fireEvent.change(horizontal, { target: { value } });
  fireEvent.blur(horizontal);

  const error = screen.getByRole('alert');
  expect(error.textContent).toMatch(/enter a whole number between 0 and 32/i);
  expect(horizontal.getAttribute('aria-invalid')).toBe('true');
  expect(horizontal.getAttribute('aria-describedby')).toBe(error.id);
  expect(horizontal.value).toBe('8');
  expect(screen.getByRole('status').textContent).toBe('Applied padding: 8 × 16');
  expect(writes()).toEqual([]);
});

it('drops an unchanged draft and does not persist it on blur', async () => {
  await mount();
  const horizontal = field('horizontal');
  fireEvent.change(horizontal, { target: { value: '9' } });
  fireEvent.change(horizontal, { target: { value: '8' } });
  fireEvent.blur(horizontal);
  expect(writes()).toEqual([]);

  stored.horizontal = 12;
  await publish('terminal_padding_horizontal');
  expect(horizontal.value).toBe('12');
});

it('restores the last committed field value after a rejected write and resets only that axis', async () => {
  await mount();
  const vertical = field('vertical');
  const reset = screen.getByRole<HTMLButtonElement>('button', { name: 'Reset terminal vertical padding' });
  bridge.invoke.mockRejectedValueOnce(new Error('padding save failed'));
  fireEvent.change(vertical, { target: { value: '32' } });
  await act(async () => { fireEvent.blur(vertical); });
  expect(screen.getByRole('alert').textContent).toMatch(/could not save terminal vertical padding/i);
  expect(vertical.value).toBe('16');
  expect(vertical.readOnly).toBe(false);
  expect(screen.getByRole('status').textContent).toBe('Applied padding: 8 × 16');

  bridge.invoke.mockResolvedValueOnce({ ok: true });
  fireEvent.change(vertical, { target: { value: '22' } });
  expect(fireEvent.mouseDown(reset)).toBe(false);
  await act(async () => { fireEvent.click(reset); });
  stored.vertical = null;
  await publish('terminal_padding_vertical');
  expect(writes()).toEqual([
    ['settings:set', { key: 'terminal_padding_vertical', value: 32 }],
    ['settings:set', { key: 'terminal_padding_vertical', value: null }],
  ]);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vertical.value).toBe('');
  expect(vertical.placeholder).toBe('Default');
  expect(reset.disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('Applied padding: 8 × default');
  fireEvent.blur(vertical);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(writes()).toHaveLength(2);
});
