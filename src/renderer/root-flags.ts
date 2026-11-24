import { FROST_ATTR } from './frosted-chrome-contract';
import {
  FROSTED_GLASS_DEFAULTS,
  FROSTED_GLASS_QUERY_KEYS,
  isChromeFrostLevel,
  isTerminalFrostLevel,
  toFrostPlatform,
  type FrostFlags,
} from '@shared/frosted-glass';

export interface RootFlagTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface RootFlags extends FrostFlags {
  platform: string | undefined;
}

function setOrRemove(el: RootFlagTarget, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

/**
 * Sets the root attributes the frosted-chrome CSS keys on. A frost platform (darwin or linux, via
 * `toFrostPlatform`) with Frosted chrome ON sets `data-platform` to the `FrostPlatform` (`mac` or
 * `linux`), `data-chrome-frost` (omitted at subtle) and `data-terminal-frost` (omitted when off).
 * Every other case (win32, an unknown platform, or Frosted chrome OFF) removes all three, so
 * Frosted chrome OFF is the oracle's BASE state by construction. `data-transparent-window` is set
 * on linux whatever Frosted chrome says, because Linux windows are always transparent, and removed
 * everywhere else.
 */
export function applyRootFlags(el: RootFlagTarget, flags: RootFlags): void {
  const platform = toFrostPlatform(flags.platform);
  const frost = flags.frostChrome ? platform : null;
  setOrRemove(el, FROST_ATTR.transparentWindow, platform === 'linux' ? '' : null);
  setOrRemove(el, FROST_ATTR.platform, frost);
  setOrRemove(el, FROST_ATTR.chromeFrost, frost && flags.chromeFrost !== 'subtle' ? flags.chromeFrost : null);
  setOrRemove(el, FROST_ATTR.terminalFrost, frost && flags.terminalFrost !== 'off' ? flags.terminalFrost : null);
}

function parseFrostChrome(raw: string | null): boolean {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return FROSTED_GLASS_DEFAULTS.frostChrome;
}

/** Reads the first-paint frosted-glass flags from a `location.search` string. Unknown or missing values map to the shared defaults. */
export function parseFrostQuery(search: string): FrostFlags {
  const params = new URLSearchParams(search);
  const chromeFrostRaw = params.get(FROSTED_GLASS_QUERY_KEYS.chromeFrost);
  const terminalFrostRaw = params.get(FROSTED_GLASS_QUERY_KEYS.terminalFrost);
  return {
    frostChrome: parseFrostChrome(params.get(FROSTED_GLASS_QUERY_KEYS.frostChrome)),
    chromeFrost: isChromeFrostLevel(chromeFrostRaw) ? chromeFrostRaw : FROSTED_GLASS_DEFAULTS.chromeFrostLevel,
    terminalFrost: isTerminalFrostLevel(terminalFrostRaw) ? terminalFrostRaw : FROSTED_GLASS_DEFAULTS.terminalFrostLevel,
  };
}
