import { useCallback, useEffect, useRef, useState } from 'react';
import { KEEP_AWAKE_COPY, type KeepAwakeState } from '@shared/keep-awake-contract';
import { api } from '@renderer/api';
import { keepAwakeSupported } from '@renderer/keep-awake-time';
import { toast } from './useToasts';

export interface KeepAwakeControls {
  readonly state: KeepAwakeState;
  /** Starts a keep-awake lasting `ms` from now. */
  readonly start: (ms: number) => Promise<void>;
  /** Starts a keep-awake ending at the absolute epoch-ms deadline. */
  readonly startUntil: (endsAt: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly darkenNow: () => Promise<void>;
}

const INACTIVE: KeepAwakeState = { active: false };

/**
 * Renderer view of the main-process keep-awake: reads the state once at mount, follows
 * `keep-awake:changed`, raises one warning toast per `keep-awake:darken-failed` and an error toast when a
 * start fails. A `changed` event that lands before the first read resolves wins over that read.
 * Returns null off macOS and never calls IPC there, so callers render no keep-awake UI.
 */
export function useKeepAwake(): KeepAwakeControls | null {
  const supported = keepAwakeSupported(api.platform);
  const [state, setState] = useState<KeepAwakeState>(INACTIVE);
  const pushed = useRef(false);

  useEffect(() => {
    if (!supported) return;
    const offChanged = api.on('keep-awake:changed', (next) => { pushed.current = true; setState(next); });
    const offFailed = api.on('keep-awake:darken-failed', () => {
      toast(KEEP_AWAKE_COPY.toast.darkenFailed, { kind: 'warning', detail: KEEP_AWAKE_COPY.toast.darkenFailedDetail });
    });
    void api.invoke('keep-awake:get', undefined).then((initial) => {
      if (!pushed.current) setState(initial);
    }).catch(() => {});
    return () => { offChanged(); offFailed(); };
  }, [supported]);

  const startUntil = useCallback(async (endsAt: number) => {
    try {
      const result = await api.invoke('keep-awake:start', { endsAt });
      if (result.ok) setState(result.state);
      else toast(KEEP_AWAKE_COPY.toast.startFailed, { kind: 'error' });
    } catch {
      toast(KEEP_AWAKE_COPY.toast.startFailed, { kind: 'error' });
    }
  }, []);

  const start = useCallback((ms: number) => startUntil(Date.now() + ms), [startUntil]);

  const stop = useCallback(async () => {
    setState(await api.invoke('keep-awake:stop', undefined));
  }, []);

  const darkenNow = useCallback(async () => {
    await api.invoke('keep-awake:darken', undefined);
  }, []);

  return supported ? { state, start, startUntil, stop, darkenNow } : null;
}
