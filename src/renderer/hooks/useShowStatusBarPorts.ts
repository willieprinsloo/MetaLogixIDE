import { useEffect, useState } from 'react';
import { api } from '@renderer/api';

const KEY = 'show_status_bar_ports';

/** Whether the status bar shows port chips: reads `show_status_bar_ports` (default true when unset or unreadable) and follows `settings:changed` for that key. */
export function useShowStatusBarPorts(): boolean {
  const [show, setShow] = useState(true);

  useEffect(() => {
    let live = true;
    const load = () => {
      api.invoke('settings:get', { key: KEY })
        .then(({ value }) => { if (live) setShow(value !== false); })
        .catch(() => { if (live) setShow(true); });
    };
    load();
    const off = api.on('settings:changed', ({ key }) => { if (key === KEY) load(); });
    return () => { live = false; off(); };
  }, []);

  return show;
}
