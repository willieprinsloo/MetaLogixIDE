import { describe, it, expect } from 'vitest';
import { applyRootFlags, parseFrostQuery, type RootFlagTarget } from '@renderer/root-flags';
import { FROST_ATTR } from '@renderer/frosted-chrome-contract';
import { FROSTED_GLASS_DEFAULTS, FROSTED_GLASS_QUERY_KEYS } from '@shared/frosted-glass';

function fakeTarget(): RootFlagTarget & { set: Record<string, string>; removed: string[] } {
  const set: Record<string, string> = {};
  const removed: string[] = [];
  return {
    set,
    removed,
    setAttribute(name: string, value: string): void { set[name] = value; },
    removeAttribute(name: string): void { removed.push(name); Reflect.deleteProperty(set, name); },
  };
}

const ON = { platform: 'darwin', frostChrome: true, chromeFrost: 'medium', terminalFrost: 'medium' } as const;

const FROST_PLATFORMS = [
  ['darwin', 'mac'],
  ['linux', 'linux'],
] as const;
const NO_FROST_PLATFORMS = ['win32', 'freebsd', '', undefined];
const FROST_ATTRS = [FROST_ATTR.platform, FROST_ATTR.chromeFrost, FROST_ATTR.terminalFrost];
const ALL_ATTRS = [...FROST_ATTRS, FROST_ATTR.transparentWindow];
const LINUX_WINDOW = { [FROST_ATTR.transparentWindow]: '' };

describe('applyRootFlags — platform', () => {
  it.each(FROST_PLATFORMS)('sets data-platform to the frost platform on %s with frost chrome on', (platform, value) => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform });
    expect(el.set[FROST_ATTR.platform]).toBe(value);
  });

  it.each(NO_FROST_PLATFORMS)('never sets any frost attribute for platform %j, whatever is stored', (platform) => {
    const el = fakeTarget();
    applyRootFlags(el, { platform, frostChrome: true, chromeFrost: 'strong', terminalFrost: 'strong' });
    expect(el.set).toEqual({});
    expect([...el.removed].sort()).toEqual([...ALL_ATTRS].sort());
  });

  it.each(FROST_PLATFORMS)('removes every frost attribute on %s when frost chrome is off', (platform) => {
    const el = fakeTarget();
    applyRootFlags(el, { platform, frostChrome: false, chromeFrost: 'strong', terminalFrost: 'strong' });
    for (const attr of FROST_ATTRS) expect(el.set[attr], attr).toBeUndefined();
    expect(el.removed).toEqual(expect.arrayContaining(FROST_ATTRS));
  });

  it('switches a live root from linux on to off and back, leaving no stale attribute', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform: 'linux' });
    applyRootFlags(el, { ...ON, platform: 'linux', frostChrome: false });
    expect(el.set).toEqual(LINUX_WINDOW);
    applyRootFlags(el, { ...ON, platform: 'linux', chromeFrost: 'subtle', terminalFrost: 'off' });
    expect(el.set).toEqual({ [FROST_ATTR.platform]: 'linux', ...LINUX_WINDOW });
  });
});

describe('applyRootFlags — transparent window (linux AC7)', () => {
  it.each([true, false])('marks the linux root as a transparent window with frost chrome %s', (frostChrome) => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform: 'linux', frostChrome });
    expect(el.set[FROST_ATTR.transparentWindow]).toBe('');
  });

  it.each([true, false])('never marks a darwin root, with frost chrome %s', (frostChrome) => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, frostChrome });
    expect(el.set[FROST_ATTR.transparentWindow]).toBeUndefined();
    expect(el.removed).toContain(FROST_ATTR.transparentWindow);
  });

  it('linux with frost chrome off sets only the transparent-window marker', () => {
    const el = fakeTarget();
    applyRootFlags(el, { platform: 'linux', frostChrome: false, chromeFrost: 'strong', terminalFrost: 'strong' });
    expect(el.set).toEqual(LINUX_WINDOW);
  });
});

describe('applyRootFlags — linux sets the same level attributes as darwin', () => {
  it.each([
    ['subtle', 'off'],
    ['medium', 'subtle'],
    ['strong', 'medium'],
    ['medium', 'strong'],
  ] as const)('chrome %s, terminal %s', (chromeFrost, terminalFrost) => {
    const mac = fakeTarget();
    const linux = fakeTarget();
    applyRootFlags(mac, { ...ON, chromeFrost, terminalFrost });
    applyRootFlags(linux, { ...ON, platform: 'linux', chromeFrost, terminalFrost });
    expect(linux.set).toEqual({ ...mac.set, [FROST_ATTR.platform]: 'linux', ...LINUX_WINDOW });
    expect([...linux.removed, FROST_ATTR.transparentWindow].sort()).toEqual([...mac.removed].sort());
  });
});

