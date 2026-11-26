import { describe, expect, it, vi } from 'vitest';
import { FleetNoticeNotifier, installFleetNotices, parseRemoteViewing, RemoteViewing, type FleetNoticeEvent } from '../../../../src/main/notifications/fleet-notices';

const TOWER = 'ab'.repeat(32);
const event = (over: Partial<FleetNoticeEvent> = {}): FleetNoticeEvent => ({
  kind: 'needs-input', projectId: 7, shellIndex: 2, projectName: 'api', body: 'Allow Bash?', deviceId: TOWER, deviceName: 'Tower', ...over,
});

function setup(opts: { supported?: boolean; viewing?: boolean } = {}) {
  const shown: Array<{ title: string; body: string; onClick: () => void; closed: boolean }> = [];
  const toggles = { notify_claude_needs_input: true, notify_claude_finished: true };
  const navigate = vi.fn();
  const notifier = new FleetNoticeNotifier({
    notifications: {
      isSupported: () => opts.supported ?? true,
      show: (o) => { const e = { ...o, closed: false }; shown.push(e); return { close: () => { e.closed = true; } }; },
    },
    isViewing: () => opts.viewing ?? false,
    navigate,
    settings: { get: (k) => toggles[k] },
  });
  return { notifier, shown, toggles, navigate };
}

describe('FleetNoticeNotifier', () => {
  it('names the project, the machine and the shell, and a click opens that shell', () => {
    const { notifier, shown, navigate } = setup();
    notifier.handle(event());
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'api on Tower — shell 2', body: 'Allow Bash?' });
    shown[0]!.onClick();
    expect(navigate).toHaveBeenCalledWith(event());
  });

  it('falls back to a generic project name', () => {
    const { notifier, shown } = setup();
    notifier.handle(event({ projectName: null }));
    expect(shown[0]!.title).toBe('Remote project on Tower — shell 2');
  });

  it('obeys this machine\'s toggle for the kind', () => {
    const { notifier, shown, toggles } = setup();
    toggles.notify_claude_needs_input = false;
    notifier.handle(event());
    notifier.handle(event({ kind: 'finished' }));
    expect(shown.map((s) => s.title)).toEqual(['api on Tower — shell 2']);
    toggles.notify_claude_finished = false;
    notifier.handle(event({ kind: 'finished' }));
    expect(shown).toHaveLength(1);
  });

  it('shows nothing while that shell is in view, or when the OS cannot notify', () => {
    const viewing = setup({ viewing: true });
    viewing.notifier.handle(event());
    expect(viewing.shown).toEqual([]);
    const unsupported = setup({ supported: false });
    unsupported.notifier.handle(event());
    expect(unsupported.shown).toEqual([]);
  });

  it('replaces the previous notice for the same remote shell only', () => {
    const { notifier, shown } = setup();
    notifier.handle(event());
    notifier.handle(event({ shellIndex: 3 }));
    notifier.handle(event({ deviceId: 'cd'.repeat(32) }));
    notifier.handle(event({ body: 'again' }));
    expect(shown.map((s) => s.closed)).toEqual([true, false, false, false]);
  });
});

describe('installFleetNotices', () => {
  const win = (destroyed = false) => ({ isDestroyed: () => destroyed, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() });
  class FakeNotification {
    static shown: FakeNotification[] = [];
    static isSupported() { return true; }
    handlers = new Map<string, () => void>();
    constructor(readonly opts: { title: string; body: string }) {}
    on(ev: string, cb: () => void) { this.handlers.set(ev, cb); }
    show() { FakeNotification.shown.push(this); }
    close() {}
  }

  function install(focusedIsMain: boolean) {
    FakeNotification.shown = [];
    const main = win();
    const viewing = new RemoteViewing();
    const broadcast = vi.fn();
    const notifier = installFleetNotices({
      viewing,
      settings: { get: () => true },
      notificationClass: FakeNotification as never,
      windows: { main: () => main, focused: () => (focusedIsMain ? main : null) },
      broadcast,
    });
    return { notifier, viewing, main, broadcast };
  }

  it('holds a notice back only while the focused main window shows that very shell', () => {
    const focused = install(true);
    focused.viewing.set({ deviceId: TOWER, projectId: 7, shellIndex: 2 });
    focused.notifier.handle(event());
    expect(FakeNotification.shown).toHaveLength(0);
    focused.notifier.handle(event({ shellIndex: 3 })); // another tab of the same project
    expect(FakeNotification.shown).toHaveLength(1);
    focused.viewing.set(null);
    focused.notifier.handle(event());
    expect(FakeNotification.shown).toHaveLength(2);

    const unfocused = install(false);
    unfocused.viewing.set({ deviceId: TOWER, projectId: 7, shellIndex: 2 });
    unfocused.notifier.handle(event());
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it('a click raises the main window and asks the renderer to open the remote shell', () => {
    const { notifier, main, broadcast } = install(false);
    notifier.handle(event({ projectName: null }));
    FakeNotification.shown[0]!.handlers.get('click')!();
    expect(main.restore).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('p2p:focus-remote-shell', { deviceId: TOWER, deviceName: 'Tower', projectId: 7, projectName: '', shellIndex: 2 });
  });
});

describe('parseRemoteViewing', () => {
  it('accepts null and an exact shell reference', () => {
    expect(parseRemoteViewing({ shell: null })).toBeNull();
    expect(parseRemoteViewing({ shell: { deviceId: TOWER, projectId: 1, shellIndex: 0, extra: 1 } })).toEqual({ deviceId: TOWER, projectId: 1, shellIndex: 0 });
  });
  it.each([
    null, undefined, 'x', [], {}, { shell: 'x' }, { shell: [] },
    { shell: { deviceId: 'short', projectId: 1, shellIndex: 0 } },
    { shell: { deviceId: TOWER.toUpperCase(), projectId: 1, shellIndex: 0 } },
    { shell: { deviceId: TOWER, projectId: 0, shellIndex: 0 } },
    { shell: { deviceId: TOWER, projectId: 1, shellIndex: -1 } },
    { shell: { deviceId: TOWER, projectId: 1.5, shellIndex: 0 } },
    { shell: { deviceId: TOWER, projectId: 1, shellIndex: 2_000_000 } },
  ])('rejects %j', (bad) => {
    expect(() => parseRemoteViewing(bad)).toThrow('invalid p2p:viewing');
  });
});
