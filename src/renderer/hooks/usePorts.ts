import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';

interface Entry { projectId: number; shellIndex: number; ports: number[] }

/**
 * Subscribes to ports:changed and returns the full picture. Shells that
 * announce ports (dev servers, docker, whatever) are collected from a
 * one-shot snapshot at mount and kept in sync via broadcast events.
 * `projectId` scopes the returned list; pass null to see everything. When `enabled` is false
 * it neither snapshots nor listens and returns an empty list.
 */
export function usePorts(projectId: number | null, enabled = true): number[] {
  const [entries, setEntries] = useState<Entry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { entries } = await api.invoke('shells:ports', undefined as never);
      setEntries(entries);
    } catch { /* main not up yet */ }
  }, []);

  useEffect(() => { if (enabled) void refresh(); }, [refresh, enabled]);
  useEffect(() => {
    if (!enabled) return undefined;
    const off = api.on('ports:changed', (ev) => {
      setEntries((prev) => {
        const key = `${ev.projectId}:${ev.shellIndex}`;
        const rest = prev.filter((e) => `${e.projectId}:${e.shellIndex}` !== key);
        if (ev.ports.length === 0) return rest;
        return [...rest, { projectId: ev.projectId, shellIndex: ev.shellIndex, ports: ev.ports }];
      });
    });
    return () => { off(); };
  }, [enabled]);

  return useMemo(() => {
    if (!enabled) return [];
    if (projectId == null) return Array.from(new Set(entries.flatMap((e) => e.ports))).sort((a, b) => a - b);
    return Array.from(new Set(
      entries.filter((e) => e.projectId === projectId).flatMap((e) => e.ports),
    )).sort((a, b) => a - b);
  }, [entries, projectId, enabled]);
}
