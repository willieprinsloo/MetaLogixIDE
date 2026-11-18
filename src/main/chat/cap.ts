/**
 * Reply cap + per-shell rate limit. The gate the injector consults
 * before delivering an entry into a PTY.
 *
 * Reply cap: an agent may post at most `CHAT_REPLY_CAP` consecutive
 * messages in one thread without an intervening human post. After the
 * cap trips, further agent messages in that thread are queued (ids
 * drained via `release(threadRoot)`) and the UI badges the thread.
 * A human post in the same thread resets the counter.
 *
 * Rate limit: a single shell cannot post more than `CHAT_RATE_MAX`
 * messages per `CHAT_RATE_WINDOW_MS`. Over-rate messages are rejected
 * outright (not queued) — a runaway agent is backpressured, not funneled.
 */
import type { ChatEntry } from '@shared/chat';
import { CHAT_RATE_MAX, CHAT_RATE_WINDOW_MS, CHAT_REPLY_CAP } from '@shared/chat';

export type CapVerdict = 'pass' | 'cap' | 'rate';

export interface ReplyCap {
  admit(entry: ChatEntry): CapVerdict;
  /** Empties a thread's queued ids and returns them in insertion order. */
  release(threadRoot: string): string[];
}

export function createReplyCap(now: () => number = Date.now): ReplyCap {
  const consecutive = new Map<string, number>();      // threadRoot → agent reply count since last human
  const queue = new Map<string, string[]>();          // threadRoot → queued entry ids
  const windowTs = new Map<string, number[]>();       // shellKey → recent send timestamps

  return {
    admit(entry) {
      const threadRoot = entry.reply_in ?? entry.id;
      if (entry.from.agent === 'human') {
        // Human post: clear the consecutive counter for the thread. The
        // queue is preserved so a later `release` call can replay it.
        consecutive.set(threadRoot, 0);
        return 'pass';
      }
      // Rate limit first — a rate-limited message never even counts
      // against the reply cap.
      const shellKey = `${entry.from.device}#${entry.from.shell}`;
      const t = now();
      const recent = (windowTs.get(shellKey) ?? []).filter((x) => t - x < CHAT_RATE_WINDOW_MS);
      if (recent.length >= CHAT_RATE_MAX) {
        windowTs.set(shellKey, recent);
        return 'rate';
      }
      // Cap check.
      const count = consecutive.get(threadRoot) ?? 0;
      if (count >= CHAT_REPLY_CAP) {
        const q = queue.get(threadRoot) ?? [];
        q.push(entry.id);
        queue.set(threadRoot, q);
        return 'cap';
      }
      // Admit.
      consecutive.set(threadRoot, count + 1);
      recent.push(t);
      windowTs.set(shellKey, recent);
      return 'pass';
    },

    release(threadRoot) {
      const ids = queue.get(threadRoot) ?? [];
      queue.delete(threadRoot);
      consecutive.set(threadRoot, 0);
      return ids;
    },
  };
}