describe('applyRootFlags — chrome frost level', () => {
  it('sets data-chrome-frost="medium" when ON at medium', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, chromeFrost: 'medium' });
    expect(el.set[FROST_ATTR.chromeFrost]).toBe('medium');
  });

  it('sets data-chrome-frost="strong" when ON at strong', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, chromeFrost: 'strong' });
    expect(el.set[FROST_ATTR.chromeFrost]).toBe('strong');
  });

  it('omits data-chrome-frost at subtle', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, chromeFrost: 'subtle' });
    expect(el.set[FROST_ATTR.chromeFrost]).toBeUndefined();
    expect(el.removed).toContain(FROST_ATTR.chromeFrost);
  });

  it('removes data-chrome-frost when frost chrome is off', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, frostChrome: false, chromeFrost: 'strong' });
    expect(el.set[FROST_ATTR.chromeFrost]).toBeUndefined();
    expect(el.removed).toContain(FROST_ATTR.chromeFrost);
  });

  it('sets data-chrome-frost="strong" on linux when ON at strong', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform: 'linux', chromeFrost: 'strong' });
    expect(el.set[FROST_ATTR.chromeFrost]).toBe('strong');
  });
});

describe('applyRootFlags — terminal frost level', () => {
  it.each(['subtle', 'medium', 'strong'] as const)('sets data-terminal-frost="%s" when ON', (level) => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, terminalFrost: level });
    expect(el.set[FROST_ATTR.terminalFrost]).toBe(level);
  });

  it('omits data-terminal-frost when off', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, terminalFrost: 'off' });
    expect(el.set[FROST_ATTR.terminalFrost]).toBeUndefined();
    expect(el.removed).toContain(FROST_ATTR.terminalFrost);
  });

  it('removes data-terminal-frost when frost chrome is off, whatever the stored terminal level', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, frostChrome: false, terminalFrost: 'strong' });
    expect(el.set[FROST_ATTR.terminalFrost]).toBeUndefined();
    expect(el.removed).toContain(FROST_ATTR.terminalFrost);
  });

  it('sets data-terminal-frost="strong" on linux when ON at strong', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform: 'linux', terminalFrost: 'strong' });
    expect(el.set[FROST_ATTR.terminalFrost]).toBe('strong');
  });
});

describe('parseFrostQuery', () => {
  it('parses an explicit on query with explicit levels', () => {
    const flags = parseFrostQuery('?frostChrome=1&chromeFrost=strong&terminalFrost=medium');
    expect(flags).toEqual({ frostChrome: true, chromeFrost: 'strong', terminalFrost: 'medium' });
  });

  it('parses an explicit off query', () => {
    const flags = parseFrostQuery('?frostChrome=0&chromeFrost=medium&terminalFrost=off');
    expect(flags).toEqual({ frostChrome: false, chromeFrost: 'medium', terminalFrost: 'off' });
  });

  it('falls back to the shared defaults when the query is empty', () => {
    expect(parseFrostQuery('')).toEqual({
      frostChrome: FROSTED_GLASS_DEFAULTS.frostChrome,
      chromeFrost: FROSTED_GLASS_DEFAULTS.chromeFrostLevel,
      terminalFrost: FROSTED_GLASS_DEFAULTS.terminalFrostLevel,
    });
  });

  it('maps an unknown chromeFrost value to the default level', () => {
    const flags = parseFrostQuery('?frostChrome=1&chromeFrost=ultra&terminalFrost=off');
    expect(flags.chromeFrost).toBe(FROSTED_GLASS_DEFAULTS.chromeFrostLevel);
  });

  it('maps an unknown terminalFrost value to the default level', () => {
    const flags = parseFrostQuery('?frostChrome=1&chromeFrost=subtle&terminalFrost=ultra');
    expect(flags.terminalFrost).toBe(FROSTED_GLASS_DEFAULTS.terminalFrostLevel);
  });

  it('maps an unknown frostChrome value to the default flag, and "0" to off', () => {
    expect(parseFrostQuery('?frostChrome=true&chromeFrost=subtle&terminalFrost=off').frostChrome).toBe(
      FROSTED_GLASS_DEFAULTS.frostChrome,
    );
    expect(parseFrostQuery('?frostChrome=0&chromeFrost=subtle&terminalFrost=off').frostChrome).toBe(false);
  });

  it('reads the keys from FROSTED_GLASS_QUERY_KEYS alongside other query params', () => {
    const search = `?projectId=5&${FROSTED_GLASS_QUERY_KEYS.frostChrome}=1&${FROSTED_GLASS_QUERY_KEYS.chromeFrost}=medium&${FROSTED_GLASS_QUERY_KEYS.terminalFrost}=subtle&shellIndex=0`;
    expect(parseFrostQuery(search)).toEqual({ frostChrome: true, chromeFrost: 'medium', terminalFrost: 'subtle' });
  });
});
