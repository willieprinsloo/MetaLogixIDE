/** Desktop viewer settings. Null restores the original inset on that axis. */
export const TERMINAL_PADDING_KEYS = {
  horizontal: 'terminal_padding_horizontal',
  vertical: 'terminal_padding_vertical',
} as const;

export type TerminalPaddingAxis = keyof typeof TERMINAL_PADDING_KEYS;
export type TerminalPaddingKey = typeof TERMINAL_PADDING_KEYS[TerminalPaddingAxis];
export type TerminalPaddingValue = number | null;

export const TERMINAL_PADDING_MAX = 32;
export const DEFAULT_TERMINAL_PADDING = { sides: 12, top: 8, bottom: 4 } as const;

/** Identifies the padding settings that require validation at the settings boundary. */
export function isTerminalPaddingKey(key: unknown): key is TerminalPaddingKey {
  return key === TERMINAL_PADDING_KEYS.horizontal || key === TERMINAL_PADDING_KEYS.vertical;
}

/** Accepts whole pixels within the supported range, or the default sentinel. */
export function isTerminalPaddingValue(value: unknown): value is TerminalPaddingValue {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TERMINAL_PADDING_MAX);
}
