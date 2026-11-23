/** Saved desktop viewer preference, not the active engine of a mounted view. */
export type TerminalEngine = 'xterm' | 'ghostty';

export const TERMINAL_ENGINE_KEY = 'terminal_engine';
export const DEFAULT_TERMINAL_ENGINE = 'xterm' satisfies TerminalEngine;
export const GHOSTTY_HOST_ATTRIBUTE = 'data-terminal-engine-host';
export const GHOSTTY_HOST_SELECTOR = `[${GHOSTTY_HOST_ATTRIBUTE}="ghostty"]`;

/** Accept only canonical engine IDs. These are not module or file names. */
export function isTerminalEngine(value: unknown): value is TerminalEngine {
  return value === 'xterm' || value === 'ghostty';
}
