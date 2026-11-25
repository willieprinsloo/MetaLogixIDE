import { useEffect } from 'react';
import { api } from '@renderer/api';
import { applyRootFlags, type RootFlagTarget } from '@renderer/root-flags';
import {
  FROSTED_GLASS_DEFAULTS,
  FROSTED_GLASS_KEYS,
  isChromeFrostLevel,
  isTerminalFrostMode,
  isTerminalFrostOpacity,
  TERMINAL_FROST_OPACITY_KEY,
} from '@shared/frosted-glass';

const WATCHED_KEYS: readonly string[] = [
  FROSTED_GLASS_KEYS.frostChrome,
  FROSTED_GLASS_KEYS.chromeFrostLevel,
  FROSTED_GLASS_KEYS.terminalFrostLevel,
  TERMINAL_FROST_OPACITY_KEY,
];

/**
 * Keeps the root's frosted-glass attributes in sync with settings in every window.
 * Re-reads on mount (covers a stale first-paint query string after a crash reload) and
 * again on every `settings:changed` for one of them, applying the result through
 * `applyRootFlags`. Defaults to `document.documentElement`, resolved inside the effect so a
 * render without a DOM never touches `document`; tests inject a fake target.
 */
export function useFrostedGlassAttributes(target?: RootFlagTarget): void {
  useEffect(() => {
    const el = target ?? document.documentElement;
    let loadVersion = 0;
    async function load(): Promise<void> {
      const version = ++loadVersion;
      try {
        const [chrome, chromeLevel, terminalLevel] = await Promise.all([
          api.invoke('settings:get', { key: FROSTED_GLASS_KEYS.frostChrome }),
          api.invoke('settings:get', { key: FROSTED_GLASS_KEYS.chromeFrostLevel }),
          api.invoke('settings:get', { key: FROSTED_GLASS_KEYS.terminalFrostLevel }),
        ]);
        const opacity = terminalLevel.value === 'custom'
          ? (await api.invoke('settings:get', { key: TERMINAL_FROST_OPACITY_KEY })).value
          : undefined;
        if (version !== loadVersion) return;
        applyRootFlags(el, {
          platform: api.platform,
          frostChrome: Boolean(chrome.value),
          chromeFrost: isChromeFrostLevel(chromeLevel.value) ? chromeLevel.value : FROSTED_GLASS_DEFAULTS.chromeFrostLevel,
          terminalFrost: isTerminalFrostMode(terminalLevel.value)
            ? terminalLevel.value
            : FROSTED_GLASS_DEFAULTS.terminalFrostLevel,
          terminalOpacity: isTerminalFrostOpacity(opacity) ? opacity : undefined,
        });
      } catch (e) {
        console.error('frosted glass settings load failed', e);
      }
    }
    void load();
    const off = api.on('settings:changed', ({ key }) => {
      if (WATCHED_KEYS.includes(key)) void load();
    });
    return () => { loadVersion++; off(); };
  }, [target]);
}
