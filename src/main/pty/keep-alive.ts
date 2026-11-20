import type { ShellRow } from '@shared/types';

/**
 * `all-pinned`: every candidate is pinned, so the caller refuses the spawn.
 * `all-protected`: the only candidates are protected (Claude tabs in a running
 * group chat), so nothing is evicted and the spawn goes ahead above the cap
 * until the conversation ends (group-chats spec §7.5).
 */
export type EvictReason = 'ok' | 'lru' | 'lru-busy' | 'all-pinned' | 'all-protected';

export interface EvictionDecision {
  evictee: { projectId: number; shellIndex: number } | null;
  reason: EvictReason;
}

function toMs(iso: string): number {
  // stored as 'YYYY-MM-DD HH:mm:ss' UTC
  return new Date(iso.replace(' ', 'T') + 'Z').getTime();
}

export function chooseEvictee(
  shells: ShellRow[],
  cap: number,
  justSpawnedProjectId: number,
  now: Date,
  isProtected: (s: { projectId: number; shellIndex: number }) => boolean = () => false,
): EvictionDecision {
  if (shells.length < cap) return { evictee: null, reason: 'ok' };
  const unpinned = shells.filter(s => !s.pinned && s.projectId !== justSpawnedProjectId);
  if (unpinned.length === 0) return { evictee: null, reason: 'all-pinned' };
  const candidates = unpinned
    .filter(s => !isProtected(s))
    .sort((a, b) => toMs(a.lastActiveAt) - toMs(b.lastActiveAt));
  if (candidates.length === 0) return { evictee: null, reason: 'all-protected' };
  const oldest = candidates[0]!;
  const ageMs = now.getTime() - toMs(oldest.lastActiveAt);
  const reason: EvictReason = ageMs < 60_000 ? 'lru-busy' : 'lru';
  return { evictee: { projectId: oldest.projectId, shellIndex: oldest.shellIndex }, reason };
}
