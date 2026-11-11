import { describe, it, expect, vi } from 'vitest';
import {
  FROSTED_GLASS_FALLBACK,
  applyVibrancy,
  platformChrome,
  readStoredFrostedGlass,
  rendererQuery,
  resolveMaterial,
} from '@main/window-chrome';

describe('resolveMaterial (AC18)', () => {
  it.each(['sidebar', 'under-window', 'hud', 'menu', 'popover'] as const)('passes through the approved material %s', (material) => {
    expect(resolveMaterial(material)).toBe(material);
  });

  it.each(['window', '', 'content', undefined, null, 42])('falls back to sidebar for %j', (material) => {
    expect(resolveMaterial(material)).toBe('sidebar');
  });
});

describe('platformChrome (AC19, AC20, AC26)', () => {
  it('darwin: carries the resolved material as vibrancy, every other baseline option unchanged', () => {
    expect(platformChrome('darwin', 'hud')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 14 },
      vibrancy: 'hud',
      visualEffectState: 'followWindow',
      roundedCorners: true,
    });
  });

  it('darwin: an unknown stored material falls back to sidebar', () => {
    expect(platformChrome('darwin', 'window').vibrancy).toBe('sidebar');
  });

  it.each(['sidebar', 'hud', 'window', undefined] as const)('linux: transparent window, no vibrancy, for material %j (AC1, AC5)', (material) => {
    const chrome = platformChrome('linux', material);
    expect(chrome).toEqual({ autoHideMenuBar: true, transparent: true, backgroundColor: '#00000000' });
    expect(chrome).not.toHaveProperty('vibrancy');
  });

  it('win32: deep-equals the baseline, unchanged by material (AC3)', () => {
    expect(platformChrome('win32', 'hud')).toEqual({ autoHideMenuBar: true });
  });
});

describe('applyVibrancy (AC19, AC20)', () => {
  function fakeWindow(destroyed: boolean) {
    return { isDestroyed: () => destroyed, setVibrancy: vi.fn() };
  }

  it('darwin: calls setVibrancy once with the resolved material on every non-destroyed window', () => {
    const live1 = fakeWindow(false);
    const live2 = fakeWindow(false);
    applyVibrancy([live1, live2], 'menu', 'darwin');
    expect(live1.setVibrancy).toHaveBeenCalledTimes(1);
    expect(live1.setVibrancy).toHaveBeenCalledWith('menu');
    expect(live2.setVibrancy).toHaveBeenCalledTimes(1);
    expect(live2.setVibrancy).toHaveBeenCalledWith('menu');
  });

  it('darwin: skips a destroyed window', () => {
    const destroyed = fakeWindow(true);
    applyVibrancy([destroyed], 'menu', 'darwin');
    expect(destroyed.setVibrancy).not.toHaveBeenCalled();
  });

  it('darwin: resolves an unknown material to sidebar before calling setVibrancy', () => {
    const live = fakeWindow(false);
    applyVibrancy([live], 'window', 'darwin');
    expect(live.setVibrancy).toHaveBeenCalledWith('sidebar');
  });

  it.each(['win32', 'linux'] as const)('%s: never calls setVibrancy', (platform) => {
    const live = fakeWindow(false);
    applyVibrancy([live], 'menu', platform);
    expect(live.setVibrancy).not.toHaveBeenCalled();
  });
});

describe('rendererQuery (AC5, AC6)', () => {
  it('darwin: encodes frostChrome, chromeFrost and terminalFrost', () => {
    expect(rendererQuery({ platform: 'darwin', frostChrome: true, chromeFrost: 'medium', terminalFrost: 'subtle' }))
      .toBe('frostChrome=1&chromeFrost=medium&terminalFrost=subtle');
  });

  it('darwin: frostChrome off still encodes the chosen levels', () => {
    expect(rendererQuery({ platform: 'darwin', frostChrome: false, chromeFrost: 'subtle', terminalFrost: 'off' }))
      .toBe('frostChrome=0&chromeFrost=subtle&terminalFrost=off');
  });

  it.each(['win32', 'freebsd'] as const)('%s: always resolves to the no-effect defaults (AC3, AC4)', (platform) => {
    expect(rendererQuery({ platform, frostChrome: true, chromeFrost: 'strong', terminalFrost: 'strong' }))
      .toBe('frostChrome=0&chromeFrost=subtle&terminalFrost=off');
  });

  it('linux: passes stored values through, on/strong/medium (AC1)', () => {
    expect(rendererQuery({ platform: 'linux', frostChrome: true, chromeFrost: 'strong', terminalFrost: 'medium' }))
      .toBe('frostChrome=1&chromeFrost=strong&terminalFrost=medium');
  });

  it('linux: passes stored values through, off/medium/strong (AC1)', () => {
    expect(rendererQuery({ platform: 'linux', frostChrome: false, chromeFrost: 'medium', terminalFrost: 'strong' }))
      .toBe('frostChrome=0&chromeFrost=medium&terminalFrost=strong');
  });

  it('popout params come first, ahead of the frosted-glass flags', () => {
    expect(rendererQuery({ popout: { projectId: 3, shellIndex: 1 }, platform: 'darwin', frostChrome: true, chromeFrost: 'medium', terminalFrost: 'subtle' }))
      .toBe('popout=1&projectId=3&shellIndex=1&frostChrome=1&chromeFrost=medium&terminalFrost=subtle');
  });

  it('never sends the legacy frostTerminal key (AC34, D19)', () => {
    expect(rendererQuery({ platform: 'darwin', frostChrome: true, chromeFrost: 'subtle', terminalFrost: 'subtle' })).not.toContain('frostTerminal');
  });
});

describe('readStoredFrostedGlass (gate L5: stored values validated before the query string)', () => {
  const store = (values: Record<string, unknown>) => (key: string) => values[key];
  const VALID = { frost_chrome: false, chrome_frost_level: 'strong', terminal_frost_level: 'medium', vibrancy_material: 'hud' };

  it('passes approved stored values through, keyed by the settings keys', () => {
    expect(readStoredFrostedGlass(store(VALID))).toEqual({
      frostChrome: false,
      chromeFrost: 'strong',
      terminalFrost: 'medium',
      vibrancyMaterial: 'hud',
    });
  });

  it.each([
    ['frost_chrome', 'false', 'frostChrome'],
    ['chrome_frost_level', 'off', 'chromeFrost'],
    ['chrome_frost_level', 'x&popout=1', 'chromeFrost'],
    ['terminal_frost_level', 'extreme', 'terminalFrost'],
    ['terminal_frost_level', 3, 'terminalFrost'],
    ['vibrancy_material', 'window', 'vibrancyMaterial'],
  ] as const)('a tampered %s of %j falls back to its own default only', (key, bad, field) => {
    const got = readStoredFrostedGlass(store({ ...VALID, [key]: bad }));
    expect(got).toEqual({ ...readStoredFrostedGlass(store(VALID)), [field]: FROSTED_GLASS_FALLBACK[field] });
  });

  it('a tampered level never reaches the renderer query string', () => {
    const read = readStoredFrostedGlass(store({ ...VALID, chrome_frost_level: 'x&popout=1' }));
    expect(rendererQuery({ ...read, platform: 'darwin' })).not.toContain('popout');
  });

  it('a read that throws falls back to every default', () => {
    expect(readStoredFrostedGlass(() => { throw new Error('db closed'); })).toEqual(FROSTED_GLASS_FALLBACK);
  });
});
