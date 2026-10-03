import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { createHookFanout } from '@main/claude-hooks/hook-fanout';
import type { HookListener, ReceivedHook } from '@main/claude-hooks/receiver';

const hook = (hookEventName: string): ReceivedHook => ({
  sessionId: 'sess-1',
  shell: { projectId: 1, shellIndex: 0 },
  event: { hookEventName, notificationType: null, message: null, backgroundTaskCount: 0 },
});

function fakeReceiver() {
  let registered: HookListener | null = null;
  const onHook = vi.fn((l: HookListener) => { registered = l; });
  const deliver = (h: ReceivedHook) => registered!(h);
  return { onHook, deliver };
}

const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => vi.restoreAllMocks());

describe('createHookFanout', () => {
  it('registers exactly one listener on the receiver, however many listeners it fans out to', () => {
    const receiver = fakeReceiver();
    const fanout = createHookFanout(receiver);
    fanout.onHook(() => {});
    fanout.onHook(() => {});
    fanout.onHook(() => {});
    expect(receiver.onHook).toHaveBeenCalledTimes(1);
  });

  it('delivers every hook to every listener, in registration order', () => {
    const receiver = fakeReceiver();
    const fanout = createHookFanout(receiver);
    const calls: string[] = [];
    fanout.onHook((h) => { calls.push(`a:${h.event.hookEventName}`); });
    fanout.onHook((h) => { calls.push(`b:${h.event.hookEventName}`); });
    receiver.deliver(hook('Stop'));
    receiver.deliver(hook('PreToolUse'));
    expect(calls).toEqual(['a:Stop', 'b:Stop', 'a:PreToolUse', 'b:PreToolUse']);
  });

  it('passes each listener the received hook unchanged', () => {
    const receiver = fakeReceiver();
    const fanout = createHookFanout(receiver);
    const listener = vi.fn();
    fanout.onHook(listener);
    const h = hook('Notification');
    receiver.deliver(h);
    expect(listener).toHaveBeenCalledWith(h);
  });

  it('a throwing listener is logged with its cause and does not stop the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const receiver = fakeReceiver();
    const fanout = createHookFanout(receiver);
    const boom = new Error('sync boom');
    const before = vi.fn();
    const after = vi.fn();
    fanout.onHook(before);
    fanout.onHook(() => { throw boom; });
    fanout.onHook(after);
    expect(() => receiver.deliver(hook('Stop'))).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[claude-hooks] hook listener failed', { event: 'Stop', cause: boom });
  });

  it('a rejecting listener is logged with its cause and does not stop the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const receiver = fakeReceiver();
    const fanout = createHookFanout(receiver);
    const boom = new Error('async boom');
    const after = vi.fn();
    fanout.onHook(async () => { throw boom; });
    fanout.onHook(after);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await receiver.deliver(hook('PostToolUse'));
      await flush();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(after).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[claude-hooks] hook listener failed', { event: 'PostToolUse', cause: boom });
  });

  it('logs only the event name, never the message or the session id', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const receiver = fakeReceiver();
    const fanout = createHookFanout(receiver);
    fanout.onHook(() => { throw new Error('x'); });
    receiver.deliver({ ...hook('Notification'), sessionId: 'SESSION-SECRET', event: { hookEventName: 'Notification', notificationType: 'permission_prompt', message: 'MESSAGE-SECRET', backgroundTaskCount: 0 } });
    const logged = error.mock.calls.map((c) => inspect(c, { depth: 5 })).join('\n');
    expect(logged).not.toContain('SESSION-SECRET');
    expect(logged).not.toContain('MESSAGE-SECRET');
  });

  it('delivers nothing before a listener is added, and a later listener sees only later hooks', () => {
    const receiver = fakeReceiver();
    const fanout = createHookFanout(receiver);
    receiver.deliver(hook('Stop'));
    const listener = vi.fn();
    fanout.onHook(listener);
    receiver.deliver(hook('UserPromptSubmit'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].event.hookEventName).toBe('UserPromptSubmit');
  });
});
