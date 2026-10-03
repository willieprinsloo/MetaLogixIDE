import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { installClaudeStatus, TICK_MS } from '@main/claude-status/install';
import { ClaudeStateTracker, STALE_BUSY_MS } from '@main/claude-status/state-tracker';
import { createHookFanout } from '@main/claude-hooks/hook-fanout';
import { SessionRegistry, type ShellKey } from '@main/claude-hooks/session-registry';
import type { HookListener, ReceivedHook } from '@main/claude-hooks/receiver';
import { installClaudeNotifications } from '@main/notifications/install';
import { ViewedShells } from '@main/notifications/viewed-shells';

const K: ShellKey = { projectId: 4, shellIndex: 1 };

function fakePty() {
  const state = { alive: true, lastDataAt: 0 };
  return Object.assign(new EventEmitter(), { state, isAlive: vi.fn(() => state.alive) });
}

function fakeReceiver() {
  let listener: HookListener = () => {};
  return { onHook: vi.fn((l: HookListener) => { listener = l; }), emit: (h: ReceivedHook) => listener(h) };
}

function setup() {
  const clock = { now: 5_000_000 };
  const sessions = new SessionRegistry();
  const pty = fakePty();
  const tracker = new ClaudeStateTracker({ sessions, lastOutputAt: () => pty.state.lastDataAt, now: () => clock.now });
  const receiver = fakeReceiver();
  const broadcast = vi.fn();
  const handle = installClaudeStatus({ receiver, tracker, ptyManager: pty, broadcast });
  const session = sessions.issue(K);
  const hook = (hookEventName: string, extra: Record<string, unknown> = {}): ReceivedHook =>
    ({ sessionId: session.id, shell: { ...K }, event: { hookEventName, notificationType: null, message: null, backgroundTaskCount: 0, ...extra } });
  return { clock, sessions, pty, tracker, receiver, broadcast, handle, session, hook };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('installClaudeStatus', () => {
  it('a hook from the receiver reaches the tracker and broadcasts claude-state:changed', () => {
    const t = setup();
    t.receiver.emit(t.hook('UserPromptSubmit'));
    expect(t.tracker.stateOf(K)).toBe('busy');
    expect(t.broadcast).toHaveBeenCalledWith('claude-state:changed', { projectId: 4, shellIndex: 1, state: 'busy' });
    t.handle.stop();
  });

  it('the broadcast payload has exactly projectId, shellIndex and state, even for a hook carrying tool_input, message and prompt (plan §6)', () => {
    const t = setup();
    t.receiver.emit(t.hook('PermissionRequest', { message: 'MSG-SECRET', tool_input: { command: 'TOOL-SECRET' }, prompt: 'PROMPT-SECRET' }));
    expect(t.broadcast).toHaveBeenCalledTimes(1);
    const [channel, payload] = t.broadcast.mock.calls[0]!;
    expect(channel).toBe('claude-state:changed');
    expect(Object.keys(payload as object).sort()).toEqual(['projectId', 'shellIndex', 'state']);
    expect(JSON.stringify(payload)).not.toContain('SECRET');
    t.handle.stop();
  });

  it('PTY input reaches the tracker: an answering keystroke unblocks, an arrow key does not (AC7)', () => {
    const t = setup();
    t.receiver.emit(t.hook('PermissionRequest'));
    t.pty.emit('input', { ...K, data: '\x1b[A' });
    expect(t.tracker.stateOf(K)).toBe('blocked');
    t.pty.emit('input', { ...K, data: '\r' });
    expect(t.tracker.stateOf(K)).toBe('busy');
    expect(t.broadcast).toHaveBeenLastCalledWith('claude-state:changed', { projectId: 4, shellIndex: 1, state: 'busy' });
    t.handle.stop();
  });

  it('PTY input for another shell does not unblock this one', () => {
    const t = setup();
    t.receiver.emit(t.hook('PermissionRequest'));
    t.pty.emit('input', { projectId: 4, shellIndex: 2, data: '\r' });
    expect(t.tracker.stateOf(K)).toBe('blocked');
    t.handle.stop();
  });

  it('PTY exit of a shell that is no longer alive discards its state and broadcasts idle (AC9)', () => {
    const t = setup();
    t.receiver.emit(t.hook('UserPromptSubmit'));
    t.pty.state.alive = false;
    t.pty.emit('exit', { ...K, code: 0 });
    expect(t.pty.isAlive).toHaveBeenCalledWith(4, 1);
    expect(t.broadcast).toHaveBeenLastCalledWith('claude-state:changed', { projectId: 4, shellIndex: 1, state: 'idle' });
    expect(t.tracker.list()).toEqual([]);
    t.handle.stop();
  });

  it("an old spawn's exit after a respawn leaves the successor's state alone", () => {
    const t = setup();
    const fresh = t.sessions.issue(K);
    t.receiver.emit({ ...t.hook('PermissionRequest'), sessionId: fresh.id });
    t.pty.state.alive = true;
    t.pty.emit('exit', { ...K, code: 0 });
    expect(t.tracker.stateOf(K)).toBe('blocked');
    expect(t.broadcast).toHaveBeenCalledTimes(1);
    t.handle.stop();
  });

  it('ticks the tracker every second, so a silent busy shell turns idle (AC8)', () => {
    vi.useFakeTimers();
    const t = setup();
    t.receiver.emit(t.hook('UserPromptSubmit'));
    t.clock.now += STALE_BUSY_MS;
    vi.advanceTimersByTime(TICK_MS);
    expect(t.tracker.stateOf(K)).toBe('idle');
    expect(t.broadcast).toHaveBeenLastCalledWith('claude-state:changed', { projectId: 4, shellIndex: 1, state: 'idle' });
    t.handle.stop();
  });

  it('uses a 1 s tick', () => {
    expect(TICK_MS).toBe(1000);
  });

  it('stop() clears the tick interval and stops broadcasting', () => {
    vi.useFakeTimers();
    const t = setup();
    const tick = vi.spyOn(t.tracker, 'tick');
    vi.advanceTimersByTime(TICK_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    t.handle.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(TICK_MS * 5);
    expect(tick).toHaveBeenCalledTimes(1);
    t.receiver.emit(t.hook('UserPromptSubmit'));
    expect(t.broadcast).not.toHaveBeenCalled();
  });

  it('the tick timer does not keep the process alive', () => {
    const unref = vi.fn();
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      const timer = real(fn, ms);
      const origUnref = timer.unref.bind(timer);
      timer.unref = () => { unref(); return origUnref(); };
      return timer;
    }) as typeof setInterval);
    const t = setup();
    expect(unref).toHaveBeenCalledTimes(1);
    t.handle.stop();
  });
});

