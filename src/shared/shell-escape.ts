/**
 * Ghostty-style shell escaping for dropped and pasted file paths (AC3, AC3a, AC4, AC5). POSIX
 * paths get a backslash before each character in Ghostty's macOS set; Windows paths are wrapped
 * in double quotes when they contain a space or one of `&()^;,=`. Every C0 control character,
 * DEL and C1 control (U+0080-U+009F) inside a path, including CR, LF and TAB, becomes a space
 * before escaping, so a crafted file
 * name can never submit a command even when bracketed paste is off.
 */
import type { EscapePathFn, JoinEscapedPathsFn, PathStyleForFn } from './terminal-drop-contract';

const PATH_CONTROL = /[^\x20-\x7e\xa0-\uffff]/g;
const POSIX_SPECIAL = /[\\ ()[\]{}<>"'`!#$&;|*?]/g;
const WINDOWS_NEEDS_QUOTES = /[ &()^;,=]/;

/** Maps a Node `process.platform` value to the escaping style its shells expect. */
export const pathStyleFor: PathStyleForFn = (platform) =>
  platform === 'win32' ? 'windows' : 'posix';

/** Escapes one absolute path for insertion into a shell of the given style. */
export const escapePath: EscapePathFn = (path, style) => {
  const safe = path.replace(PATH_CONTROL, ' ');
  if (style === 'windows') return WINDOWS_NEEDS_QUOTES.test(safe) ? `"${safe}"` : safe;
  return safe.replace(POSIX_SPECIAL, '\\$&');
};

/** Escapes each path and joins them with single spaces; an empty list yields `''`. */
export const joinEscapedPaths: JoinEscapedPathsFn = (paths, style) =>
  paths.map((path) => escapePath(path, style)).join(' ');
