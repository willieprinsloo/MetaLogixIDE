import { describe, it, expect } from 'vitest';
import { createReplyCap } from '@main/chat/cap';
import type { ChatEntry } from '@shared/chat';

type Partial2<T> = { [K in keyof T]?: T[K] };

interface MkOpts {
  id?: string;
  agent?: string;
  shell?: number;
  device?: string;
  reply_in?: string;
}
const mk = (p: MkOpts): ChatEntry => ({
  id: p.id ?? 'x',
  ts: '',
  from: { device: p.device ?? 'd', shell: p.shell ?? 1, agent: p.agent ?? 'claude' },
  to: [],
  body: '',
  ...(p.reply_in !== undefined ? { reply_in: p.reply_in } : {}),
}) as Partial2<ChatEntry> as ChatEntry;

describe('createReplyCap', () => {
  it('admits human messages without counting', () => {
    const cap = createReplyCap();
    for (let i = 0; i < 10; i++) {
      expect(cap.admit(mk({ id: `h${i}`, agent: 'human', reply_in: 'root' }))).toBe('pass');
    }
  });

  it('caps at CHAT_REPLY_CAP agent replies in one thread', () => {
    // 5 replies from 5 different shells so the per-shell rate limiter
    // doesn't interfere — the cap is thread-scoped.
    const cap = createReplyCap();
    for (let i = 0; i < 5; i++) {
      expect(cap.admit(mk({ id: `a${i}`, agent: 'claude', shell: i, reply_in: 'root' }))).toBe('pass');
    }
    expect(cap.admit(mk({ id: 'a5', agent: 'claude', shell: 99, reply_in: 'root' }))).toBe('cap');
  });

  it('human reset: a human post releases the cap', () => {
    const cap = createReplyCap();
    for (let i = 0; i < 5; i++) {
      cap.admit(mk({ id: `a${i}`, agent: 'claude', shell: i, reply_in: 'root' }));
    }
    cap.admit(mk({ id: 'h', agent: 'human', reply_in: 'root' }));
    expect(cap.admit(mk({ id: 'a6', agent: 'claude', shell: 42, reply_in: 'root' }))).toBe('pass');
  });

  it('rate-limits 3 agent msgs/sec from one shell', () => {
    let t = 1000;
    const cap = createReplyCap(() => t);
    expect(cap.admit(mk({ id: 'r1', agent: 'claude', reply_in: 'x' }))).toBe('pass');
    expect(cap.admit(mk({ id: 'r2', agent: 'claude', reply_in: 'x' }))).toBe('pass');
    expect(cap.admit(mk({ id: 'r3', agent: 'claude', reply_in: 'x' }))).toBe('pass');
    expect(cap.admit(mk({ id: 'r4', agent: 'claude', reply_in: 'x' }))).toBe('rate');
    t = 2001;
    expect(cap.admit(mk({ id: 'r5', agent: 'claude', reply_in: 'x' }))).toBe('pass');
  });

  it('a human post also returns any queued ids so the injector can drain them', () => {
    // Regression: release() exists but nothing called it; after the
    // human_reset the queue stayed behind, so cap-held messages were
    // stranded. Now admit() returns a `drained` id list on the human
    // path so the injector can replay them in order.
    const cap = createReplyCap();
    for (let i = 0; i < 5; i++) cap.admit(mk({ id: `a${i}`, agent: 'claude', shell: i, reply_in: 'root' }));
    cap.admit(mk({ id: 'q1', agent: 'claude', shell: 10, reply_in: 'root' }));
    cap.admit(mk({ id: 'q2', agent: 'claude', shell: 11, reply_in: 'root' }));
    const drained = cap.admitWithRelease(mk({ id: 'h', agent: 'human', reply_in: 'root' }));
    expect(drained).toEqual({ verdict: 'pass', released: ['q1', 'q2'] });
  });

  it('release returns queued ids and clears them', () => {
    const cap = createReplyCap();
    for (let i = 0; i < 5; i++) {
      cap.admit(mk({ id: `a${i}`, agent: 'claude', shell: i, reply_in: 'root' }));
    }
    cap.admit(mk({ id: 'q1', agent: 'claude', shell: 10, reply_in: 'root' }));
    cap.admit(mk({ id: 'q2', agent: 'claude', shell: 11, reply_in: 'root' }));
    expect(cap.release('root')).toEqual(['q1', 'q2']);
    expect(cap.release('root')).toEqual([]);
  });
});