describe('Claude status alongside notifications, wired as index.ts does (AC11, R2)', () => {
  function wired(opts: { toggles: boolean; viewing: boolean }) {
    const sessions = new SessionRegistry();
    const pty = fakePty();
    const receiver = fakeReceiver();
    const tracker = new ClaudeStateTracker({ sessions, lastOutputAt: () => null, now: () => 0 });
    const viewedShells = new ViewedShells();
    vi.spyOn(viewedShells, 'isViewing').mockReturnValue(opts.viewing);
    const shown: string[] = [];
    const notificationClass = Object.assign(
      vi.fn(function (this: { show(): void; close(): void; on(): void }, o: { body: string }) {
        this.show = () => { shown.push(o.body); };
        this.close = () => {};
        this.on = () => {};
      }),
      { isSupported: () => true },
    );
    installClaudeNotifications({
      hooks: tracker, sessions, ptyManager: pty, viewedShells, settings: { get: () => opts.toggles },
      projects: { get: () => ({ name: 'api' }) },
      notificationClass: notificationClass as never,
      windows: { main: () => null, popout: () => null, focused: () => null },
      broadcast: vi.fn(),
    });
    const broadcast = vi.fn();
    const handle = installClaudeStatus({ receiver: createHookFanout(receiver), tracker, ptyManager: pty, broadcast });
    const s = sessions.issue(K);
    const emit = (hookEventName: string, extra: Record<string, unknown> = {}) =>
      receiver.emit({ sessionId: s.id, shell: K, event: { hookEventName, notificationType: null, message: null, backgroundTaskCount: 0, ...extra } });
    return { sessions, pty, receiver, broadcast, handle, emit, shown, notificationClass };
  }

  it('tracks state with both notification toggles off and the shell in view; the tracker still confirms the session', () => {
    const w = wired({ toggles: false, viewing: true });
    w.emit('UserPromptSubmit');
    w.emit('Notification', { notificationType: 'permission_prompt', message: 'x' });
    expect(w.receiver.onHook).toHaveBeenCalledTimes(1);
    expect(w.broadcast.mock.calls).toEqual([
      ['claude-state:changed', { projectId: 4, shellIndex: 1, state: 'busy' }],
      ['claude-state:changed', { projectId: 4, shellIndex: 1, state: 'blocked' }],
    ]);
    expect(w.sessions.isConfirmed(K)).toBe(true);
    expect(w.notificationClass).not.toHaveBeenCalled();
    w.handle.stop();
  });

  it('a receiver hook reaches the notifier through the tracker: needs-input and finished show, a background Stop does not', () => {
    const w = wired({ toggles: true, viewing: false });
    w.emit('PermissionRequest');
    w.emit('Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    w.pty.emit('input', { ...K, data: '\r' });
    w.emit('Stop', { backgroundTaskCount: 1 });
    w.emit('Stop');
    expect(w.shown).toEqual(['Claude needs your permission to use Bash', 'Claude finished and is waiting for you']);
    w.handle.stop();
  });

  it('on exit the state is discarded even though the notifier released the session first', () => {
    const w = wired({ toggles: false, viewing: false });
    w.emit('PermissionRequest');
    w.pty.state.alive = false;
    w.pty.emit('exit', { ...K, code: 0 });
    expect(w.sessions.currentId(K)).toBeNull();
    expect(w.broadcast).toHaveBeenLastCalledWith('claude-state:changed', { projectId: 4, shellIndex: 1, state: 'idle' });
    w.handle.stop();
  });
});
