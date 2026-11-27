/**
 * Minimal rate limiter for feedback reports.
 *
 * Keyed by source so a misbehaving agent in a tight loop can't drown
 * out a user who wants to file one bug. Per-source cap is small —
 * reports are meant to be rare; a well-behaved agent files one or two
 * a day. In-memory only; a restart resets the budget, which is fine
 * (worst case is a few extra reports, not a security concern).
 */

export interface RateLimitKey {
  readonly kind: 'user' | 'agent';
  readonly agent?: string;
}

export interface RateLimitDecision {
  readonly ok: boolean;
  /** Milliseconds to wait before the key is allowed again; 0 when
   *  `ok`. The dialog uses this to say "try again in 2 min". */
  readonly retryAfterMs: number;
}

export interface RateLimitOptions {
  /** Maximum reports allowed within `windowMs` for a single key. */
  readonly max: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Clock injector for tests. */
  readonly now?: () => number;
}

const USER_LIMIT: RateLimitOptions = { max: 5, windowMs: 10 * 60 * 1000 };
const AGENT_LIMIT: RateLimitOptions = { max: 3, windowMs: 10 * 60 * 1000 };

export function limitFor(key: RateLimitKey): RateLimitOptions {
  return key.kind === 'agent' ? AGENT_LIMIT : USER_LIMIT;
}

export function createRateLimiter(now: () => number = Date.now) {
  const timestamps = new Map<string, number[]>();

  function keyString(key: RateLimitKey): string {
    return key.kind === 'agent' ? `agent:${key.agent ?? '?'}` : 'user';
  }

  return {
    check(key: RateLimitKey): RateLimitDecision {
      const opts = limitFor(key);
      const k = keyString(key);
      const list = (timestamps.get(k) ?? []).filter((ts) => now() - ts < opts.windowMs);
      if (list.length >= opts.max) {
        const oldest = list[0] ?? now();
        return { ok: false, retryAfterMs: Math.max(0, opts.windowMs - (now() - oldest)) };
      }
      timestamps.set(k, list);
      return { ok: true, retryAfterMs: 0 };
    },
    record(key: RateLimitKey): void {
      const k = keyString(key);
      const list = timestamps.get(k) ?? [];
      list.push(now());
      timestamps.set(k, list);
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
