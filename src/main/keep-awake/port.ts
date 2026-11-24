import type {
  KeepAwakeDarkenResult,
  KeepAwakeStartResult,
  KeepAwakeState,
} from '@shared/keep-awake-contract';

/** Main-process keep-awake controller; `Services.keepAwake` is null off darwin. */
export interface KeepAwakeController {
  get(): KeepAwakeState;
  /** Starts, or moves the deadline of, the single keep-awake. Validates `now < endsAt ≤ now + 24 h`. */
  start(endsAt: number): KeepAwakeStartResult;
  /** Releases the assertion and cancels any pending darken; posts no notification. */
  stop(): KeepAwakeState;
  /** Runs the darken action now; only while active. */
  darkenNow(): KeepAwakeDarkenResult;
  /** Releases everything and clears all timers; called on before-quit. */
  dispose(): void;
}
