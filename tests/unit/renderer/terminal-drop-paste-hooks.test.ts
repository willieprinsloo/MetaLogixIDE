/**
 * Wiring tests for `useTerminalDrop`, `useTerminalPaste` and `useExternalDragGuard`: the hooks run under a minimal in-test
 * React runtime (vitest runs in node, without a DOM renderer), with the IPC bridge and toasts mocked,
 * to prove the real effects are connected to the pure controllers they delegate to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DragEvent, RefObject } from 'react';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const slots: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
    },
    render<T>(fn: () => T): T {
      cursor = 0;
      effectCursor = 0;
      const out = fn();
      const due = effects.filter((e) => e.run);
      for (const e of due) e.cleanup?.();
      for (const e of due) {
        const c = e.run?.();
        e.run = undefined;
        e.cleanup = typeof c === 'function' ? (c as () => void) : undefined;
      }
      return out;
    },
    unmount() {
      for (const e of effects) e.cleanup?.();
    },
    useState<S>(init: S) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (v: S) => {
        slots[i] = v;
      };
      return [slots[i] as S, set] as const;
    },
    useRef<R>(init: R) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i] as { current: R };
    },
    useMemo<T>(fn: () => T, deps: unknown[]) {
      const i = cursor++;
      const prev = slots[i] as { value: T; deps: unknown[] } | undefined;
      if (prev && !changed(prev.deps, deps)) return prev.value;
      const value = fn();
      slots[i] = { value, deps };
      return value;
    },
    useEffect(run: () => unknown, deps?: unknown[]) {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev && !changed(prev.deps, deps)) return;
      effects[i] = { deps, cleanup: prev?.cleanup, run };
    },
  };
});

vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useState: rt.useState,
  useRef: rt.useRef,
  useMemo: rt.useMemo,
  useEffect: rt.useEffect,
}));

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({
  api: { platform: 'darwin', pathForFile: (f: { path?: string }) => f.path ?? '', invoke },
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/useToasts', () => ({ toast }));

const { useTerminalDrop } = await import('@renderer/hooks/useTerminalDrop');
const { useTerminalPaste } = await import('@renderer/hooks/useTerminalPaste');
const { useExternalDragGuard } = await import('@renderer/hooks/useExternalDragGuard');
const { DROP_COPY } = await import('@shared/terminal-drop-contract');

type Drag = DragEvent<HTMLElement>;

function drag(types: string[], data: Record<string, string> = {}, files: unknown[] = []): Drag {
  return {
    dataTransfer: { types, files, dropEffect: 'none', getData: (t: string) => data[t] ?? '' },
    preventDefault: vi.fn(),
  } as unknown as Drag;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let win: EventTarget;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  rt.reset();
  invoke.mockReset();
  toast.mockReset();
  win = new EventTarget();
  vi.stubGlobal('window', win);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  rt.unmount();
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe('useTerminalDrop wiring', () => {
  function mount(opts: { exited?: boolean; paste?: (t: string) => void } = {}) {
    const paste = vi.fn(opts.paste ?? (() => undefined));
    const options = { paste, isExited: () => opts.exited ?? false };
    const render = () => rt.render(() => useTerminalDrop(options));
    return { paste, render, first: render() };
  }

  it('shows and hides the overlay through component state', () => {
    const { first, render } = mount();
    expect(first.overlay).toBeNull();
    first.handlers.onDragEnter(drag(['text/plain']));
    expect(render().overlay).toBe('text');
    first.handlers.onDragLeave(drag(['text/plain']));
    expect(render().overlay).toBeNull();
  });

  it('accepts a path drag on dragover', () => {
    const { first } = mount();
    const e = drag(['Files']);
    first.handlers.onDragOver(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('pastes a text drop through the injected paste', async () => {
    const { first, paste } = mount();
    first.handlers.onDrop(drag(['text/plain'], { 'text/plain': 'echo hi' }));
    await flush();
    expect(paste).toHaveBeenCalledWith('echo hi');
  });

  it('escapes a resolved OS path with the platform style', async () => {
    const { first, paste } = mount();
    first.handlers.onDrop(drag(['Files'], {}, [{ name: 'a', type: '', size: 1, path: '/a b' }]));
    await flush();
    expect(paste).toHaveBeenCalledWith('/a\\ b');
  });

  it('stages a pathless file over drops:stage-file and toasts a failure', async () => {
    invoke.mockResolvedValue({ kind: 'failed', reason: 'disk full' });
    const { first, paste } = mount();
    const f = {
      name: 'x.png',
      type: 'image/png',
      size: 2,
      arrayBuffer: async () => new ArrayBuffer(2),
    };
    first.handlers.onDrop(drag(['Files'], {}, [f]));
    await flush();
    expect(invoke).toHaveBeenCalledWith(
      'drops:stage-file',
      expect.objectContaining({ name: 'x.png' }),
    );
    expect(toast).toHaveBeenCalledWith(DROP_COPY.stageFailedTitle, {
      kind: 'error',
      detail: 'disk full',
    });
    expect(paste).not.toHaveBeenCalled();
  });

  it('resolves a Files-tree drag over drops:resolve-app-file', async () => {
    invoke.mockResolvedValue({ kind: 'resolved', path: '/p/src/a.ts' });
    const { first, paste } = mount();
    const raw = JSON.stringify({ projectId: 2, relPath: 'src/a.ts' });
    first.handlers.onDrop(
      drag(['application/x-metaide-file'], { 'application/x-metaide-file': raw }),
    );
    await flush();
    expect(invoke).toHaveBeenCalledWith('drops:resolve-app-file', {
      projectId: 2,
      relPath: 'src/a.ts',
    });
    expect(paste).toHaveBeenCalledWith('/p/src/a.ts');
  });

  it('reads isExited from the latest options (AC16)', async () => {
    const paste = vi.fn();
    const first = rt.render(() => useTerminalDrop({ paste, isExited: () => false }));
    rt.render(() => useTerminalDrop({ paste, isExited: () => true }));
    first.handlers.onDrop(drag(['text/plain'], { 'text/plain': 'x' }));
    await flush();
    expect(paste).not.toHaveBeenCalled();
  });

  it('pastes again once the latest options report the shell alive (AC16)', async () => {
    const paste = vi.fn();
    const first = rt.render(() => useTerminalDrop({ paste, isExited: () => true }));
    rt.render(() => useTerminalDrop({ paste, isExited: () => false }));
    first.handlers.onDrop(drag(['text/plain'], { 'text/plain': 'x' }));
    await flush();
    expect(paste).toHaveBeenCalledWith('x');
  });

  it('logs a paste failure instead of throwing', async () => {
    const { first } = mount({
      paste: () => {
        throw new Error('disposed');
      },
    });
    first.handlers.onDrop(drag(['text/plain'], { 'text/plain': 'x' }));
    await flush();
    expect(errorSpy).toHaveBeenCalledWith('[metaide] terminal drop failed', expect.any(Error));
  });

  it('resets the overlay on a window dragend and detaches on unmount', () => {
    const { first, render } = mount();
    first.handlers.onDragEnter(drag(['Files']));
    win.dispatchEvent(new Event('dragend'));
    expect(render().overlay).toBeNull();
    first.handlers.onDragEnter(drag(['Files']));
    rt.unmount();
    win.dispatchEvent(new Event('drop'));
    expect(render().overlay).toBe('path');
  });
});

describe('useTerminalPaste wiring', () => {
  function mount(host: EventTarget | null, paste = vi.fn<(t: string) => void>()) {
    const ref = { current: host } as RefObject<HTMLElement>;
    const render = () => rt.render(() => useTerminalPaste(ref, paste));
    return { paste, render, pasteFromText: render() };
  }

  function pasteEvent(text: string): Event {
    return Object.assign(new Event('paste', { cancelable: true }), {
      clipboardData: { getData: () => text },
    });
  }

  it('routes a host paste event to the injected paste', async () => {
    const host = new EventTarget();
    const { paste } = mount(host);
    const e = pasteEvent('ls');
    host.dispatchEvent(e);
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(paste).toHaveBeenCalledWith('ls');
  });

  it('stages a clipboard image over drops:stage-clipboard-image when there is no text', async () => {
    invoke.mockResolvedValue({ kind: 'staged', path: '/t/p 1.png' });
    const { pasteFromText, paste } = mount(new EventTarget());
    await pasteFromText('');
    expect(invoke).toHaveBeenCalledWith('drops:stage-clipboard-image', undefined);
    expect(paste).toHaveBeenCalledWith('/t/p\\ 1.png');
  });

  it('toasts a clipboard image failure', async () => {
    invoke.mockResolvedValue({ kind: 'failed', reason: 'nope' });
    const { pasteFromText } = mount(new EventTarget());
    await pasteFromText('');
    expect(toast).toHaveBeenCalledWith(DROP_COPY.clipboardImageFailedTitle, {
      kind: 'error',
      detail: 'nope',
    });
  });

  it('returns the same pasteFromText across renders', () => {
    const { pasteFromText, render } = mount(new EventTarget());
    expect(render()).toBe(pasteFromText);
  });

  it('logs a failing paste from the interceptor instead of throwing', async () => {
    const host = new EventTarget();
    mount(
      host,
      vi.fn(() => {
        throw new Error('disposed');
      }),
    );
    host.dispatchEvent(pasteEvent('x'));
    await flush();
    expect(errorSpy).toHaveBeenCalledWith('[metaide] terminal paste failed', expect.any(Error));
  });

  it('installs nothing without a host and detaches on unmount', async () => {
    expect(() => mount(null)).not.toThrow();
    rt.reset();
    const host = new EventTarget();
    const { paste } = mount(host);
    rt.unmount();
    host.dispatchEvent(pasteEvent('x'));
    await flush();
    expect(paste).not.toHaveBeenCalled();
  });
});

describe('useExternalDragGuard wiring', () => {
  it('guards the window while mounted and stops on unmount', () => {
    rt.render(() => useExternalDragGuard());
    const over = new Event('dragover', { cancelable: true });
    win.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    rt.unmount();
    const later = new Event('dragover', { cancelable: true });
    win.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });
});
