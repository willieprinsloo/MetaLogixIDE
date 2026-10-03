import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OsNotifications } from '@main/notifications/os-notifications';

class FakeNotification extends EventEmitter {
  static supported = true;
  static instances: FakeNotification[] = [];
  static isSupported(): boolean { return FakeNotification.supported; }
  shown = false;
  closed = false;
  constructor(public readonly opts: { title: string; body: string; silent: boolean }) {
    super();
    FakeNotification.instances.push(this);
  }
  show(): void { this.shown = true; }
  close(): void { this.closed = true; this.emit('close'); }
}

function setup() {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
  return new OsNotifications(FakeNotification);
}

describe('OsNotifications', () => {
  it('passes isSupported through (AC25)', () => {
    const os = setup();
    expect(os.isSupported()).toBe(true);
    FakeNotification.supported = false;
    expect(os.isSupported()).toBe(false);
  });

  it('shows a notification with the title and body, not silent', () => {
    const os = setup();
    os.show({ title: 'T', body: 'B', onClick: () => {} });
    const n = FakeNotification.instances[0]!;
    expect(n.opts).toEqual({ title: 'T', body: 'B', silent: false });
    expect(n.shown).toBe(true);
  });

  it('retains the instance after show() returns (electron#21610)', () => {
    const os = setup();
    os.show({ title: 'T', body: 'B', onClick: () => {} });
    expect(os.retainedCount()).toBe(1);
  });

  it('click runs onClick and releases the instance', () => {
    const os = setup();
    const onClick = vi.fn();
    os.show({ title: 'T', body: 'B', onClick });
    FakeNotification.instances[0]!.emit('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(os.retainedCount()).toBe(0);
  });

  it('an OS close event releases the instance without clicking', () => {
    const os = setup();
    const onClick = vi.fn();
    os.show({ title: 'T', body: 'B', onClick });
    FakeNotification.instances[0]!.emit('close');
    expect(os.retainedCount()).toBe(0);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('handle.close() closes the notification and releases it', () => {
    const os = setup();
    const handle = os.show({ title: 'T', body: 'B', onClick: () => {} });
    handle.close();
    expect(FakeNotification.instances[0]!.closed).toBe(true);
    expect(os.retainedCount()).toBe(0);
  });

  it('handle.close() releases even when the OS never emits close', () => {
    const os = setup();
    const handle = os.show({ title: 'T', body: 'B', onClick: () => {} });
    const n = FakeNotification.instances[0]!;
    n.close = () => { n.closed = true; };
    handle.close();
    expect(os.retainedCount()).toBe(0);
  });

  it('a throwing onClick is logged, not propagated, and still releases', () => {
    const error = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const os = setup();
    os.show({ title: 'T', body: 'B', onClick: () => { throw new Error('nav failed'); } });
    expect(() => FakeNotification.instances[0]!.emit('click')).not.toThrow();
    expect(os.retainedCount()).toBe(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps separate notifications independently', () => {
    const os = setup();
    os.show({ title: 'A', body: 'a', onClick: () => {} });
    os.show({ title: 'B', body: 'b', onClick: () => {} });
    FakeNotification.instances[0]!.emit('click');
    expect(os.retainedCount()).toBe(1);
  });
});
