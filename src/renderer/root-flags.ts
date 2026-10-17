import { FROST_ATTR, MAC_PLATFORM } from './frosted-chrome-contract';
import {
  FROSTED_GLASS_DEFAULTS,
  FROSTED_GLASS_QUERY_KEYS,
  isChromeFrostLevel,
  isTerminalFrostLevel,
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
 * Sets the root attributes the macOS frosted-chrome CSS keys on. Darwin with Frosted chrome ON
 * sets `data-platform="mac"`, `data-chrome-frost` (omitted at subtle) and `data-terminal-frost`
 * (omitted when off). Every other case (off darwin, or Frosted chrome OFF) removes all three, so
 * Frosted chrome OFF is the oracle's BASE state by construction.
 */
export function applyRootFlags(el: RootFlagTarget, flags: RootFlags): void {
  const active = flags.platform === 'darwin' && flags.frostChrome;
  setOrRemove(el, FROST_ATTR.platform, active ? MAC_PLATFORM : null);
  setOrRemove(el, FROST_ATTR.chromeFrost, active && flags.chromeFrost !== 'subtle' ? flags.chromeFrost : null);
  setOrRemove(el, FROST_ATTR.terminalFrost, active && flags.terminalFrost !== 'off' ? flags.terminalFrost : null);
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
