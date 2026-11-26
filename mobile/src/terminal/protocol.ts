/** The contract between the terminal page (xterm.js in a WebView) and React Native. Both sides compile against it. */

/** Messages the page posts to React Native. */
export type PageMessage =
  | { t: 'ready' }
  /** Bytes the user typed, or a key from the key bar, to send to the shell. */
  | { t: 'in'; d: string }
  | { t: 'size'; cols: number; rows: number }
  /** The sticky Ctrl key was used up by a keystroke. */
  | { t: 'ctrl'; on: boolean };

/** Named keys the key bar can send. The page turns them into the right escape sequence for the terminal's mode. */
export type KeyName =
  | 'esc' | 'tab' | 'enter' | 'ctrl-c' | 'ctrl-d' | 'shift-tab'
  | 'home' | 'end' | 'pgup' | 'pgdn'
  | 'up' | 'down' | 'left' | 'right';

/** What React Native calls on the page, as `window.__term`. */
export interface TerminalApi {
  write(text: string): void;
  reset(): void;
  focus(): void;
  blur(): void;
  refit(): void;
  setCtrl(on: boolean): void;
  setFontSize(px: number): void;
  key(name: KeyName): void;
  paste(text: string): void;
}
