/**
 * Keep-awake state machine over injected ports. It owns the invariants: one
 * power assertion, deadline range, one 1 s wall-clock tick while active,
 * a darken scheduled after each start, and expiry with a single notification.
 */
import {
  KEEP_AWAKE_COPY,
  KEEP_AWAKE_DARKEN_DELAY_MS,
  KEEP_AWAKE_MAX_MS,
  type KeepAwakeState,
} from '@shared/keep-awake-contract';
import type { Darken } from './darken';
import type { KeepAwakeController } from './port';
import type { PowerAssertion } from './power-assertion';

/** Timer functions, injectable for tests. */
export interface KeepAwakeTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Collaborators of the keep-awake service. */
export interface KeepAwakeDeps {
  assertion: PowerAssertion;
  darken: Darken;
  notify(title: string, body: string): void;
  now(): number;
  timers: KeepAwakeTimers;
  onChange(state: KeepAwakeState): void;
  onDarkenFailed(): void;
}

const TICK_MS = 1000;
const INACTIVE: KeepAwakeState = { active: false };

interface DarkenScheduler {
  schedule(): void;
  cancel(): void;
  run(): void;
}

/** Owns the single pending darken timer; `run` reports a failed darken only while `isActive()` holds. */
function createDarkenScheduler(deps: KeepAwakeDeps, isActive: () => boolean): DarkenScheduler {
  let timer: unknown = null;

  const cancel = (): void => {
    if (timer === null) return;
    deps.timers.clearTimeout(timer);
    timer = null;
  };

  const run = (): void => {
    void deps.darken().then((result) => {
      if (!result.ok && isActive()) deps.onDarkenFailed();
    });
  };

  const schedule = (): void => {
    cancel();
    timer = deps.timers.setTimeout(() => {
      timer = null;
      run();
    }, KEEP_AWAKE_DARKEN_DELAY_MS);
  };

  return { schedule, cancel, run };
}

/** Creates the controller; all timers and the assertion are released by `stop`, expiry or `dispose`. */
export function createKeepAwakeService(deps: KeepAwakeDeps): KeepAwakeController {
  let endsAt: number | null = null;
  let tick: unknown = null;
  const darkening = createDarkenScheduler(deps, () => endsAt !== null);

  const state = (): KeepAwakeState => (endsAt === null ? INACTIVE : { active: true, endsAt });

  const teardown = (): void => {
    darkening.cancel();
    if (tick !== null) deps.timers.clearInterval(tick);
    tick = null;
    endsAt = null;
    deps.assertion.release();
  };

  const expire = (): void => {
    teardown();
    deps.onChange(INACTIVE);
    deps.notify(KEEP_AWAKE_COPY.notification.title, KEEP_AWAKE_COPY.notification.body);
  };

  const onTick = (): void => {
    if (endsAt !== null && deps.now() >= endsAt) expire();
  };

  return {
    get: state,
    start(requested) {
      const now = deps.now();
      if (!Number.isFinite(requested) || requested <= now || requested > now + KEEP_AWAKE_MAX_MS)
        return { ok: false, error: 'invalid' };
      endsAt = requested;
      deps.assertion.hold();
      if (tick === null) tick = deps.timers.setInterval(onTick, TICK_MS);
      darkening.schedule();
      deps.onChange(state());
      return { ok: true, state: state() };
    },
    stop() {
      if (endsAt === null) return INACTIVE;
      teardown();
      deps.onChange(INACTIVE);
      return INACTIVE;
    },
    darkenNow() {
      if (endsAt === null) return { ok: false, error: 'inactive' };
      darkening.cancel();
      darkening.run();
      return { ok: true };
    },
    dispose() {
      teardown();
    },
  };
}
