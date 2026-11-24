import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';

/**
 * Tracks native fullscreen state for the current window, and exposes a
 * toggle. Updates when the user changes fullscreen via the IPC OR the OS
 * shortcut (Ctrl+Cmd+F on mac, F11 on Windows/Linux) OR the green traffic
 * light — all three route through the main-side `enter/leave-full-screen`
 * listener wired in `wireFullscreenEvents`.
 *
 * Multiple windows (main + popouts) each run this hook; the broadcast
 * payload carries `windowId`, but the renderer has no reliable way to know
 * its own window.id, so we assume every window the broadcast reaches is one
 * of ours and let React state de-dupe. This is correct because the event is
 * only emitted for windows we created.
 */
export function useWindowFullscreen(): [boolean, () => void] {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const off = api.on('window:fullscreen-changed', (ev) => setFullscreen(ev.fullscreen));
    return () => { off(); };
  }, []);
  const toggle = useCallback(() => {
    void api.invoke('window:toggle-fullscreen', undefined as never).then((r) => setFullscreen(r.fullscreen));
  }, []);
  return [fullscreen, toggle];
}
