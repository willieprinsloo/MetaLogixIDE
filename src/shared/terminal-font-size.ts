/** Settings key for the integrated-terminal font size. Write via settings:set-terminal-font-size only. */
export const TERMINAL_FONT_SIZE_KEY = 'terminal_font_size' as const;

/** Bounds, step and default for the integrated-terminal font size, in px. */
export const TERMINAL_FONT_SIZE = { min: 9, max: 28, step: 1, default: 14 } as const;

/** localStorage key used before the size moved into the settings store; read only for the one-time migration. */
export const LEGACY_SHELL_FONT_SIZE_STORAGE_KEY = 'metaide.shellFontSize';

export type TerminalFontSizeParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

export type TerminalFontSizeStep = 'in' | 'out' | 'reset';

/** Main-side validator: integer within [min, max]; anything else is rejected. */
export function parseTerminalFontSize(value: unknown): TerminalFontSizeParseResult {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: 'terminal font size must be a whole number' };
  }
  if (value < TERMINAL_FONT_SIZE.min || value > TERMINAL_FONT_SIZE.max) {
    return { ok: false, error: `terminal font size must be between ${TERMINAL_FONT_SIZE.min} and ${TERMINAL_FONT_SIZE.max}` };
  }
  return { ok: true, value };
}

/** Rounds then clamps any finite number into [min, max]. */
export function clampTerminalFontSize(value: number): number {
  const rounded = Math.round(value);
  if (rounded < TERMINAL_FONT_SIZE.min) return TERMINAL_FONT_SIZE.min;
  if (rounded > TERMINAL_FONT_SIZE.max) return TERMINAL_FONT_SIZE.max;
  return rounded;
}

/** Next size for a zoom key; at a bound returns `current` unchanged. */
export function stepTerminalFontSize(current: number, step: TerminalFontSizeStep): number {
  if (step === 'reset') return TERMINAL_FONT_SIZE.default;
  const next = step === 'in' ? current + TERMINAL_FONT_SIZE.step : current - TERMINAL_FONT_SIZE.step;
  return clampTerminalFontSize(next);
}

/** AC10 rule: valid finite legacy text → clampTerminalFontSize(n); otherwise TERMINAL_FONT_SIZE.default. */
export function migratedTerminalFontSize(legacyRaw: string | null): number {
  if (legacyRaw === null || legacyRaw === '') return TERMINAL_FONT_SIZE.default;
  const n = Number(legacyRaw);
  if (!Number.isFinite(n)) return TERMINAL_FONT_SIZE.default;
  return clampTerminalFontSize(n);
}
