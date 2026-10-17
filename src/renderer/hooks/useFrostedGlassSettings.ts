import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import {
  FROSTED_GLASS_DEFAULTS,
  FROSTED_GLASS_KEYS,
  isChromeFrostLevel,
  isTerminalFrostLevel,
  isVibrancyMaterial,
  type ChromeFrostLevel,
  type TerminalFrostLevel,
  type VibrancyMaterial,
} from '@shared/frosted-glass';

export interface FrostedGlassSettings {
  frostChrome: boolean;
  chromeFrostLevel: ChromeFrostLevel;
  terminalFrostLevel: TerminalFrostLevel;
  vibrancyMaterial: VibrancyMaterial;
}

export interface FrostedGlassSettingsApi {
  values: FrostedGlassSettings;
  setFrostChrome: (enabled: boolean) => Promise<void>;
  setChromeFrostLevel: (level: ChromeFrostLevel) => Promise<void>;
  setTerminalFrostLevel: (level: TerminalFrostLevel) => Promise<void>;
  setVibrancyMaterial: (material: VibrancyMaterial) => Promise<void>;
}

const INITIAL: FrostedGlassSettings = {
  frostChrome: FROSTED_GLASS_DEFAULTS.frostChrome,
  chromeFrostLevel: FROSTED_GLASS_DEFAULTS.chromeFrostLevel,
  terminalFrostLevel: FROSTED_GLASS_DEFAULTS.terminalFrostLevel,
  vibrancyMaterial: FROSTED_GLASS_DEFAULTS.vibrancyMaterial,
};

async function loadFrostedGlassSettings(): Promise<FrostedGlassSettings> {
  const [chrome, chromeLevel, terminalLevel, material] = await Promise.all([
    api.invoke('settings:get', { key: FROSTED_GLASS_KEYS.frostChrome }),
    api.invoke('settings:get', { key: FROSTED_GLASS_KEYS.chromeFrostLevel }),
    api.invoke('settings:get', { key: FROSTED_GLASS_KEYS.terminalFrostLevel }),
    api.invoke('settings:get', { key: FROSTED_GLASS_KEYS.vibrancyMaterial }),
  ]);
  return {
    frostChrome: chrome.value === null || chrome.value === undefined ? FROSTED_GLASS_DEFAULTS.frostChrome : Boolean(chrome.value),
    chromeFrostLevel: isChromeFrostLevel(chromeLevel.value) ? chromeLevel.value : FROSTED_GLASS_DEFAULTS.chromeFrostLevel,
    terminalFrostLevel: isTerminalFrostLevel(terminalLevel.value)
      ? terminalLevel.value
      : FROSTED_GLASS_DEFAULTS.terminalFrostLevel,
    vibrancyMaterial: isVibrancyMaterial(material.value) ? material.value : FROSTED_GLASS_DEFAULTS.vibrancyMaterial,
  };
}

interface SaveResult {
  ok: boolean;
  error?: string;
}

/**
 * Loads the four frosted-glass settings once on mount and saves each through its dedicated
 * validated channel. A save optimistically applies the new value, then logs the error and reverts
 * to the prior value when the main process refuses it or the IPC call rejects (AC28) — unless a
 * later save has already replaced that value, so a slow failure never undoes a newer choice.
 */
export function useFrostedGlassSettings(): FrostedGlassSettingsApi {
  const [values, setValues] = useState<FrostedGlassSettings>(INITIAL);

  useEffect(() => { void loadFrostedGlassSettings().then(setValues); }, []);

  async function persist<K extends keyof FrostedGlassSettings>(
    key: K,
    prev: FrostedGlassSettings[K],
    next: FrostedGlassSettings[K],
    invoke: () => Promise<SaveResult>,
  ): Promise<void> {
    setValues((v) => ({ ...v, [key]: next }));
    try {
      const res = await invoke();
      if (res.ok) return;
      console.error('frosted glass setting refused', key, res.error);
    } catch (e) {
      console.error('frosted glass setting save failed', key, e);
    }
    setValues((v) => (v[key] === next ? { ...v, [key]: prev } : v));
  }

  return {
    values,
    setFrostChrome: (enabled) =>
      persist('frostChrome', values.frostChrome, enabled, () => api.invoke('settings:set-frost-chrome', { enabled })),
    setChromeFrostLevel: (level) =>
      persist('chromeFrostLevel', values.chromeFrostLevel, level, () =>
        api.invoke('settings:set-chrome-frost-level', { level }),
      ),
    setTerminalFrostLevel: (level) =>
      persist('terminalFrostLevel', values.terminalFrostLevel, level, () =>
        api.invoke('settings:set-terminal-frost-level', { level }),
      ),
    setVibrancyMaterial: (material) =>
      persist('vibrancyMaterial', values.vibrancyMaterial, material, () =>
        api.invoke('settings:set-vibrancy-material', { material }),
      ),
  };
}
