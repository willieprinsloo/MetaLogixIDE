import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { ENV_COPY } from '@renderer/project-env-copy';

const KEY = 'app_env' as const;

function errorText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

export type AppEnvLoad = 'loading' | 'ready' | 'failed';

export interface AppEnvState {
  stored: Record<string, string>;
  load: AppEnvLoad;
  setStored: (env: Record<string, string>) => void;
}

/** Saved app-wide map via settings:get, re-read on settings:changed { key: 'app_env' }; a load failure toasts ENV_COPY.loadFailed. */
export function useAppEnv(): AppEnvState {
  const [stored, setStored] = useState<Record<string, string>>({});
  const [load, setLoad] = useState<AppEnvLoad>('loading');

  const refresh = useCallback(async () => {
    try {
      const { value } = await api.invoke('settings:get', { key: KEY });
      setStored((value as Record<string, string> | undefined) ?? {});
      setLoad('ready');
    } catch (e) {
      console.error('app env load failed', e);
      toast(ENV_COPY.loadFailed, { kind: 'error', detail: errorText(e) });
      setLoad('failed');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = api.on('settings:changed', ({ key }) => {
      if (key === KEY) void refresh();
    });
    return () => { off(); };
  }, [refresh]);

  return { stored, load, setStored };
}

/** Validated save via settings:set-app-env; resolves the stored map, rejects with main's key-only message. */
export function saveAppEnv(env: Record<string, string>): Promise<Record<string, string>> {
  return api.invoke('settings:set-app-env', { env }).then((res) => res.env);
}
