/** Behavioral regression tests for the first visible local terminal viewport after asynchronous snapshot replay. */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';

const runtime = vi.hoisted(() => {
  type Effect = { deps?: readonly unknown[]; cleanup?: () => void; run?: () => unknown };
  type Scope = { slots: unknown[]; effects: Effect[]; cursor: number; effectCursor: number };
  const fresh = (): Scope => ({ slots: [], effects: [], cursor: 0, effectCursor: 0 });
  const scopes = new Map<string, Scope>();
  let current = fresh();
  const changed = (left?: readonly unknown[], right?: readonly unknown[]) =>
    !left || !right || left.length !== right.length || left.some((value, index) => !Object.is(value, right[index]));
  return {
    reset() { scopes.clear(); current = fresh(); },
    render<T>(key: string, fn: () => T, attach: (result: T) => void): T {
      const scope = scopes.get(key) ?? fresh();
      scopes.set(key, scope);
      current = scope;
      scope.cursor = 0;
      scope.effectCursor = 0;
      const result = fn();
      attach(result);
      for (const effect of scope.effects.filter((item) => item.run)) {
        effect.cleanup?.();
        const cleanup = effect.run?.();
        effect.run = undefined;
        effect.cleanup = typeof cleanup === 'function' ? () => { cleanup(); } : undefined;
      }
      return result;
    },
    unmount() { for (const scope of scopes.values()) for (const effect of scope.effects) effect.cleanup?.(); },
    useState<S>(initial: S | (() => S)) {
      const { slots } = current;
      const index = current.cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => S)() : initial;
      const set = (next: S | ((previous: S) => S)) => {
        slots[index] = typeof next === 'function' ? (next as (previous: S) => S)(slots[index] as S) : next;
      };
      return [slots[index] as S, set] as const;
    },
    useRef<R>(initial: R) {
      const { slots } = current;
      const index = current.cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: R };
    },
    useEffect(run: () => unknown, deps?: readonly unknown[]) {
      const { effects } = current;
      const index = current.effectCursor++;
      const previous = effects[index];
      if (!previous || changed(previous.deps, deps)) effects[index] = { deps, cleanup: previous?.cleanup, run };
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: runtime.useState,
  useRef: runtime.useRef,
  useEffect: runtime.useEffect,
  useCallback: <T,>(callback: T) => callback,
}));

type TerminalProbe = {
  readonly writes: string[];
  readonly pending: Array<() => void>;
  readonly scrollToBottom: Mock;
  readonly buffer: { normal: { baseY: number; viewportY: number }; alternate: { baseY: number; viewportY: number }; active: { baseY: number; viewportY: number } };
  opened: boolean;
  finishWrite(): void;
  userScroll(position: number): void;
};
const terminals = vi.hoisted(() => ({ instances: [] as TerminalProbe[] }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    unicode = { activeVersion: '11' };
    buffer = {
      normal: { baseY: 0, viewportY: 0 },
      alternate: { baseY: 0, viewportY: 0 },
      active: { baseY: 0, viewportY: 0 },
    };
    writes: string[] = [];
    pending: Array<() => void> = [];
    opened = false;
    scrollToBottom = vi.fn(() => { this.buffer.active.viewportY = this.buffer.active.baseY; });
    constructor() { this.buffer.active = this.buffer.normal; terminals.instances.push(this); }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() { return { dispose() {} }; }
    onData() {}
    open() { this.opened = true; }
    reset() {
      this.buffer.normal.baseY = 0;
      this.buffer.normal.viewportY = 0;
      this.buffer.alternate.baseY = 0;
      this.buffer.alternate.viewportY = 0;
      this.buffer.active = this.buffer.normal;
    }
    write(text: string, callback?: () => void) {
      this.writes.push(text);
      this.pending.push(() => {
        const normalLines = text.split('\u001b[?1049h')[0]?.split('\n').length ?? 1;
        if (normalLines > 24) this.buffer.normal.baseY += normalLines - 24;
        if (text.includes('\u001b[?1049h')) this.buffer.active = this.buffer.alternate;
        callback?.();
      });
    }
    finishWrite() {
      const parse = this.pending.shift();
      if (!parse) throw new Error('Expected queued terminal parser work');
      parse();
    }
    userScroll(position: number) { this.buffer.active.viewportY = position; }
    focus() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    refresh() {}
    clearTextureAtlas() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: function Unicode11Addon() {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: function WebLinksAddon() {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: function SearchAddon() {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} } }));
