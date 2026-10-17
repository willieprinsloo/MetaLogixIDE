import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, Notification } from 'electron';
import {
  DONE_POLL_INTERVAL_MS,
  formatDoneDuration,
  isMainFocused,
  planDoneNotice,
  startDoneNotifier,
  type DoneCommand,
  type DoneNotifierDeps,
} from '@main/startup/done-notifier';

describe('formatDoneDuration', () => {
  it.each([
    [0, '0s'],
    [499, '0s'],
    [500, '1s'],
    [59_499, '59s'],
    [59_500, '1m 0s'],
    [60_000, '1m 0s'],
    [61_000, '1m 1s'],
    [125_400, '2m 5s'],
    [3_600_000, '60m 0s'],
  ])('formats %d ms as %s', (ms, label) => {
    expect(formatDoneDuration(ms)).toBe(label);
  });
});

describe('isMainFocused', () => {
  const main = { isDestroyed: () => false } as unknown as BrowserWindow;

  it('is true only when the focused window is the live main window', () => {
    expect(isMainFocused(main, main)).toBe(true);
  });

  it('is false with no focused window', () => {
    expect(isMainFocused(null, main)).toBe(false);
  });

  it('is false when another window has focus', () => {
    const other = { isDestroyed: () => false } as unknown as BrowserWindow;
    expect(isMainFocused(other, main)).toBe(false);
  });

  it('is false when the focused main window is destroyed', () => {
    const dead = { isDestroyed: () => true } as unknown as BrowserWindow;
    expect(isMainFocused(dead, dead)).toBe(false);
  });

  it('is false when there is no main window', () => {
    expect(isMainFocused(main, null)).toBe(false);
  });
});

describe('planDoneNotice', () => {
  const inMain: DoneCommand = { projectId: 1, shellIndex: 0, durationMs: 12_000 };
  const unnamed: DoneCommand = { projectId: 2, shellIndex: 3, durationMs: 90_000 };
  const names: Record<number, string> = { 1: 'alpha' };
  const projectName = (id: number): string | undefined => names[id];

  it('notifies a finished shell when the main window is not focused', () => {
    expect(planDoneNotice(inMain, { mainFocused: false, isPopped: () => false, projectName })).toEqual(
      { projectId: 1, shellIndex: 0, popped: false, title: 'alpha — shell 0', body: 'Command finished in 12s' },
    );
  });

  it('names an unknown project by its id', () => {
    expect(planDoneNotice(unnamed, { mainFocused: false, isPopped: () => false, projectName })).toEqual(
      { projectId: 2, shellIndex: 3, popped: false, title: '#2 — shell 3', body: 'Command finished in 1m 30s' },
    );
  });

  it('skips an in-main shell while the main window is focused', () => {
    expect(planDoneNotice(inMain, { mainFocused: true, isPopped: () => false, projectName })).toBeNull();
  });

  it('still notifies a popped-out shell while the main window is focused', () => {
    const isPopped = (key: string): boolean => key === '2:3';
    expect(planDoneNotice(unnamed, { mainFocused: true, isPopped, projectName })).toEqual(
      { projectId: 2, shellIndex: 3, popped: true, title: '#2 — shell 3', body: 'Command finished in 1m 30s' },
    );
  });

  it('keys popouts by projectId:shellIndex and looks the project up first', () => {
    const order: string[] = [];
    const isPopped = vi.fn((key: string) => { order.push(`popped:${key}`); return false; });
    const lookup = vi.fn((id: number) => { order.push(`name:${id}`); return projectName(id); });
    planDoneNotice(unnamed, { mainFocused: true, isPopped, projectName: lookup });
    expect(order).toEqual(['name:2', 'popped:2:3']);
  });

  it('propagates a lookup failure', () => {
    const failure = new Error('db closed');
    expect(() => planDoneNotice(inMain, { mainFocused: false, isPopped: () => false, projectName: () => { throw failure; } })).toThrow(failure);
  });
});

