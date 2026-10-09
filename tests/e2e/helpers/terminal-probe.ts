import { type ElectronApplication, type Page } from '@playwright/test';

/**
 * Shared xterm/IPC probing helpers, extracted from `fonts.spec.ts` so
 * `terminal-font-size.spec.ts` can reuse the exact same identity-preserving
 * probe and resize-recording mechanics instead of re-deriving them.
 */

export type ResizeCall = { projectId: number; shellIndex: number; cols: number; rows: number };
type InvokeHandler = (event: unknown, request: unknown) => unknown;
type IpcMainWithHandlers = { _invokeHandlers?: Map<string, InvokeHandler> };
type ResizeGlobals = typeof globalThis & { __fontResizeCalls: ResizeCall[] };

export type TermProbe = {
  key: 'left' | 'right' | 'single';
  token: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number | string;
  fontWeightBold: number | string;
  cols: number;
  rows: number;
  bufferLength: number;
  selection: string;
  textareaValue: string;
  unicodeVersion: string;
  screen: string;
};

/** Finds xterm Terminal refs through the same React-fiber hook precedent as claude-tab-remount.spec.ts. */
export async function terminalProbes(win: Page): Promise<TermProbe[]> {
  return win.evaluate(() => {
    type Line = { translateToString: (trim: boolean) => string };
    type Buffer = {
      baseY: number;
      viewportY: number;
      length: number;
      getLine: (row: number) => Line | undefined;
    };
    type Term = {
      cols: number;
      rows: number;
      options: { fontFamily?: string; fontSize?: number; fontWeight?: number | string; fontWeightBold?: number | string };
      buffer: { active: Buffer };
      textarea?: HTMLTextAreaElement;
      unicode: { activeVersion: string };
      getSelection: () => string;
    };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    type ProbeGlobals = { __fontTermIds?: WeakMap<object, number>; __fontNextTermId?: number };
    const globals = window as unknown as Window & ProbeGlobals;
    globals.__fontTermIds ??= new WeakMap<object, number>();
    globals.__fontNextTermId ??= 1;
    const isTerm = (value: unknown): value is Term => {
      if (!value || typeof value !== 'object') return false;
      const candidate = value as Partial<Term>;
      return !!candidate.buffer?.active && typeof candidate.cols === 'number' && typeof candidate.getSelection === 'function';
    };
    const findTerm = (node: HTMLElement): Term | null => {
      let element: HTMLElement | null = node;
      let fiber: Fiber | null = null;
      while (element && !fiber) {
        const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        if (key) fiber = (element as unknown as Record<string, Fiber>)[key] ?? null;
        element = element.parentElement;
      }
      for (let current = fiber; current; current = current.return) {
        if (current.tag !== 0) continue;
        for (let hook = current.memoizedState as Hook | null; hook; hook = hook.next) {
          const ref = hook.memoizedState as { current?: unknown } | null;
          if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) return ref.current;
        }
      }
      return null;
    };
    return [...document.querySelectorAll<HTMLElement>('.xterm')]
      .filter((node) => node.offsetParent !== null)
      .map((node) => {
        const term = findTerm(node);
        if (!term) throw new Error('visible xterm has no discoverable Terminal ref');
        const ids = globals.__fontTermIds;
        if (!ids) throw new Error('terminal identity registry unavailable');
        let token = ids.get(term);
        if (token === undefined) {
          token = globals.__fontNextTermId ?? 1;
          globals.__fontNextTermId = token + 1;
          ids.set(term, token);
        }
        const buffer = term.buffer.active;
        const visible: string[] = [];
        for (let row = 0; row < term.rows; row += 1) {
          visible.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
        }
        return {
          key: node.closest('[data-testid="split-right"]') ? 'right' : node.closest('.split-left') ? 'left' : 'single',
          token,
          fontFamily: term.options.fontFamily ?? '',
          fontSize: term.options.fontSize ?? 0,
          fontWeight: term.options.fontWeight ?? '',
          fontWeightBold: term.options.fontWeightBold ?? '',
          cols: term.cols,
          rows: term.rows,
          bufferLength: buffer.length,
          selection: term.getSelection(),
          textareaValue: term.textarea?.value ?? '',
          unicodeVersion: term.unicode.activeVersion,
          screen: visible.join('\n'),
        } satisfies TermProbe;
      });
  });
}

export async function installResizeRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const ipcMainWithHandlers = ipcMain as unknown as IpcMainWithHandlers;
    const original = ipcMainWithHandlers._invokeHandlers?.get('shells:resize');
    if (!original) throw new Error('shells:resize handler unavailable');
    const globals = globalThis as ResizeGlobals;
    globals.__fontResizeCalls = [];
    ipcMain.removeHandler('shells:resize');
    ipcMain.handle('shells:resize', (event, request: ResizeCall) => {
      globals.__fontResizeCalls.push({ ...request });
      return original(event, request);
    });
  });
}

