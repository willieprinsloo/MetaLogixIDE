import { describe, it, expect } from 'vitest';
import { chooseEvictee } from '@main/pty/keep-alive';
import type { ShellRow } from '@shared/types';

function s(projectId: number, lastActiveAt: string, pinned = false): ShellRow {
  return { projectId, shellIndex: 0, model: null, launchArgv: [], startedAt: lastActiveAt, lastActiveAt, pinned };
}

describe('chooseEvictee', () => {
  const now = new Date('2026-07-18T12:00:00Z');

  it('returns ok when under cap', () => {
    expect(chooseEvictee([s(1, '2026-07-18 11:00:00')], 5, 2, now).reason).toBe('ok');
  });

  it('picks LRU when at cap', () => {
    const shells = [s(1, '2026-07-18 11:00:00'), s(2, '2026-07-18 11:30:00'), s(3, '2026-07-18 11:55:00')];
    const r = chooseEvictee(shells, 3, 4, now);
    expect(r.reason).toBe('lru');
    expect(r.evictee?.projectId).toBe(1);
  });

  it('marks LRU as busy if activity within 60s', () => {
    // shells sorted by last_active_at: proj 2 is older → LRU is 2, not busy → 'lru'.
    // Now flip: proj 1 is older — both busy.
    const shells2 = [s(1, '2026-07-18 11:59:30'), s(2, '2026-07-18 11:59:45')];
    const r = chooseEvictee(shells2, 2, 3, now);
    expect(r.reason).toBe('lru-busy'); // both busy; oldest still LRU but busy
  });

  it('never evicts the just-spawned project', () => {
    const shells = [s(4, '2026-07-18 11:00:00'), s(5, '2026-07-18 11:30:00')];
    const r = chooseEvictee(shells, 2, 4, now);
    expect(r.evictee?.projectId).not.toBe(4);
  });

  it('returns all-pinned when every candidate is pinned', () => {
    const shells = [s(1, '2026-07-18 11:00:00', true), s(2, '2026-07-18 11:30:00', true)];
    const r = chooseEvictee(shells, 2, 3, now);
    expect(r.reason).toBe('all-pinned');
    expect(r.evictee).toBeNull();
  });

  describe('group-chat protection', () => {
    const shells = [s(1, '2026-07-18 11:00:00'), s(2, '2026-07-18 11:30:00'), s(3, '2026-07-18 11:55:00')];
    const protect = (ids: number[]) => (sh: { projectId: number }) => ids.includes(sh.projectId);

    it('skips a protected shell and evicts the next oldest', () => {
      const r = chooseEvictee(shells, 3, 4, now, protect([1]));
      expect(r.evictee?.projectId).toBe(2);
      expect(r.reason).toBe('lru');
    });

    it('returns all-protected (not all-pinned) when only protected shells are candidates', () => {
      const r = chooseEvictee(shells, 3, 4, now, protect([1, 2, 3]));
      expect(r.reason).toBe('all-protected');
      expect(r.evictee).toBeNull();
    });

    it('still returns all-pinned when nothing could be evicted anyway', () => {
      const pinned = [s(1, '2026-07-18 11:00:00', true), s(2, '2026-07-18 11:30:00', true)];
      expect(chooseEvictee(pinned, 2, 3, now, protect([1])).reason).toBe('all-pinned');
    });
  });
});
