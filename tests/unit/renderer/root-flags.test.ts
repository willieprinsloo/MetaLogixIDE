import { describe, it, expect } from 'vitest';
import { applyRootFlags, parseFrostQuery, type RootFlagTarget } from '@renderer/root-flags';
import { FROST_ATTR, MAC_PLATFORM } from '@renderer/frosted-chrome-contract';
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

describe('applyRootFlags — platform', () => {
  it('sets data-platform="mac" on darwin with frost chrome on', () => {
    const el = fakeTarget();
    applyRootFlags(el, ON);
    expect(el.set[FROST_ATTR.platform]).toBe(MAC_PLATFORM);
  });

  it.each(['win32', 'linux', undefined])('never sets data-platform for platform %s', (platform) => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform });
    expect(el.set[FROST_ATTR.platform]).toBeUndefined();
    expect(el.removed).toContain(FROST_ATTR.platform);
  });

  it('removes data-platform on darwin when frost chrome is off', () => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, frostChrome: false });
    expect(el.set[FROST_ATTR.platform]).toBeUndefined();
    expect(el.removed).toContain(FROST_ATTR.platform);
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

  it.each(['win32', 'linux', undefined])('never sets data-chrome-frost for platform %s', (platform) => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform, chromeFrost: 'strong' });
    expect(el.set[FROST_ATTR.chromeFrost]).toBeUndefined();
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

  it.each(['win32', 'linux', undefined])('never sets data-terminal-frost for platform %s', (platform) => {
    const el = fakeTarget();
    applyRootFlags(el, { ...ON, platform, terminalFrost: 'strong' });
    expect(el.set[FROST_ATTR.terminalFrost]).toBeUndefined();
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
