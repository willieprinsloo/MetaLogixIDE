/**
 * Scrollback lines kept by every terminal: the live xterm in a shell tab and the headless mirror in
 * main that a remounting tab is rebuilt from. They must match, or a tab switch drops history.
 */
export const TERMINAL_SCROLLBACK_LINES = 10_000;
