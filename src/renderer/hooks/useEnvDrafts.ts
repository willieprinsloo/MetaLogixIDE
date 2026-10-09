import { useCallback, useMemo, useState } from 'react';
import { isDraftDirty, type EnvRow } from '@renderer/project-env-rows';

/** Draft key for the app-wide (Settings → Environment) editor; project drafts are keyed by project id. */
export const APP_ENV_DRAFT_KEY = 'app' as const;
export type EnvDraftKey = number | typeof APP_ENV_DRAFT_KEY;

/** Unsaved edits for one draft key (a project's Env tab or the app-wide editor), with the stored map they are compared against. */
export interface EnvDraft {
  stored: Record<string, string>;
  rows: EnvRow[];
}

export interface EnvDrafts {
  get: (key: EnvDraftKey) => EnvDraft | undefined;
  set: (key: EnvDraftKey, draft: EnvDraft) => void;
  clear: (key: EnvDraftKey) => void;
  isDirty: (key: EnvDraftKey) => boolean;
}

/**
 * Per-project Env tab drafts and the app-wide draft (`APP_ENV_DRAFT_KEY`), held in memory only: they survive switching
 * tabs or projects and are gone on app close. Save and Discard call `clear`;
 * `isDirty` drives the tab's unsaved marker via the pure `isDraftDirty`.
 */
export function useEnvDrafts(): EnvDrafts {
  const [drafts, setDrafts] = useState<ReadonlyMap<EnvDraftKey, EnvDraft>>(() => new Map());

  const set = useCallback((key: EnvDraftKey, draft: EnvDraft) => {
    setDrafts((prev) => new Map(prev).set(key, draft));
  }, []);

  const clear = useCallback((key: EnvDraftKey) => {
    setDrafts((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      get: (key: EnvDraftKey) => drafts.get(key),
      set,
      clear,
      isDirty: (key: EnvDraftKey) => {
        const draft = drafts.get(key);
        return draft !== undefined && isDraftDirty(draft.rows, draft.stored);
      },
    }),
    [drafts, set, clear],
  );
}
