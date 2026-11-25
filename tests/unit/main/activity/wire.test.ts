import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isActivityLogEnabled, wireActivityLog } from '@main/activity/wire';
import { createHookFanout } from '@main/claude-hooks/hook-fanout';
import type { HookListener, ReceivedHook } from '@main/claude-hooks/receiver';
import { SessionRegistry, type ShellKey } from '@main/claude-hooks/session-registry';
import { ClaudeHookHistory } from '@main/notifications/claude-hook-history';
import { installClaudeNotifications } from '@main/notifications/install';
import { ViewedShells } from '@main/notifications/viewed-shells';
import type { ActivityEntry } from '@shared/activity';

const K: ShellKey = { projectId: 4, shellIndex: 1 };

const ev = (hookEventName: string, extra: Record<string, unknown> = {}) => ({
  hookEventName, notificationType: null, message: null, backgroundTaskCount: 0,
  toolName: null, toolTarget: null, toolOk: null, ...extra,
});

const EVENTS = [
  ev('PreToolUse', { toolName: 'Edit', toolTarget: 'a.ts' }),
  ev('PostToolUse', { toolName: 'Edit', toolTarget: 'a.ts', toolOk: true }),
  ev('UserPromptSubmit', { message: 'hi' }),
  ev('Notification', { notificationType: 'permission_prompt', message: 'ok?' }),
  ev('Stop'),
];

function harness(initial: unknown = true) {
  const dir = mkdtempSync(join(tmpdir(), 'activity-wire-'));
  const state = { value: initial as unknown, throws: false };
  const settings = {
    get: vi.fn(() => {
      if (state.throws) throw new Error('db down');
      return state.value as boolean;
    }),
  };
  let listener: HookListener = () => {};
  const broadcast = vi.fn<(id: number, e: ActivityEntry) => void>();
  wireActivityLog({
    hooks: { onHook: (l) => { listener = l; } },
    projects: { get: (id: number) => (id === 4 ? { path: dir } : null) } as never,
    broadcast,
    settings,
  });
  const emit = (event: ReturnType<typeof ev>, projectId = 4) =>
    listener({ sessionId: 's', shell: { projectId, shellIndex: 1 }, event });
  const file = join(dir, '.metaide', 'activity.jsonl');
  return { dir, file, state, settings, broadcast, emit };
}

const dirs: string[] = [];
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const h = (initial?: unknown) => { const x = harness(initial); dirs.push(x.dir); return x; };
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const norm = (line: string) => { const { id, ts, ...rest } = JSON.parse(line); void id; void ts; return rest; };

