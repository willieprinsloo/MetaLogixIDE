import { useCallback, useMemo, useState } from 'react';
import { isDraftDirty, type EnvRow } from '@renderer/project-env-rows';

/** Unsaved Env tab edits for one project, with the stored map they are compared against. */
export interface EnvDraft {
  stored: Record<string, string>;
  rows: EnvRow[];
}

export interface EnvDrafts {
  get: (projectId: number) => EnvDraft | undefined;
  set: (projectId: number, draft: EnvDraft) => void;
  clear: (projectId: number) => void;
  isDirty: (projectId: number) => boolean;
}

/**
 * Per-project Env tab drafts, held in memory only: they survive switching
 * tabs or projects and are gone on app close. Save and Discard call `clear`;
 * `isDirty` drives the tab's unsaved marker via the pure `isDraftDirty`.
 */
export function useEnvDrafts(): EnvDrafts {
  const [drafts, setDrafts] = useState<ReadonlyMap<number, EnvDraft>>(() => new Map());

  const set = useCallback((projectId: number, draft: EnvDraft) => {
    setDrafts((prev) => new Map(prev).set(projectId, draft));
  }, []);

  const clear = useCallback((projectId: number) => {
    setDrafts((prev) => {
      if (!prev.has(projectId)) return prev;
      const next = new Map(prev);
      next.delete(projectId);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      get: (projectId: number) => drafts.get(projectId),
      set,
      clear,
      isDirty: (projectId: number) => {
        const draft = drafts.get(projectId);
        return draft !== undefined && isDraftDirty(draft.rows, draft.stored);
      },
    }),
    [drafts, set, clear],
  );
}