export async function resizeCalls(app: ElectronApplication): Promise<ResizeCall[]> {
  return app.evaluate(() => {
    const globals = globalThis as ResizeGlobals;
    return [...globals.__fontResizeCalls];
  });
}

export function latestCallsByShell(calls: ResizeCall[]): Map<number, ResizeCall> {
  const latest = new Map<number, ResizeCall>();
  for (const call of calls) latest.set(call.shellIndex, call);
  return latest;
}

type InvokeRecorderGlobals = typeof globalThis & { __probeInvokeCalls?: Record<string, unknown[]> };
type OriginalHandlerGlobals = typeof globalThis & { __probeOriginalHandlers?: Map<string, InvokeHandler> };

/**
 * Generic `ipcMain.handle` recorder: records every request made on `channel`
 * (by value, not just count) while still delegating to the real handler.
 * Used where a test needs to assert a rejected/clamped call never reached
 * the main process's validated setter (AC7, AC9).
 */
export async function installInvokeRecorder(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, channelName) => {
    const ipcMainWithHandlers = ipcMain as unknown as IpcMainWithHandlers;
    const original = ipcMainWithHandlers._invokeHandlers?.get(channelName);
    if (!original) throw new Error(`${channelName} handler unavailable`);
    const globals = globalThis as InvokeRecorderGlobals;
    globals.__probeInvokeCalls ??= {};
    globals.__probeInvokeCalls[channelName] = [];
    ipcMain.removeHandler(channelName);
    ipcMain.handle(channelName, (event, request: unknown) => {
      globals.__probeInvokeCalls![channelName]!.push(request);
      return original(event, request);
    });
  }, channel);
}

export async function invokeCalls(app: ElectronApplication, channel: string): Promise<unknown[]> {
  return app.evaluate((_electron, channelName) => {
    const globals = globalThis as InvokeRecorderGlobals;
    return [...(globals.__probeInvokeCalls?.[channelName] ?? [])];
  }, channel);
}

/**
 * Replaces `channel`'s handler with one that always throws, so a test can
 * exercise a save-failure path (AC14) against the real IPC round trip. The
 * original handler is preserved on `globalThis` for `restoreHandler`.
 */
export async function installFailingHandler(app: ElectronApplication, channel: string, message: string): Promise<void> {
  await app.evaluate(({ ipcMain }, args) => {
    const ipcMainWithHandlers = ipcMain as unknown as IpcMainWithHandlers;
    const original = ipcMainWithHandlers._invokeHandlers?.get(args.channelName);
    if (!original) throw new Error(`${args.channelName} handler unavailable`);
    const globals = globalThis as OriginalHandlerGlobals;
    globals.__probeOriginalHandlers ??= new Map();
    globals.__probeOriginalHandlers.set(args.channelName, original);
    ipcMain.removeHandler(args.channelName);
    ipcMain.handle(args.channelName, () => {
      throw new Error(args.message);
    });
  }, { channelName: channel, message });
}

/**
 * Delays the main process's reply to `settings:get` for one specific settings key by
 * `delayMs`; every other key still resolves immediately through the real handler.
 * Install this *before* the window that must observe the delay is created: the
 * handler swap happens entirely inside the main process (a direct `ipcMain.handle`
 * replacement), independent of any renderer's load state, so — unlike seeding
 * localStorage before a renderer's first paint (which loses the race against that
 * renderer's own first script execution) — a window created after this call is
 * guaranteed to hit the delay on its first `settings:get` for `targetKey`, no race.
 * Restore with `restoreHandler(app, 'settings:get')`.
 */
export async function installDelayedGet(app: ElectronApplication, targetKey: string, delayMs: number): Promise<void> {
  await app.evaluate(({ ipcMain }, args) => {
    const ipcMainWithHandlers = ipcMain as unknown as IpcMainWithHandlers;
    const original = ipcMainWithHandlers._invokeHandlers?.get('settings:get');
    if (!original) throw new Error('settings:get handler unavailable');
    const globals = globalThis as OriginalHandlerGlobals;
    globals.__probeOriginalHandlers ??= new Map();
    globals.__probeOriginalHandlers.set('settings:get', original);
    ipcMain.removeHandler('settings:get');
    ipcMain.handle('settings:get', async (event, request: { key?: string }) => {
      if (request?.key === args.targetKey) {
        await new Promise((resolve) => setTimeout(resolve, args.delayMs));
      }
      return original(event, request);
    });
  }, { targetKey, delayMs });
}

/** Restores the handler `installFailingHandler` replaced. */
export async function restoreHandler(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, channelName) => {
    const globals = globalThis as OriginalHandlerGlobals;
    const original = globals.__probeOriginalHandlers?.get(channelName);
    if (!original) throw new Error(`${channelName} original handler was never recorded`);
    ipcMain.removeHandler(channelName);
    ipcMain.handle(channelName, original);
    globals.__probeOriginalHandlers?.delete(channelName);
  }, channel);
}
