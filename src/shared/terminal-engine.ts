/** Saved desktop viewer preference, not the active engine of a mounted view. */
export type TerminalEngine = 'xterm' | 'ghostty';

export const TERMINAL_ENGINE_KEY = 'terminal_engine';
export const DEFAULT_TERMINAL_ENGINE = 'xterm' satisfies TerminalEngine;

/** Accept only canonical engine IDs. These are not module or file names. */
export function isTerminalEngine(value: unknown): value is TerminalEngine {
  return value === 'xterm' || value === 'ghostty';
}
