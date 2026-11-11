import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import type { SettingsMap } from '@shared/types';

type BooleanSettingKey = { [K in keyof SettingsMap]: SettingsMap[K] extends boolean ? K : never }[keyof SettingsMap];

/** A boolean setting that defaults to true when unset or unreadable, and follows `settings:changed` for its key. */
export function useBooleanSetting(key: BooleanSettingKey): boolean {
  const [on, setOn] = useState(true);

  useEffect(() => {
    let live = true;
    const load = () => {
      api.invoke('settings:get', { key })
        .then(({ value }) => { if (live) setOn(value !== false); })
        .catch(() => { if (live) setOn(true); });
    };
    load();
    const off = api.on('settings:changed', (e) => { if (e.key === key) load(); });
    return () => { live = false; off(); };
  }, [key]);

  return on;
}

/** Whether the status bar shows port chips (`show_status_bar_ports`). */
export function useShowStatusBarPorts(): boolean {
  return useBooleanSetting('show_status_bar_ports');
}

/** Whether the status bar is shown at all (`show_status_bar`). */
export function useShowStatusBar(): boolean {
  return useBooleanSetting('show_status_bar');
}
