/**
 * Decides which IDE instance in the fleet gets an agent notice raised on this machine: the one the
 * user worked in most recently. That is this machine unless a paired machine that asked for notices
 * (an open `notices.subscribe` stream) has reported more recent activity, in which case the notice is
 * sent there and not shown here.
 *
 * "Activity" is real input while the IDE window is focused. Focus alone is not enough: an unattended
 * machine usually still has its IDE window in front.
 */
import type { Notice } from '@shared/p2p-contract';

/**
 * This machine's last moment of use, fed with samples of (is an IDE window focused, how long since
 * the last keyboard or mouse input). Pure: the caller supplies the clock.
 */
export class ActivityTracker {
  private lastActiveAt: number | null = null;

  /** Records one observation. Input while unfocused went to another application and does not count. */
  sample(focused: boolean, systemIdleMs: number, now: number): void {
    if (!focused || !Number.isFinite(systemIdleMs) || systemIdleMs < 0) return;
    const at = now - systemIdleMs;
    if (this.lastActiveAt === null || at > this.lastActiveAt) this.lastActiveAt = at;
  }

  /** Milliseconds since the IDE here was last used, or null if it never was in this run. */
  idleMs(now: number): number | null {
    return this.lastActiveAt === null ? null : Math.max(0, now - this.lastActiveAt);
  }
}

type Waiter = (r: IteratorResult<Notice>) => void;

/** One paired machine's link, as the router sees it. */
export interface NoticePeer {
  /** The peer's own report of how long ago its IDE was used; null when it never was. */
  setIdle(idleMs: number | null): void;
  /** A `notices.subscribe` stream. The peer is only eligible while at least one is open. */
  stream(): AsyncIterable<Notice>;
  /** Ends every stream of this link and forgets it. */
  dispose(): void;
}

interface PeerState {
  lastActiveAt: number | null;
  /** Open streams; each holds its undelivered notices and a parked reader, if any. */
  streams: Set<{ queue: Notice[]; waiter: Waiter | null; done: boolean }>;
}

/** Undelivered notices kept per stream; beyond it the oldest is dropped (a wedged link must not grow memory). */
const MAX_QUEUED = 32;
/** A peer's report cannot claim activity in the future or absurdly long ago. */
const MAX_IDLE_MS = 365 * 24 * 60 * 60 * 1000;

export class NoticeRouter {
  private readonly peers = new Set<PeerState>();

  constructor(private readonly deps: { localIdleMs(): number | null; now(): number }) {}

  /** Registers a link to a paired machine. Nothing is sent to it until it opens a stream and reports activity. */
  register(): NoticePeer {
    const state: PeerState = { lastActiveAt: null, streams: new Set() };
    this.peers.add(state);
    const end = (s: { queue: Notice[]; waiter: Waiter | null; done: boolean }): void => {
      if (s.done) return;
      s.done = true;
      state.streams.delete(s);
      const w = s.waiter;
      s.waiter = null;
      w?.({ value: undefined, done: true });
    };
    return {
      setIdle: (idleMs) => {
        state.lastActiveAt = idleMs === null || !Number.isFinite(idleMs) || idleMs < 0 || idleMs > MAX_IDLE_MS ? null : this.deps.now() - idleMs;
      },
      stream: () => {
        const s = { queue: [] as Notice[], waiter: null as Waiter | null, done: false };
        state.streams.add(s);
        // Hand-rolled (not a generator) so return() ends it at once even while next() is parked.
        const it: AsyncIterator<Notice> = {
          next: () => {
            if (s.done) return Promise.resolve({ value: undefined, done: true });
            const queued = s.queue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            return new Promise((resolve) => { s.waiter = resolve; });
          },
          return: () => { end(s); return Promise.resolve({ value: undefined, done: true }); },
        };
        return { [Symbol.asyncIterator]: () => it };
      },
      dispose: () => {
        for (const s of [...state.streams]) end(s);
        this.peers.delete(state);
      },
    };
  }

  /**
   * Sends `notice` to the paired machine used more recently than this one, if there is one.
   * Returns true when a peer took it, so the caller must not also notify here.
   */
  route(notice: Notice): boolean {
    let best: PeerState | null = null;
    for (const p of this.peers) {
      if (p.streams.size === 0 || p.lastActiveAt === null) continue;
      if (!best || p.lastActiveAt > best.lastActiveAt!) best = p;
    }
    if (!best) return false;
    const localIdle = this.deps.localIdleMs();
    const localAt = localIdle === null ? -Infinity : this.deps.now() - localIdle;
    // A tie stays here: this machine raised the notice and needs no link to show it.
    if (best.lastActiveAt! <= localAt) return false;
    for (const s of best.streams) {
      if (s.waiter) { const w = s.waiter; s.waiter = null; w({ value: notice, done: false }); }
      else { s.queue.push(notice); if (s.queue.length > MAX_QUEUED) s.queue.shift(); }
    }
    return true;
  }
}
