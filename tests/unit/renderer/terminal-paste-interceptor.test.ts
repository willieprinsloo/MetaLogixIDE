import { describe, it, expect, vi } from 'vitest';
import {
  createPasteFromText,
  installPasteInterceptor,
  type ClipboardPasteDeps,
} from '@renderer/clipboard-paste';
import type { ClipboardImageResult } from '@shared/terminal-drop-contract';

const isCapture = (options?: boolean | { capture?: boolean }): boolean =>
  typeof options === 'boolean' ? options : options?.capture === true;

function deps(image: ClipboardImageResult = { kind: 'no-image' }): ClipboardPasteDeps {
  return { style: 'posix', stageClipboardImage: vi.fn(async () => image), notify: vi.fn() };
}

describe('createPasteFromText (behaviour 7, AC12)', () => {
  it('pastes sanitised clipboard text', async () => {
    const paste = vi.fn<(text: string) => void>();
    await createPasteFromText(deps(), paste)('a\x1bb');
    expect(paste).toHaveBeenCalledWith('a b');
  });

  it('pastes the escaped path of a staged clipboard image when there is no text', async () => {
    const paste = vi.fn<(text: string) => void>();
    await createPasteFromText(deps({ kind: 'staged', path: '/t/p 1.png' }), paste)('');
    expect(paste).toHaveBeenCalledWith('/t/p\\ 1.png');
  });

  it('never pastes when the clipboard resolves to nothing (no term.paste(""))', async () => {
    const paste = vi.fn<(text: string) => void>();
    await createPasteFromText(deps({ kind: 'no-image' }), paste)('');
    expect(paste).not.toHaveBeenCalled();
  });
});

interface Registration {
  type: string;
  capture: boolean;
}

class RecordingTarget extends EventTarget {
  readonly live: Registration[] = [];
  override addEventListener(
    type: string,
    fn: EventListener,
    options?: boolean | { capture?: boolean },
  ): void {
    this.live.push({ type, capture: isCapture(options) });
    super.addEventListener(type, fn, options);
  }
  override removeEventListener(
    type: string,
    fn: EventListener,
    options?: boolean | { capture?: boolean },
  ): void {
    const i = this.live.findIndex((r) => r.type === type && r.capture === isCapture(options));
    if (i >= 0) this.live.splice(i, 1);
    super.removeEventListener(type, fn, options);
  }
}

function pasteEvent(text: string | null) {
  const clipboardData = text === null ? null : { getData: vi.fn(() => text) };
  const event = Object.assign(new Event('paste', { cancelable: true }), { clipboardData });
  const stop = vi.spyOn(event, 'stopPropagation');
  return { event, stop, clipboardData };
}

describe('installPasteInterceptor (behaviour 7, AC12)', () => {
  it('listens for paste in the capture phase, ahead of xterm', () => {
    const host = new RecordingTarget();
    installPasteInterceptor(
      host,
      vi.fn(async () => undefined),
      vi.fn(),
    );
    expect(host.live).toEqual([{ type: 'paste', capture: true }]);
  });

  it('cancels the event and stops it reaching xterm, then routes the clipboard text', () => {
    const host = new RecordingTarget();
    const pasteFromText = vi.fn<(t: string) => Promise<void>>(async () => undefined);
    installPasteInterceptor(host, pasteFromText, vi.fn());
    const { event, stop, clipboardData } = pasteEvent('hello');
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(clipboardData?.getData).toHaveBeenCalledWith('text/plain');
    expect(pasteFromText).toHaveBeenCalledWith('hello');
  });

  it('treats a missing clipboardData as an empty clipboard', () => {
    const host = new RecordingTarget();
    const pasteFromText = vi.fn<(t: string) => Promise<void>>(async () => undefined);
    installPasteInterceptor(host, pasteFromText, vi.fn());
    host.dispatchEvent(pasteEvent(null).event);
    expect(pasteFromText).toHaveBeenCalledWith('');
  });

  it('logs a rejection instead of throwing', async () => {
    const host = new RecordingTarget();
    const err = new Error('ipc down');
    const onError = vi.fn<(e: unknown) => void>();
    installPasteInterceptor(host, () => Promise.reject(err), onError);
    expect(() => host.dispatchEvent(pasteEvent('x').event)).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(err));
  });

  it('removes the listener on dispose', () => {
    const host = new RecordingTarget();
    const pasteFromText = vi.fn<(t: string) => Promise<void>>(async () => undefined);
    const dispose = installPasteInterceptor(host, pasteFromText, vi.fn());
    dispose();
    const { event } = pasteEvent('x');
    host.dispatchEvent(event);
    expect(pasteFromText).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(host.live).toEqual([]);
  });
});
