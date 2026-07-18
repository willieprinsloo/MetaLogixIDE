import type { ShellRow } from '@shared/types';

export type EvictReason = 'ok' | 'lru' | 'lru-busy' | 'all-pinned';

export interface EvictionDecision {
  evictee: { projectId: number; shellIndex: number } | null;
  reason: EvictReason;
}

function toMs(iso: string): number {
  // stored as 'YYYY-MM-DD HH:mm:ss' UTC
  return new Date(iso.replace(' ', 'T') + 'Z').getTime();
}

export function chooseEvictee(shells: ShellRow[], cap: number, justSpawnedProjectId: number, now: Date): EvictionDecision {
  if (shells.length < cap) return { evictee: null, reason: 'ok' };
  const candidates = shells
    .filter(s => !s.pinned && s.projectId !== justSpawnedProjectId)
    .sort((a, b) => toMs(a.lastActiveAt) - toMs(b.lastActiveAt));
  if (candidates.length === 0) return { evictee: null, reason: 'all-pinned' };
  const oldest = candidates[0]!;
  const ageMs = now.getTime() - toMs(oldest.lastActiveAt);
  const reason: EvictReason = ageMs < 60_000 ? 'lru-busy' : 'lru';
  return { evictee: { projectId: oldest.projectId, shellIndex: oldest.shellIndex }, reason };
}
