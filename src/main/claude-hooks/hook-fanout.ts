/**
 * Fans the hook receiver's single listener out to several consumers. Its one
 * production consumer is the Claude-state tracker (the notifier reads the
 * tracker's applied hooks); it stays as the seam that isolates consumers and
 * lets another one subscribe later. Registers exactly one listener on
 * the receiver, so its single-listener, reply-before-dispatch contract is
 * unchanged, and isolates consumers: a throw or rejection in one is logged
 * with its cause and never stops the others.
 */
import type { HookListener, ReceivedHook } from './receiver';

/** Anything that accepts one hook listener, such as `ClaudeHookReceiver`. */
export interface HookSource {
  onHook(listener: HookListener): void;
}

function logFailure(hook: ReceivedHook, err: unknown): void {
  console.error('[claude-hooks] hook listener failed', { event: hook.event.hookEventName, cause: err });
}

function deliver(listener: HookListener, hook: ReceivedHook): void {
  try {
    Promise.resolve(listener(hook)).catch((err: unknown) => logFailure(hook, err));
  } catch (err) {
    logFailure(hook, err);
  }
}

/** Registers one listener on `source` and returns a source that delivers each hook to every added listener, in order. */
export function createHookFanout(source: HookSource): HookSource {
  const listeners: HookListener[] = [];
  source.onHook((hook) => {
    for (const listener of listeners) deliver(listener, hook);
  });
  return { onHook: (listener) => { listeners.push(listener); } };
}