vi.mock('@renderer/terminal-font-update', () => ({
  createTerminalFontUpdater: () => ({ apply: async () => undefined, dispose() {} }),
  createTerminalGeometrySynchronizer: () => () => undefined,
}));
vi.mock('@renderer/fonts/font-settings-context', () => ({ useFontSettings: () => ({ terminalFontFamily: null }) }));
vi.mock('@renderer/fonts/terminal-font-size-context', () => ({ useTerminalFontSize: () => ({ size: 13, ready: true, setSize() {} }) }));
vi.mock('@renderer/fonts/terminal-font-weight-context', () => ({ useTerminalFontWeight: () => ({ weight: 400, boldWeight: 700, ready: true }) }));
vi.mock('@renderer/shortcut-platform', () => ({ useShortcutPlatform: () => 'other' }));
vi.mock('@renderer/hooks/useTerminalDrop', () => ({ useTerminalDrop: () => ({ overlay: null, handlers: {} }) }));
vi.mock('@renderer/hooks/useTerminalPaste', () => ({ useTerminalPaste: () => async () => undefined }));
const focusOpened = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/useWindowTerminalFocus', () => ({
  terminalFocus: { register: () => ({ opened: focusOpened, used() {}, unregister() {} }) },
}));
const stream = vi.hoisted((): { onData: (data: string) => void } => ({ onData: () => undefined }));
vi.mock('@renderer/hooks/useShellStream', () => ({
  useShellStream: (_project: number, _shell: number, onData: (data: string) => void) => { stream.onData = onData; },
}));
vi.mock('@renderer/components/HoverPreview', () => ({ HoverPreview: () => null }));
vi.mock('@renderer/components/ContextMenu', () => ({ ContextMenu: () => null }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({ api: { invoke, on: () => () => undefined } }));

const frameCallbacks: Array<FrameRequestCallback> = [];
const viewport = { attached: true, clientHeight: 480, scrollHeight: 480, scrollTop: 0 };
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const host = {
  clientWidth: 640,
  clientHeight: 480,
  style: { visibility: '' },
  querySelector: (selector: string) => selector === '.xterm-viewport' && viewport.attached ? viewport : null,
  addEventListener() {},
  removeEventListener() {},
};
function attachRefs(node: ReactNode): void {
  if (Array.isArray(node)) { for (const child of node) attachRefs(child); return; }
  if (!isValidElement<{ children?: ReactNode; style?: { visibility?: string } }>(node)) return;
  const ref: unknown = 'ref' in node ? node.ref : null;
  if (ref && typeof ref === 'object' && 'current' in ref) {
    Reflect.set(ref, 'current', host);
    if (node.props.style?.visibility) host.style.visibility = node.props.style.visibility;
  }
  attachRefs(node.props.children);
}
vi.stubGlobal('self', globalThis);
const { ShellTab } = await import('@renderer/components/ShellTab');
async function mount(snapshot: Promise<{ output: string }>): Promise<TerminalProbe> {
  invoke.mockImplementation((channel: string) => channel === 'shells:snapshot' ? snapshot : Promise.resolve(undefined));
  runtime.render('local', () => {
    const tree: unknown = ShellTab({ projectId: 5, shellIndex: 0 });
    if (!isValidElement(tree)) throw new Error('Local terminal did not render');
    return tree;
  }, attachRefs);
  await flush();
  const instance = terminals.instances[0];
  if (!instance?.opened) throw new Error('Local terminal did not open');
  return instance;
}

beforeEach(() => {
  runtime.reset();
  terminals.instances.length = 0;
  invoke.mockReset();
  focusOpened.mockReset();
  frameCallbacks.length = 0;
  host.style.visibility = '';
  viewport.attached = true;
  viewport.clientHeight = 480;
  viewport.scrollHeight = 480;
  viewport.scrollTop = 0;
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('document', {
    documentElement: {},
    fonts: { load: async () => [], ready: Promise.resolve() },
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frameCallbacks.push(callback); return frameCallbacks.length; });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  });
});
afterEach(() => { runtime.unmount(); vi.unstubAllGlobals(); });