interface FakeWindow {
  destroyed: boolean;
  minimized: boolean;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

function fakeWindow(overrides: Partial<Pick<FakeWindow, 'destroyed' | 'minimized'>> = {}): FakeWindow {
  return {
    destroyed: overrides.destroyed ?? false,
    minimized: overrides.minimized ?? false,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

class FakeNotification {
  static instances: FakeNotification[] = [];
  static throwOnConstruct = false;
  readonly handlers = new Map<string, () => void>();
  readonly show = vi.fn();
  constructor(readonly options: { title: string; body: string; silent: boolean }) {
    if (FakeNotification.throwOnConstruct) throw new Error('no notifications');
    FakeNotification.instances.push(this);
  }
  on(event: string, handler: () => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  click(): void {
    this.handlers.get('click')?.();
  }
}

describe('startDoneNotifier', () => {
  let main: FakeWindow;
  let popouts: Map<string, FakeWindow>;
  let focused: FakeWindow | null;
  let pending: DoneCommand[];
  let deps: DoneNotifierDeps;
  let timer: NodeJS.Timeout | undefined;
  const broadcast = vi.fn();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    FakeNotification.instances = [];
    FakeNotification.throwOnConstruct = false;
    broadcast.mockReset();
    warn.mockClear();
    main = fakeWindow();
    popouts = new Map();
    focused = null;
    pending = [];
    deps = {
      pollDone: () => { const out = pending; pending = []; return out; },
      focusedWindow: () => focused as unknown as BrowserWindow | null,
      mainWindow: () => main as unknown as BrowserWindow,
      popout: (key) => popouts.get(key) as unknown as BrowserWindow | undefined,
      isPopped: (key) => popouts.has(key),
      projectName: (id) => (id === 1 ? 'alpha' : undefined),
      notificationClass: FakeNotification as unknown as typeof Notification,
      broadcast,
    };
  });

  afterEach(() => {
    if (timer) clearInterval(timer);
    timer = undefined;
    vi.useRealTimers();
  });

  it('polls every 500 ms', () => {
    const pollDone = vi.fn(() => []);
    timer = startDoneNotifier({ ...deps, pollDone });
    expect(DONE_POLL_INTERVAL_MS).toBe(500);
    vi.advanceTimersByTime(499);
    expect(pollDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pollDone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(pollDone).toHaveBeenCalledTimes(2);
  });

  it('does not ask for the focused window when nothing finished', () => {
    const focusedWindow = vi.fn(() => null);
    timer = startDoneNotifier({ ...deps, focusedWindow });
    vi.advanceTimersByTime(500);
    expect(focusedWindow).not.toHaveBeenCalled();
  });

  it('shows a non-silent notification with the planned title and body', () => {
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    expect(FakeNotification.instances).toHaveLength(1);
    const n = FakeNotification.instances[0]!;
    expect(n.options).toEqual({ title: 'alpha — shell 2', body: 'Command finished in 5s', silent: false });
    expect(n.show).toHaveBeenCalledTimes(1);
  });

  it('suppresses in-main shells while the main window has focus', () => {
    focused = main;
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('clicking an in-main notice restores and focuses main then requests shell focus', () => {
    main.minimized = true;
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    FakeNotification.instances[0]!.click();
    expect(main.restore).toHaveBeenCalledTimes(1);
    expect(main.show).toHaveBeenCalledTimes(1);
    expect(main.focus).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('shell:focus-request', { projectId: 1, shellIndex: 2 });
  });

  it('clicking does not restore a main window that is not minimised', () => {
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    FakeNotification.instances[0]!.click();
    expect(main.restore).not.toHaveBeenCalled();
    expect(main.show).toHaveBeenCalledTimes(1);
  });

  it('clicking a popped-out notice focuses the live popout only, without broadcasting', () => {
    const pop = fakeWindow();
    popouts.set('1:2', pop);
    focused = main;
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    FakeNotification.instances[0]!.click();
    expect(pop.show).toHaveBeenCalledTimes(1);
    expect(pop.focus).toHaveBeenCalledTimes(1);
    expect(main.show).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('falls back to main + broadcast when the popout closed before the click', () => {
    const pop = fakeWindow();
    popouts.set('1:2', pop);
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    pop.destroyed = true;
    FakeNotification.instances[0]!.click();
    expect(pop.show).not.toHaveBeenCalled();
    expect(main.show).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('shell:focus-request', { projectId: 1, shellIndex: 2 });
  });

  it('routes the click by popout state at notify time, not at click time', () => {
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    const pop = fakeWindow();
    popouts.set('1:2', pop);
    FakeNotification.instances[0]!.click();
    expect(pop.show).not.toHaveBeenCalled();
    expect(main.show).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('shell:focus-request', { projectId: 1, shellIndex: 2 });
  });

  it('skips a destroyed main window on click but still broadcasts', () => {
    main.destroyed = true;
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    FakeNotification.instances[0]!.click();
    expect(main.show).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a click failure', () => {
    broadcast.mockImplementation(() => { throw new Error('boom'); });
    pending = [{ projectId: 1, shellIndex: 2, durationMs: 5_000 }];
    timer = startDoneNotifier(deps);
    vi.advanceTimersByTime(500);
    expect(() => FakeNotification.instances[0]!.click()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[metaide] notification click failed', expect.any(Error));
  });

  it('shows earlier notices before a mid-batch lookup failure escapes the poll', () => {
    pending = [
      { projectId: 1, shellIndex: 0, durationMs: 1_000 },
      { projectId: 2, shellIndex: 1, durationMs: 1_000 },
      { projectId: 1, shellIndex: 2, durationMs: 1_000 },
    ];
    const failure = new Error('lookup failed');
    const projectName = vi.fn((id: number) => {
      if (id === 2) throw failure;
      return 'alpha';
    });
    timer = startDoneNotifier({ ...deps, projectName });
    expect(() => vi.advanceTimersByTime(500)).toThrow(failure);
    expect(FakeNotification.instances.map((n) => n.options.title)).toEqual(['alpha — shell 0']);
    expect(FakeNotification.instances[0]!.show).toHaveBeenCalledTimes(1);
    expect(projectName).toHaveBeenCalledTimes(2);
  });

  it('shows earlier notices before a mid-batch popout check failure escapes the poll', () => {
    pending = [
      { projectId: 1, shellIndex: 0, durationMs: 1_000 },
      { projectId: 1, shellIndex: 1, durationMs: 1_000 },
      { projectId: 1, shellIndex: 2, durationMs: 1_000 },
    ];
    const failure = new Error('popout map gone');
    const isPopped = vi.fn((key: string) => {
      if (key === '1:1') throw failure;
      return false;
    });
    timer = startDoneNotifier({ ...deps, isPopped });
    expect(() => vi.advanceTimersByTime(500)).toThrow(failure);
    expect(FakeNotification.instances.map((n) => n.options.title)).toEqual(['alpha — shell 0']);
    expect(FakeNotification.instances[0]!.show).toHaveBeenCalledTimes(1);
  });

  it('logs a notification failure and carries on with the next shell', () => {
    pending = [
      { projectId: 1, shellIndex: 0, durationMs: 1_000 },
      { projectId: 1, shellIndex: 1, durationMs: 1_000 },
    ];
    let calls = 0;
    const Flaky = class extends FakeNotification {
      constructor(options: { title: string; body: string; silent: boolean }) {
        calls += 1;
        if (calls === 1) throw new Error('denied');
        super(options);
      }
    };
    timer = startDoneNotifier({ ...deps, notificationClass: Flaky as unknown as typeof Notification });
    vi.advanceTimersByTime(500);
    expect(warn).toHaveBeenCalledWith('[metaide] notification failed', expect.any(Error));
    expect(FakeNotification.instances.map((n) => n.options.title)).toEqual(['alpha — shell 1']);
  });
});
