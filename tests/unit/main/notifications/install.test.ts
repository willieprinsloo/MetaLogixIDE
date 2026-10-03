import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyManager } from '@main/pty/manager';
import { createLaunchDecorator } from '@main/claude-hooks/launch-decorator';
import { createNavigation, installClaudeNotifications, liveWindowView, type NavWindow } from '@main/notifications/install';
import { ViewedShells } from '@main/notifications/viewed-shells';
import { SessionRegistry, type ShellKey } from '@main/claude-hooks/session-registry';
import type { ReceivedHook } from '@main/claude-hooks/receiver';
import { ClaudeStateTracker } from '@main/claude-status/state-tracker';

const K: ShellKey = { projectId: 4, shellIndex: 1 };

function fakeWindow(opts: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  const w: NavWindow & { calls: string[] } = {
    calls,
    isDestroyed: () => opts.destroyed ?? false,
    isMinimized: () => opts.minimized ?? false,
    restore: () => { calls.push('restore'); },
    show: () => { calls.push('show'); },
    focus: () => { calls.push('focus'); },
  };
  return w;
}

function navSetup(opts: { popout?: NavWindow | null; main?: NavWindow | null; alive?: boolean }) {
  const broadcast = vi.fn();
  const windows = { main: () => opts.main ?? null, popout: () => opts.popout ?? null, focused: () => null };
  const navigate = createNavigation({ windows, isAlive: () => opts.alive ?? true, broadcast });
  return { navigate, broadcast };
}