describe('local shell initial snapshot viewport', () => {
  it('positions long ordinary scrollback at the newest parsed viewport on the first frame', async () => {
    const snapshot = Promise.withResolvers<{ output: string }>();
    const term = await mount(snapshot.promise);
    expect(invoke).toHaveBeenCalledWith('shells:snapshot', { projectId: 5, shellIndex: 0 });
    expect(term.writes).toEqual([]);
    expect(host.style.visibility).toBe('hidden');
    expect(focusOpened).not.toHaveBeenCalled();
    const output = Array.from({ length: 48 }, (_, index) => `line ${index}\n`).join('');
    snapshot.resolve({ output });
    await flush();
    expect(term.writes).toEqual([output]);
    expect(term.buffer.active.baseY).toBe(0);
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(host.style.visibility).toBe('hidden');
    term.finishWrite();
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    expect(host.style.visibility, 'parser completion must not reveal an unsynchronized DOM viewport').toBe('hidden');
    for (const callback of frameCallbacks.splice(0)) callback(0);
    expect(host.style.visibility, 'xterm has not yet synchronized the scroll area').toBe('hidden');
    viewport.scrollHeight = viewport.clientHeight + term.buffer.active.baseY * 20;
    for (const callback of frameCallbacks.splice(0)) callback(16);
    expect(host.style.visibility, 'scrollbar overflow alone is not a settled bottom position').toBe('hidden');
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    for (const callback of frameCallbacks.splice(0)) callback(32);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
    expect(host.style.visibility).toBe('');
    expect(focusOpened).toHaveBeenCalledOnce();
    term.userScroll(0);
    stream.onData('later update\n');
    term.finishWrite();
    expect(term.buffer.active.viewportY).toBe(0);
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
  });

  it('waits for omp-style alternate-screen replay and queued live output before settling the first visible viewport', async () => {
    const snapshot = Promise.withResolvers<{ output: string }>();
    const term = await mount(snapshot.promise);
    stream.onData('last live update\n');
    const output = `${Array.from({ length: 40 }, (_, index) => `old ${index}\n`).join('')}\u001b[?1049h\u001b[Homp newest`;
    snapshot.resolve({ output });
    await flush();
    expect(term.writes).toEqual([output, 'last live update\n']);
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(host.style.visibility).toBe('hidden');
    term.finishWrite();
    expect(term.buffer.active).toBe(term.buffer.alternate);
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(host.style.visibility).toBe('hidden');
    expect(focusOpened).not.toHaveBeenCalled();
    term.finishWrite();
    for (const callback of frameCallbacks.splice(0)) callback(0);
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
    expect(host.style.visibility).toBe('');
    expect(focusOpened).toHaveBeenCalledOnce();
    term.userScroll(0);
    stream.onData('later update\n');
    expect(term.writes).toEqual([output, 'last live update\n', 'later update\n']);
    term.finishWrite();
    for (const callback of frameCallbacks.splice(0)) callback(0);
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
    expect(term.buffer.active.viewportY).toBe(0);
  });

  it('buffers output that arrives while the initial snapshot is parsing, revealing only after its last parse', async () => {
    const snapshot = Promise.withResolvers<{ output: string }>();
    const term = await mount(snapshot.promise);
    const output = Array.from({ length: 45 }, (_, index) => `old ${index}\n`).join('');
    snapshot.resolve({ output });
    await flush();
    stream.onData('during replay\n');
    expect(term.writes).toEqual([output]);
    term.finishWrite();
    expect(term.writes).toEqual([output, 'during replay\n']);
    expect(host.style.visibility).toBe('hidden');
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    term.finishWrite();
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
    expect(host.style.visibility).toBe('hidden');
    viewport.scrollHeight = viewport.clientHeight + term.buffer.active.baseY * 20;
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    for (const callback of frameCallbacks.splice(0)) callback(0);
    expect(host.style.visibility).toBe('');
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
  });

  it('does not reveal an empty snapshot before its browser viewport attaches', async () => {
    const snapshot = Promise.withResolvers<{ output: string }>();
    const term = await mount(snapshot.promise);
    viewport.attached = false;
    snapshot.resolve({ output: '' });
    await flush();
    expect(term.writes).toEqual([]);
    expect(host.style.visibility).toBe('hidden');
    for (const callback of frameCallbacks.splice(0)) callback(0);
    expect(host.style.visibility).toBe('hidden');
    expect(focusOpened).not.toHaveBeenCalled();
    viewport.attached = true;
    for (const callback of frameCallbacks.splice(0)) callback(16);
    expect(host.style.visibility).toBe('');
    expect(focusOpened).toHaveBeenCalledOnce();
  });
});
