import { useCallback, useEffect, useState } from 'react';
import { USAGE_POLL_MS, type UsageSnapshot } from '@shared/usage-contract';
import { api } from '@renderer/api';

/** Polls Claude/Codex subscription usage every USAGE_POLL_MS; `refresh(true)` bypasses main's cache. */
export function useAgentUsage(): { usage: UsageSnapshot | null; loading: boolean; refresh: (force?: boolean) => void } {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback((force = false) => {
    setLoading(true);
    api
      .invoke('usage:get', { force })
      .then(setUsage)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(), USAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { usage, loading, refresh };
}
