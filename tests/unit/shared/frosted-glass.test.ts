import { describe, it, expect } from 'vitest';
import {
  CHROME_FROST_LEVELS,
  TERMINAL_FROST_LEVELS,
  VIBRANCY_MATERIALS,
  isChromeFrostLevel,
  isTerminalFrostLevel,
  isVibrancyMaterial,
} from '@shared/frosted-glass';

describe('isChromeFrostLevel (AC3)', () => {
  it.each(CHROME_FROST_LEVELS)('%s is a valid level', (level) => {
    expect(isChromeFrostLevel(level)).toBe(true);
  });

  it.each(['off', 'STRONG', 0, 1, null, undefined, {}, []])('rejects %j', (value) => {
    expect(isChromeFrostLevel(value)).toBe(false);
  });
});

describe('isTerminalFrostLevel (AC3)', () => {
  it.each(TERMINAL_FROST_LEVELS)('%s is a valid level', (level) => {
    expect(isTerminalFrostLevel(level)).toBe(true);
  });

  it.each(['SUBTLE', 'none', 0, 1, null, undefined, {}, []])('rejects %j', (value) => {
    expect(isTerminalFrostLevel(value)).toBe(false);
  });
});

describe('isVibrancyMaterial (AC3, AC18)', () => {
  it.each(VIBRANCY_MATERIALS)('%s is a valid material', (material) => {
    expect(isVibrancyMaterial(material)).toBe(true);
  });

  it.each(['window', 'content', 'under-page', 'header', '', 0, 1, null, undefined, {}, []])('rejects %j', (value) => {
    expect(isVibrancyMaterial(value)).toBe(false);
  });
});