describe('isActivityLogEnabled (AC13)', () => {
  it.each([[false, false], [true, true]])('%s reads %s with no warning', (v, out) => {
    const warn = vi.spyOn(console, 'warn');
    expect(isActivityLogEnabled({ get: () => v as boolean })).toBe(out);
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([[null], ['no'], [0], [undefined]])('%s is treated as on with exactly one warning', (v) => {
    const warn = vi.spyOn(console, 'warn');
    expect(isActivityLogEnabled({ get: () => v as unknown as boolean })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('[activity] setting read failed; treating as on');
  });
  it('a throwing get is treated as on, one warning per call', () => {
    const warn = vi.spyOn(console, 'warn');
    const s = { get: () => { throw new Error('x'); } };
    expect(isActivityLogEnabled(s)).toBe(true);
    expect(isActivityLogEnabled(s)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('wireActivityLog guard', () => {
  it('off: no folder, no file, no broadcast for any of the five hook kinds (AC3, AC4)', () => {
    const t = h(false);
    for (const e of EVENTS) t.emit(e);
    expect(existsSync(join(t.dir, '.metaide'))).toBe(false);
    expect(t.broadcast).not.toHaveBeenCalled();
  });

  it('off with an existing file leaves size and mtime unchanged (AC5)', () => {
    const t = h(false);
    mkdirSync(join(t.dir, '.metaide'));
    writeFileSync(t.file, '{"keep":1}\n');
    utimesSync(t.file, 1000, 1000);
    const before = statSync(t.file);
    for (const e of EVENTS) t.emit(e);
    const after = statSync(t.file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(t.file, 'utf8')).toBe('{"keep":1}\n');
  });

  it('on: one line and one broadcast per hook, with the established entry shape (AC11)', () => {
    const t = h(true);
    for (const e of EVENTS) t.emit(e);
    expect(lines(t.file).map(norm)).toEqual([
      { kind: 'tool', agent: 'claude', shellIndex: 1, tool: 'Edit', target: 'a.ts' },
      { kind: 'tool', agent: 'claude', shellIndex: 1, tool: 'Edit', target: 'a.ts', ok: true },
      { kind: 'prompt', agent: 'claude', shellIndex: 1, text: 'hi' },
      { kind: 'notification', agent: 'claude', shellIndex: 1, text: 'ok?' },
      { kind: 'turn-end', agent: 'claude', shellIndex: 1 },
    ]);
    expect(t.broadcast).toHaveBeenCalledTimes(5);
    expect(t.broadcast.mock.calls.map(([, e]) => norm(JSON.stringify(e)))).toEqual(lines(t.file).map(norm));
  });

  it('reads the setting on every hook, in both directions (AC6)', () => {
    const t = h(true);
    t.emit(EVENTS[0]!);
    t.state.value = false;
    t.emit(EVENTS[1]!);
    t.state.value = true;
    t.emit(EVENTS[2]!);
    expect(lines(t.file).map((l) => norm(l).kind)).toEqual(['tool', 'prompt']);
    expect(t.settings.get).toHaveBeenCalledTimes(3);
  });

  it('on, off, on: no back-fill of the off phase (AC16)', () => {
    const t = h(true);
    t.emit(EVENTS[0]!);
    const original = readFileSync(t.file, 'utf8');
    t.state.value = false;
    t.emit(EVENTS[1]!); t.emit(EVENTS[2]!);
    expect(readFileSync(t.file, 'utf8')).toBe(original);
    t.state.value = true;
    t.emit(EVENTS[4]!);
    const now = readFileSync(t.file, 'utf8');
    expect(now.startsWith(original)).toBe(true);
    expect(lines(t.file).map((l) => norm(l).kind)).toEqual(['tool', 'turn-end']);
  });

  it('a flip inside the broadcast of hook N drops hook N+1 and never throws (AC14)', () => {
    const t = h(true);
    t.broadcast.mockImplementationOnce(() => { t.state.value = false; });
    expect(() => { t.emit(EVENTS[0]!); t.emit(EVENTS[1]!); }).not.toThrow();
    expect(lines(t.file)).toHaveLength(1);
    expect(t.broadcast).toHaveBeenCalledTimes(1);
  });

  it('a setting read failure logs and keeps recording (AC13)', () => {
    const t = h(true);
    t.state.throws = true;
    t.emit(EVENTS[0]!);
    expect(lines(t.file)).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

class FakeNotification extends EventEmitter {
  static instances: { opts: unknown; shown: number }[] = [];
  static isSupported(): boolean { return true; }
  private readonly rec: { opts: unknown; shown: number };
  constructor(opts: unknown) { super(); this.rec = { opts, shown: 0 }; FakeNotification.instances.push(this.rec); }
  show(): void { this.rec.shown += 1; }
  close(): void {}
}

function fanoutRun(activityValue: boolean | 'throw') {
  FakeNotification.instances = [];
  const sessions = new SessionRegistry();
  const history = new ClaudeHookHistory({ sessions, lastOutputAt: () => null, now: () => 0 });
  const win = { isDestroyed: () => false, isMinimized: () => false, restore() {}, show() {}, focus() {} };
  const pty = Object.assign(new EventEmitter(), { isAlive: () => true });
  let source: HookListener = () => {};
  const fanout = createHookFanout({ onHook: (l) => { source = l; } });
  installClaudeNotifications({
    hooks: fanout, history, sessions, ptyManager: pty, viewedShells: new ViewedShells(),
    settings: { get: () => true }, projects: { get: (id: number) => (id === 4 ? { name: 'api' } : null) },
    notificationClass: FakeNotification as never,
    windows: { main: () => win, popout: () => null, focused: () => null }, broadcast: vi.fn(),
  });
  const dir = mkdtempSync(join(tmpdir(), 'activity-fan-'));
  dirs.push(dir);
  wireActivityLog({
    hooks: fanout,
    projects: { get: (id: number) => (id === 4 ? { path: dir } : null) } as never,
    broadcast: vi.fn(),
    settings: { get: () => { if (activityValue === 'throw') throw new Error('x'); return activityValue; } },
  });
  const s = sessions.issue(K);
  const stream: ReceivedHook[] = [
    ...EVENTS.map((event) => ({ sessionId: s.id, shell: K, event })),
    { sessionId: s.id, shell: { projectId: 99, shellIndex: 1 }, event: ev('Stop') },
  ];
  for (const hook of stream) source(hook);
  return { notes: FakeNotification.instances.map((n) => ({ ...n })), state: history.stateOf(K), file: join(dir, '.metaide', 'activity.jsonl') };
}

describe('activity guard is isolated from notifications and history (AC7, AC13)', () => {
  it('notifications and hook history are identical with the log on or off', () => {
    const on = fanoutRun(true);
    const off = fanoutRun(false);
    expect(existsSync(on.file)).toBe(true);
    expect(existsSync(off.file)).toBe(false);
    expect(off.notes).toEqual(on.notes);
    expect(off.state).toEqual(on.state);
    expect(on.notes.length).toBeGreaterThan(0);
  });
  it('a throwing settings read does not stop notifications', () => {
    const base = fanoutRun(true);
    const thrown = fanoutRun('throw');
    expect(thrown.notes).toEqual(base.notes);
  });
});
