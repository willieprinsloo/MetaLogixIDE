// @vitest-environment jsdom
/** Exercises the distinction between a window-local opacity preview and the saved opacity. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalFrostOpacityControl } from '@renderer/components/settings/TerminalFrostOpacityControl';
import { FROST_ATTR } from '@renderer/frosted-chrome-contract';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { invoke } }));

const PREVIEW = '--terminal-opacity-preview';
const LABEL = 'Terminal background opacity';

beforeEach(() => {
  document.documentElement.setAttribute(FROST_ATTR.terminalFrost, 'custom');
  document.documentElement.setAttribute(FROST_ATTR.terminalOpacity, '65');
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  document.documentElement.removeAttribute(FROST_ATTR.terminalFrost);
  document.documentElement.removeAttribute(FROST_ATTR.terminalOpacity);
  document.documentElement.style.removeProperty(PREVIEW);
});

function controls() {
  return {
    slider: screen.getByRole<HTMLInputElement>('slider', { name: LABEL }),
    reset: screen.getByRole<HTMLButtonElement>('button', { name: `Reset ${LABEL.toLowerCase()}` }),
  };
}

function expectOpacity(slider: HTMLInputElement, value: number, saved: number, preview: string) {
  expect(slider.value).toBe(String(value));
  expect(slider.getAttribute('aria-valuetext')).toBe(`${value}%`);
  expect(document.documentElement.getAttribute(FROST_ATTR.terminalOpacity)).toBe(String(saved));
  expect(document.documentElement.style.getPropertyValue(PREVIEW)).toBe(preview);
}

it('previews inputs without writing, then persists once on native change and resets to the default', async () => {
  const write = Promise.withResolvers<{ ok: true }>();
  invoke.mockReturnValueOnce(write.promise).mockResolvedValueOnce({ ok: true });
  render(<TerminalFrostOpacityControl disabled={false} />);
  const { slider, reset } = controls();
  expectOpacity(slider, 65, 65, '');

  fireEvent.input(slider, { target: { value: '40' } });
  expectOpacity(slider, 40, 65, '0.4');
  fireEvent.input(slider, { target: { value: '35' } });
  expectOpacity(slider, 35, 65, '0.35');
  expect(invoke).not.toHaveBeenCalled();

  fireEvent.change(slider);
  expect(invoke.mock.calls).toEqual([['settings:set', { key: 'terminal_frost_opacity', value: 35 }]]);
  expectOpacity(slider, 35, 65, '0.35');
  await act(async () => { write.resolve({ ok: true }); });
  expectOpacity(slider, 35, 35, '');

  await act(async () => { fireEvent.click(reset); });
  expect(invoke).toHaveBeenNthCalledWith(2, 'settings:set', { key: 'terminal_frost_opacity', value: 70 });
  expectOpacity(slider, 70, 70, '');
  expect(reset.disabled).toBe(true);
});

it.each(['success', 'failure'] as const)('ignores stale %s during a newer preview and rolls back a rejected current edit', async (outcome) => {
  const older = Promise.withResolvers<{ ok: true }>();
  const current = Promise.withResolvers<{ ok: true }>();
  invoke.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
  render(<TerminalFrostOpacityControl disabled={false} />);
  const { slider } = controls();

  fireEvent.input(slider, { target: { value: '30' } });
  fireEvent.change(slider);
  fireEvent.input(slider, { target: { value: '45' } });
  await act(async () => {
    if (outcome === 'success') older.resolve({ ok: true });
    else older.reject(new Error('stale write failed'));
  });
  expectOpacity(slider, 45, 65, '0.45');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);

  fireEvent.change(slider);
  expect(invoke.mock.calls).toEqual([
    ['settings:set', { key: 'terminal_frost_opacity', value: 30 }],
    ['settings:set', { key: 'terminal_frost_opacity', value: 45 }],
  ]);
  await act(async () => { current.reject(new Error('current write failed')); });
  expect(screen.getByRole('alert').textContent).toMatch(/last saved value is still in use/i);
  expectOpacity(slider, 65, 65, '');

  fireEvent.input(slider, { target: { value: '55' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expectOpacity(slider, 55, 65, '0.55');
});

it('cancels the preview and ignores a pending write when transparency is disabled', async () => {
  const write = Promise.withResolvers<{ ok: true }>();
  invoke.mockReturnValueOnce(write.promise);
  const view = render(<TerminalFrostOpacityControl disabled={false} />);
  const { slider, reset } = controls();
  fireEvent.input(slider, { target: { value: '50' } });
  fireEvent.change(slider);
  expectOpacity(slider, 50, 65, '0.5');

  view.rerender(<TerminalFrostOpacityControl disabled />);
  expect(slider.disabled).toBe(true);
  expect(reset.disabled).toBe(true);
  expectOpacity(slider, 65, 65, '');
  fireEvent.change(slider);
  fireEvent.click(reset);
  expect(invoke.mock.calls).toEqual([['settings:set', { key: 'terminal_frost_opacity', value: 50 }]]);
  await act(async () => { write.resolve({ ok: true }); });
  expectOpacity(slider, 65, 65, '');

  view.rerender(<TerminalFrostOpacityControl disabled={false} />);
  fireEvent.input(slider, { target: { value: '55' } });
  expectOpacity(slider, 55, 65, '0.55');

  view.unmount();
  fireEvent.change(slider);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(document.documentElement.style.getPropertyValue(PREVIEW)).toBe('');
});

it('uses the default for missing opacity and follows valid changes from the window settings', async () => {
  const root = document.documentElement;
  root.removeAttribute(FROST_ATTR.terminalOpacity);
  render(<TerminalFrostOpacityControl disabled={false} />);
  const { slider, reset } = controls();
  expect(slider.value).toBe('70');
  expect(reset.disabled).toBe(true);

  await act(async () => { root.setAttribute(FROST_ATTR.terminalOpacity, '28'); });
  expectOpacity(slider, 28, 28, '');
  expect(reset.disabled).toBe(false);

  await act(async () => { root.setAttribute(FROST_ATTR.terminalOpacity, '101'); });
  expect(slider.value).toBe('28');
  expect(invoke).not.toHaveBeenCalled();
});
