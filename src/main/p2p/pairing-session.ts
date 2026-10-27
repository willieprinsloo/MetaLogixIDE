import { createHash, timingSafeEqual } from 'node:crypto';
import { ENROLLMENT_TTL_MS, enrollmentPrologue, generateEnrollmentCode, normalizeEnrollmentCode } from './pairing';

export type PairingError = 'no_active_code' | 'code_expired' | 'code_consumed' | 'attempts_exceeded' | 'wrong_code' | 'busy';

export const DEFAULT_MAX_PAIRING_ATTEMPTS = 5;

export interface PairingSessionOpts {
  /** Wrong attempts tolerated before the code is locked out (default 5). */
  maxAttempts?: number;
  now?: () => number;
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Host-side enrollment code state machine.
 *
 *   generate() -> active --(successful redemption)--> consumed
 *                        --(TTL elapses)-------------> expired
 *                        --(maxAttempts wrong)-------> locked (attempts_exceeded)
 *
 * A code is single-use: after one success every later attempt, right or wrong, reports
 * `code_consumed`. Once the attempt budget is spent even the correct code is refused. Comparison is
 * constant-time (equal-length SHA-256 digests through timingSafeEqual).
 *
 * Two entry points share the same budget:
 *  - `redeem(candidate)`: the candidate code is presented in the clear (in-process check).
 *  - `begin()` / `settle(ok)`: the Noise path. The code is never sent; the host runs the handshake with
 *    the code as prologue and a wrong code surfaces as a failed handshake, which `settle(false)` counts.
 *    Only one handshake may be in flight, so concurrent guesses cannot bypass the budget.
 */
export class PairingSession {
  readonly #max: number;
  readonly #now: () => number;
  #code: string | null = null; // normalized
  #digest: Buffer | null = null;
  #expiresAt = 0;
  #attempts = 0;
  #consumed = false;
  #inFlight = false;

  constructor(opts: PairingSessionOpts = {}) {
    this.#max = opts.maxAttempts ?? DEFAULT_MAX_PAIRING_ATTEMPTS;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Issues a fresh code, replacing (and resetting the state of) any previous one. */
  generate(): { code: string; expiresAt: number } {
    const g = generateEnrollmentCode(this.#now());
    this.#code = normalizeEnrollmentCode(g.code);
    this.#digest = sha(this.#code);
    this.#expiresAt = this.#now() + ENROLLMENT_TTL_MS;
    this.#attempts = 0;
    this.#consumed = false;
    this.#inFlight = false;
    return { code: g.code, expiresAt: this.#expiresAt };
  }

  get active(): boolean {
    return this.#state() === null;
  }

  #state(): PairingError | null {
    if (!this.#code) return 'no_active_code';
    if (this.#consumed) return 'code_consumed';
    if (this.#attempts >= this.#max) return 'attempts_exceeded';
    if (this.#now() >= this.#expiresAt) return 'code_expired';
    return null;
  }

  #fail(): void {
    this.#attempts++;
  }

  /** Clear-text check. Success consumes the code. */
  redeem(candidate: string): { ok: true } | { ok: false; error: PairingError } {
    const st = this.#state();
    if (st) return { ok: false, error: st };
    const match = timingSafeEqual(sha(normalizeEnrollmentCode(String(candidate))), this.#digest!);
    if (!match) {
      this.#fail();
      return { ok: false, error: 'wrong_code' };
    }
    this.#consumed = true;
    return { ok: true };
  }

  /** Noise path: reserves the single in-flight slot and returns the prologue bytes to handshake with. */
  begin(): { ok: true; prologue: Uint8Array } | { ok: false; error: PairingError } {
    const st = this.#state();
    if (st) return { ok: false, error: st };
    if (this.#inFlight) return { ok: false, error: 'busy' };
    this.#inFlight = true;
    return { ok: true, prologue: enrollmentPrologue(this.#code!) };
  }

  /** Reports the handshake outcome for the slot reserved by `begin()`. */
  settle(success: boolean): void {
    if (!this.#inFlight) return;
    this.#inFlight = false;
    if (success) this.#consumed = true;
    else this.#fail();
  }

  /** Test/diagnostic view. */
  get attempts(): number {
    return this.#attempts;
  }
}
