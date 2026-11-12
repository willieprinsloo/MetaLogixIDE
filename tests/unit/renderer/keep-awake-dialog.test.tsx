import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef, type FormEvent } from 'react';
import { KEEP_AWAKE_COPY, KEEP_AWAKE_TESTIDS } from '@shared/keep-awake-contract';

const rt = await vi.hoisted(async () => {
  const { createHookRuntime } = await import('./helpers/hook-runtime');
  return createHookRuntime();
});
vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useState: rt.useState,
  useRef: rt.useRef,
  useCallback: rt.useCallback,
  useEffect: rt.useEffect,
}));

const { KeepAwakeUntilDialogView, resolveUntil, useUntilDialog } = await import('@renderer/components/KeepAwakeUntilDialog');

const at = (h: number, m: number, day = 19): number => new Date(2026, 9, day, h, m, 0).getTime();
const NOW = at(22, 0);
const noop = () => undefined;

describe('resolveUntil', () => {
  it('previews a valid time with its resolved day and carries the deadline (AC2)', () => {
    expect(resolveUntil('07:00', NOW, false)).toEqual({
      endsAt: at(7, 0, 20),
      preview: KEEP_AWAKE_COPY.dialog.preview('07:00 tomorrow'),
      error: null,
    });
    expect(resolveUntil('23:30', NOW, false).preview).toBe(KEEP_AWAKE_COPY.dialog.preview('23:30 today'));
  });

  it('stays quiet while empty or malformed until a confirm was attempted', () => {
    expect(resolveUntil('', NOW, false)).toEqual({ endsAt: null, preview: null, error: null });
    expect(resolveUntil('7:3', NOW, false)).toEqual({ endsAt: null, preview: null, error: null });
  });

  it('shows the matching inline error after an attempt (AC3)', () => {
    expect(resolveUntil('', NOW, true).error).toBe(KEEP_AWAKE_COPY.dialog.errorEmpty);
    expect(resolveUntil('25:00', NOW, true).error).toBe(KEEP_AWAKE_COPY.dialog.errorMalformed);
  });

  it('shows no error and no stale deadline for a valid time after an attempt', () => {
    const r = resolveUntil('23:30', NOW, true);
    expect(r.error).toBeNull();
    expect(r.endsAt).toBe(at(23, 30));
  });
});

const view = (over: Partial<Parameters<typeof KeepAwakeUntilDialogView>[0]> = {}) =>
  renderToStaticMarkup(
    <KeepAwakeUntilDialogView
      text=""
      preview={null}
      error={null}
      onChange={noop}
      onSubmit={noop}
      onClose={noop}
      onKeyDown={noop}
      panelRef={createRef()}
      inputRef={createRef()}
      {...over}
    />,
  );
const tag = (html: string, testId: string): string => new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';

describe('KeepAwakeUntilDialogView', () => {
  it('is a labelled modal dialog with a labelled time input', () => {
    const html = view();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(KEEP_AWAKE_COPY.dialog.title);
    expect(html).toContain(`<label for="keep-awake-input" class="block text-sm text-[--modal-text-muted]">${KEEP_AWAKE_COPY.dialog.label}</label>`);
    const input = tag(html, KEEP_AWAKE_TESTIDS.input);
    expect(input).toContain('id="keep-awake-input"');
    expect(input).toContain(`placeholder="${KEEP_AWAKE_COPY.dialog.placeholder}"`);
  });

  it('shows the typed text', () => {
    expect(tag(view({ text: '07:00' }), KEEP_AWAKE_TESTIDS.input)).toContain('value="07:00"');
  });

  it('shows the resolved preview when there is one, and none otherwise', () => {
    const html = view({ preview: 'Until 07:00 tomorrow' });
    expect(html).toMatch(new RegExp(`data-testid="${KEEP_AWAKE_TESTIDS.preview}"[^>]*>Until 07:00 tomorrow<`));
    expect(view()).not.toContain(KEEP_AWAKE_TESTIDS.preview);
  });

  it('shows the inline error, associated with the input, and marks it invalid', () => {
    const html = view({ error: KEEP_AWAKE_COPY.dialog.errorMalformed });
    const errorTag = tag(html, KEEP_AWAKE_TESTIDS.error);
    expect(errorTag).toContain('id="keep-awake-error"');
    expect(errorTag).toContain('role="alert"');
    expect(html).toContain(`>${KEEP_AWAKE_COPY.dialog.errorMalformed}</p>`);
    const input = tag(html, KEEP_AWAKE_TESTIDS.input);
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="keep-awake-error"');
    expect(tag(view(), KEEP_AWAKE_TESTIDS.input)).not.toContain('aria-invalid="true"');
  });

  it('offers Start (submit) and Cancel', () => {
    const html = view();
    expect(tag(html, KEEP_AWAKE_TESTIDS.confirm)).toContain('type="submit"');
    expect(html).toContain(`>${KEEP_AWAKE_COPY.dialog.confirm}</button>`);
    expect(html).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>${KEEP_AWAKE_COPY.dialog.cancel}</button>`));
  });
});

describe('useUntilDialog', () => {
  beforeEach(() => { rt.reset(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { rt.unmount(); vi.useRealTimers(); });

  const mount = () => {
    const onStart = vi.fn();
    const onClose = vi.fn();
    const read = () => rt.render(() => useUntilDialog(onStart, onClose));
    read();
    return { read, onStart, onClose };
  };
  const submitEvent = () => ({ preventDefault: vi.fn() }) as unknown as FormEvent & { preventDefault: ReturnType<typeof vi.fn> };

  it('previews as the user types', () => {
    const h = mount();
    h.read().setText('07:00');
    expect(h.read().preview).toBe(KEEP_AWAKE_COPY.dialog.preview('07:00 tomorrow'));
  });

  it('starts with the previewed deadline and closes on a valid submit', () => {
    const h = mount();
    h.read().setText('23:30');
    const e = submitEvent();
    h.read().onSubmit(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(h.onStart).toHaveBeenCalledTimes(1);
    expect(h.onStart).toHaveBeenCalledWith(at(23, 30));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the previewed deadline when the clock moves on before submit', () => {
    const h = mount();
    h.read().setText('23:30');
    vi.setSystemTime(NOW + 10 * 60_000);
    h.read().onSubmit(submitEvent());
    expect(h.onStart).toHaveBeenCalledWith(at(23, 30));
  });

  it('does not start on an empty submit and shows the empty error (AC3)', () => {
    const h = mount();
    h.read().onSubmit(submitEvent());
    expect(h.onStart).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.read().error).toBe(KEEP_AWAKE_COPY.dialog.errorEmpty);
  });

  it('does not start on a malformed submit and shows the malformed error (AC3)', () => {
    const h = mount();
    h.read().setText('7:3');
    h.read().onSubmit(submitEvent());
    expect(h.onStart).not.toHaveBeenCalled();
    expect(h.read().error).toBe(KEEP_AWAKE_COPY.dialog.errorMalformed);
  });

  it('closes on Escape without starting', () => {
    const h = mount();
    h.read().onKeyDown({ key: 'Escape' } as never);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onStart).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const h = mount();
    h.read().onKeyDown({ key: 'a' } as never);
    expect(h.onClose).not.toHaveBeenCalled();
  });
});
