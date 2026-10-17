/**
 * Contract for the macOS frosted-glass settings: levels, materials, settings keys, defaults and
 * first-paint query keys, shared by main and the renderer.
 */
export const CHROME_FROST_LEVELS = ['subtle', 'medium', 'strong'] as const;
export type ChromeFrostLevel = (typeof CHROME_FROST_LEVELS)[number];

export const TERMINAL_FROST_LEVELS = ['off', 'subtle', 'medium', 'strong'] as const;
export type TerminalFrostLevel = (typeof TERMINAL_FROST_LEVELS)[number];

/** Approved native vibrancy materials (spec D7), in display order. */
export const VIBRANCY_MATERIALS = ['sidebar', 'under-window', 'hud', 'menu', 'popover'] as const;
export type VibrancyMaterial = (typeof VIBRANCY_MATERIALS)[number];

export const FROSTED_GLASS_KEYS = {
  frostChrome: 'frost_chrome',
  chromeFrostLevel: 'chrome_frost_level',
  terminalFrostLevel: 'terminal_frost_level',
  vibrancyMaterial: 'vibrancy_material',
} as const;

export const FROSTED_GLASS_DEFAULTS = {
  frostChrome: true,
  chromeFrostLevel: 'subtle',
  terminalFrostLevel: 'off',
  vibrancyMaterial: 'sidebar',
} as const satisfies {
  frostChrome: boolean;
  chromeFrostLevel: ChromeFrostLevel;
  terminalFrostLevel: TerminalFrostLevel;
  vibrancyMaterial: VibrancyMaterial;
};

/** Renderer URL query keys carrying the first-paint values. Written by main, read before React renders. */
export const FROSTED_GLASS_QUERY_KEYS = {
  frostChrome: 'frostChrome',
  chromeFrost: 'chromeFrost',
  terminalFrost: 'terminalFrost',
} as const;

/** Values the renderer applies as root flags. */
export interface FrostFlags {
  frostChrome: boolean;
  chromeFrost: ChromeFrostLevel;
  terminalFrost: TerminalFrostLevel;
}

export function isChromeFrostLevel(v: unknown): v is ChromeFrostLevel {
  return (CHROME_FROST_LEVELS as readonly unknown[]).includes(v);
}

export function isTerminalFrostLevel(v: unknown): v is TerminalFrostLevel {
  return (TERMINAL_FROST_LEVELS as readonly unknown[]).includes(v);
}

export function isVibrancyMaterial(v: unknown): v is VibrancyMaterial {
  return (VIBRANCY_MATERIALS as readonly unknown[]).includes(v);
}