describe('createNavigation (AC11–AC13)', () => {
  it('main-window shell: restores, shows and focuses main, then asks the renderer to focus the shell (AC11)', () => {
    const main = fakeWindow({ minimized: true });
    const { navigate, broadcast } = navSetup({ main });
    navigate(K);
    expect(main.calls).toEqual(['restore', 'show', 'focus']);
    expect(broadcast).toHaveBeenCalledWith('shell:focus-request', K);
  });

  it('does not restore a main window that is not minimised', () => {
    const main = fakeWindow();
    navSetup({ main }).navigate(K);
    expect(main.calls).toEqual(['show', 'focus']);
  });

  it('popped-out shell: shows and focuses the popout only (AC12)', () => {
    const main = fakeWindow();
    const popout = fakeWindow();
    const { navigate, broadcast } = navSetup({ main, popout });
    navigate(K);
    expect(popout.calls).toEqual(['show', 'focus']);
    expect(main.calls).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a destroyed popout falls back to the main window', () => {
    const main = fakeWindow();
    const popout = fakeWindow({ destroyed: true });
    const { navigate, broadcast } = navSetup({ main, popout });
    navigate(K);
    expect(popout.calls).toEqual([]);
    expect(main.calls).toEqual(['show', 'focus']);
    expect(broadcast).toHaveBeenCalledWith('shell:focus-request', K);
  });

  it('exited shell: focuses main but never broadcasts a focus request (AC13)', () => {
    const main = fakeWindow({ minimized: true });
    const { navigate, broadcast } = navSetup({ main, alive: false });
    navigate(K);
    expect(main.calls).toEqual(['restore', 'show', 'focus']);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('no main window: does not throw', () => {
    const { navigate } = navSetup({ main: null, alive: false });
    expect(() => navigate(K)).not.toThrow();
  });
});

describe('liveWindowView', () => {
  it('reports destroyed windows as null and passes live ones through', () => {
    const live = fakeWindow();
    const dead = fakeWindow({ destroyed: true });
    const view = liveWindowView({ main: () => live, popout: () => dead, focused: () => dead });
    expect(view.main()).toBe(live);
    expect(view.popout(K)).toBeNull();
    expect(view.focused()).toBeNull();
  });
});

class FakeNotification extends EventEmitter {
  static instances: FakeNotification[] = [];
  static isSupported(): boolean { return true; }
  closed = false;
  constructor(public readonly opts: { title: string; body: string }) { super(); FakeNotification.instances.push(this); }
  show(): void {}
  close(): void { this.closed = true; }
}

type ExitSource = { on(event: 'exit', listener: (ev: ShellKey) => void): unknown; isAlive(projectId: number, shellIndex: number): boolean };

function fakePty() {
  const state = { alive: true };
  return Object.assign(new EventEmitter(), { state, isAlive: () => state.alive });
}

/** Installs the notifier on a real state tracker, as index.ts does; `emit` is a hook arriving from the receiver. */
function installSetup<P extends ExitSource>(ptyManager: P, sessions = new SessionRegistry()) {
  FakeNotification.instances = [];
  const tracker = new ClaudeStateTracker({ sessions, lastOutputAt: () => null, now: () => 0 });
  const main = fakeWindow();
  const broadcast = vi.fn();
  installClaudeNotifications({
    hooks: tracker,
    sessions,
    ptyManager,
    viewedShells: new ViewedShells(),
    settings: { get: () => true },
    projects: { get: (id: number) => (id === 4 ? { name: 'api' } : null) },
    notificationClass: FakeNotification,
    windows: { main: () => main, popout: () => null, focused: () => null },
    broadcast,
  });
  return { emit: (h: ReceivedHook) => tracker.handle(h), sessions, ptyManager, broadcast, main, tracker };
}

const ev = (hookEventName: string, extra: { notificationType?: string; backgroundTaskCount?: number } = {}) =>
  ({ hookEventName, notificationType: null, message: null, backgroundTaskCount: 0, ...extra });
const NEEDS_INPUT = ev('Notification', { notificationType: 'permission_prompt' });

describe('installClaudeNotifications', () => {
  it('routes applied hooks to OS notifications that navigate on click', () => {
    const { emit, sessions, broadcast, main } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: NEEDS_INPUT });
    const n = FakeNotification.instances[0]!;
    expect(n.opts.title).toBe('api — shell 1');
    n.emit('click');
    expect(main.calls).toEqual(['show', 'focus']);
    expect(broadcast).toHaveBeenCalledWith('shell:focus-request', K);
  });

  it('confirms the shell so the generic notifier can skip it', () => {
    const { emit, sessions } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: ev('UserPromptSubmit') });
    expect(sessions.isConfirmed(K)).toBe(true);
  });

  it('confirms even when the toggles are off and nothing is shown (ported from the notifier)', () => {
    const sessions = new SessionRegistry();
    const tracker = new ClaudeStateTracker({ sessions, lastOutputAt: () => null, now: () => 0 });
    FakeNotification.instances = [];
    installClaudeNotifications({
      hooks: tracker, sessions, ptyManager: fakePty(), viewedShells: new ViewedShells(), settings: { get: () => false },
      projects: { get: () => null }, notificationClass: FakeNotification,
      windows: { main: () => null, popout: () => null, focused: () => null }, broadcast: vi.fn(),
    });
    const s = sessions.issue(K);
    tracker.handle({ sessionId: s.id, shell: K, event: ev('UserPromptSubmit') });
    tracker.handle({ sessionId: s.id, shell: K, event: ev('Stop') });
    expect(sessions.isConfirmed(K)).toBe(true);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('a busy turn that ends in a Stop shows "finished" (AC12a)', () => {
    const { emit, sessions } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: ev('UserPromptSubmit') });
    emit({ sessionId: s.id, shell: K, event: ev('Stop') });
    expect(FakeNotification.instances.map((n) => n.opts.body)).toEqual(['Claude finished and is waiting for you']);
  });

  it('a Stop with background tasks shows nothing; the later final Stop shows "finished" once (AC12a, AC12b)', () => {
    const { emit, sessions } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: ev('UserPromptSubmit') });
    emit({ sessionId: s.id, shell: K, event: ev('Stop', { backgroundTaskCount: 2 }) });
    emit({ sessionId: s.id, shell: K, event: ev('Notification', { notificationType: 'idle_prompt' }) });
    expect(FakeNotification.instances).toHaveLength(0);
    emit({ sessionId: s.id, shell: K, event: ev('Stop') });
    expect(FakeNotification.instances.map((n) => n.opts.body)).toEqual(['Claude finished and is waiting for you']);
  });

  it('a Stop on an idle shell shows nothing (AC12b)', () => {
    const { emit, sessions } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: ev('Stop') });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('a hook for a released session (processed after exit) shows nothing (ported from the notifier)', () => {
    const { emit, sessions } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: ev('UserPromptSubmit') });
    sessions.release(K);
    emit({ sessionId: s.id, shell: K, event: ev('Stop') });
    emit({ sessionId: s.id, shell: K, event: NEEDS_INPUT });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('a late needs-input after the user answered shows nothing (AC12c)', () => {
    const { emit, sessions, tracker } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: ev('PermissionRequest') });
    tracker.onInput(K, '\r');
    emit({ sessionId: s.id, shell: K, event: NEEDS_INPUT });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('on PTY exit releases the session and closes the outstanding notification (AC26)', () => {
    const { emit, sessions, ptyManager } = installSetup(fakePty());
    const s = sessions.issue(K);
    emit({ sessionId: s.id, shell: K, event: NEEDS_INPUT });
    ptyManager.state.alive = false;
    ptyManager.emit('exit', { projectId: K.projectId, shellIndex: K.shellIndex, code: 0 });
    expect(FakeNotification.instances[0]!.closed).toBe(true);
    expect(sessions.verify(s.id, s.token)).toBeNull();
  });

  it("an old spawn's exit arriving after a respawn leaves the successor's session and notification alone", () => {
    const { emit, sessions, ptyManager } = installSetup(fakePty());
    const old = sessions.issue(K);
    emit({ sessionId: old.id, shell: K, event: NEEDS_INPUT });
    const fresh = sessions.issue(K);
    emit({ sessionId: fresh.id, shell: K, event: NEEDS_INPUT });
    ptyManager.state.alive = true;
    ptyManager.emit('exit', { projectId: K.projectId, shellIndex: K.shellIndex, code: 0 });
    expect(sessions.verify(fresh.id, fresh.token)).toEqual(K);
    expect(sessions.isConfirmed(K)).toBe(true);
    expect(FakeNotification.instances[1]!.closed).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('installClaudeNotifications — real PTY kill → respawn race', () => {
  it('spawn → kill → respawn → old exit fires: the new session still verifies and its notification stays open', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'race-bin-'));
    const shim = join(bin, 'claude');
    writeFileSync(shim, '#!/bin/sh\nsleep 5\n');
    chmodSync(shim, 0o755);
    const sessions = new SessionRegistry();
    const issued: Array<{ id: string; token: string }> = [];
    const issuer = { issue: (shell: ShellKey) => { const s = sessions.issue(shell); issued.push(s); return s; }, release: (shell: ShellKey) => sessions.release(shell) };
    const pty = new PtyManager({ spawnDecorator: createLaunchDecorator({ sessions: issuer, settingsPath: () => '/tmp/unused-settings.json' }) });
    const { emit } = installSetup(pty, sessions);
    const shell = { projectId: 4, shellIndex: 1 };
    const launch = { argv: [shim], env: {}, cwd: bin, variant: 'first' as const };
    const exits: unknown[] = [];
    pty.on('exit', (ev: unknown) => exits.push(ev));
    await pty.spawn(shell.projectId, shell.shellIndex, launch);
    await pty.kill(shell.projectId, shell.shellIndex);
    await pty.spawn(shell.projectId, shell.shellIndex, launch);
    const fresh = issued[1]!;
    emit({ sessionId: fresh.id, shell, event: NEEDS_INPUT });
    expect(exits).toHaveLength(0);
    const deadline = Date.now() + 3000;
    while (exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(exits).toHaveLength(1);
    expect(sessions.verify(fresh.id, fresh.token)).toEqual(shell);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.closed).toBe(false);
    await pty.kill(shell.projectId, shell.shellIndex);
  }, 10000);
});
