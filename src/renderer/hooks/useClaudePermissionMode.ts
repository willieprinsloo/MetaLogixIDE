import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { isClaudePermissionMode, type ClaudePermissionMode } from '@shared/claude-permission-mode';

export type PermissionModeStatus = 'loading' | 'unchosen' | 'chosen';

const KEY = 'claude_permission_mode';

function errorText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

/**
 * Persisted Claude permission mode. Loads `claude_permission_mode` via
 * `settings:get`, re-reads it on `settings:changed` for that key, and exposes
 * `status` (`loading` until the first read resolves, then `unchosen`/`chosen`),
 * the current `mode`, `choose(mode)` which persists through
 * `settings:set-claude-permission-mode`, and `error` holding the last load or
 * choose failure as a display string (a failed load is treated as unchosen so
 * the user can still pick a mode).
 */
export function useClaudePermissionMode(): {
  status: PermissionModeStatus;
  mode: ClaudePermissionMode | null;
  choose: (mode: ClaudePermissionMode) => Promise<void>;
  error: string | null;
} {
  const [status, setStatus] = useState<PermissionModeStatus>('loading');
  const [mode, setMode] = useState<ClaudePermissionMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((value: unknown) => {
    const next = isClaudePermissionMode(value) ? value : null;
    setMode(next);
    setStatus(next ? 'chosen' : 'unchosen');
  }, []);

  const load = useCallback(async () => {
    try {
      const { value } = await api.invoke('settings:get', { key: KEY });
      apply(value);
    } catch (e) {
      console.error('permission mode load failed', e);
      setError(errorText(e));
      setStatus((s) => (s === 'loading' ? 'unchosen' : s));
    }
  }, [apply]);

  useEffect(() => {
    void load();
    const off = api.on('settings:changed', ({ key }) => {
      if (key === KEY) void load();
    });
    return () => { off(); };
  }, [load]);

  const choose = useCallback(async (next: ClaudePermissionMode) => {
    setError(null);
    try {
      const res = await api.invoke('settings:set-claude-permission-mode', { mode: next });
      apply(res.mode);
    } catch (e) {
      console.error('permission mode choose failed', e);
      setError(errorText(e));
    }
  }, [apply]);

  return { status, mode, choose, error };
}
