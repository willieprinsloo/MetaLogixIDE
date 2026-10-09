import { describe, expect, it } from 'vitest';
import {
  TERMINAL_BOLD_WEIGHT_DEFAULT,
  TERMINAL_BOLD_WEIGHT_KEY,
  TERMINAL_FONT_WEIGHTS,
  TERMINAL_FONT_WEIGHT_DEFAULT,
  TERMINAL_FONT_WEIGHT_KEY,
  boldWeightChoices,
  derivedBoldWeight,
  isValidBoldWeight,
  parseTerminalFontWeight,
  resolveTerminalWeights,
} from '@shared/terminal-font-weight';

describe('terminal font weight contract', () => {
  it('exposes the agreed keys, weights and defaults', () => {
    expect(TERMINAL_FONT_WEIGHT_KEY).toBe('terminal_font_weight');
    expect(TERMINAL_BOLD_WEIGHT_KEY).toBe('terminal_bold_weight');
    expect(TERMINAL_FONT_WEIGHTS).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(TERMINAL_FONT_WEIGHT_DEFAULT).toBe(400);
    expect(TERMINAL_BOLD_WEIGHT_DEFAULT).toBe(700);
  });
});

describe('parseTerminalFontWeight', () => {
  it.each([100, 200, 300, 400, 500, 600, 700, 800, 900])('accepts %j', (value) => {
    expect(parseTerminalFontWeight(value)).toEqual({ ok: true, value });
  });

  it.each([450, 1000, 0, 50, 950, -100, 400.5, NaN, Infinity, 'bold', 'normal', '400', null, undefined, {}, [400]])(
    'rejects %j',
    (value) => {
      const result = parseTerminalFontWeight(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/terminal font weight/);
    },
  );
});

describe('derivedBoldWeight', () => {
  it.each([
    [100, 300],
    [200, 400],
    [300, 500],
    [400, 600],
    [500, 700],
    [600, 800],
    [700, 900],
    [800, 900],
    [900, 900],
  ] as const)('derivedBoldWeight(%j) === %j', (weight, bold) => {
    expect(derivedBoldWeight(weight)).toBe(bold);
  });
});

describe('isValidBoldWeight', () => {
  it.each([
    [400, 500, true],
    [400, 700, true],
    [100, 200, true],
    [800, 900, true],
    [900, 900, true],
    [400, 400, false],
    [500, 400, false],
    [800, 800, false],
    [900, 800, false],
    [100, 100, false],
  ] as const)('isValidBoldWeight(%j, %j) === %j', (weight, bold, valid) => {
    expect(isValidBoldWeight(weight, bold)).toBe(valid);
  });
});

describe('boldWeightChoices', () => {
  it.each([
    [100, [200, 300, 400, 500, 600, 700, 800, 900]],
    [400, [500, 600, 700, 800, 900]],
    [700, [800, 900]],
    [800, [900]],
    [900, [900]],
  ] as const)('boldWeightChoices(%j) lists the heavier weights', (weight, choices) => {
    expect(boldWeightChoices(weight)).toEqual(choices);
  });

  it('every choice is a valid bold weight for every font weight', () => {
    for (const weight of TERMINAL_FONT_WEIGHTS) {
      const choices = boldWeightChoices(weight);
      expect(choices.length).toBeGreaterThan(0);
      for (const bold of choices) expect(isValidBoldWeight(weight, bold)).toBe(true);
      for (const bold of TERMINAL_FONT_WEIGHTS) {
        if (!choices.includes(bold)) expect(isValidBoldWeight(weight, bold)).toBe(false);
      }
    }
  });
});

describe('resolveTerminalWeights', () => {
  it.each([
    // [storedWeight, storedBold, weight, boldWeight, errorCount]
    [null, null, 400, 700, 0],
    [undefined, undefined, 400, 700, 0],
    [null, 500, 400, 500, 0],
    [null, 400, 400, 700, 1],
    [450, 500, 400, 500, 1],
    ['bold', null, 400, 700, 1],
    [800, null, 800, 900, 0],
    [900, null, 900, 900, 0],
    [900, 700, 900, 900, 1],
    [500, 500, 500, 700, 1],
    [500, 'x', 500, 700, 1],
    [300, 900, 300, 900, 0],
    [700, 800, 700, 800, 0],
    [700, 600, 700, 900, 1],
    ['x', 'y', 400, 700, 2],
  ] as const)(
    'resolve(%j, %j) gives %j / %j with %j error(s)',
    (storedWeight, storedBold, weight, boldWeight, errorCount) => {
      const resolved = resolveTerminalWeights(storedWeight, storedBold);
      expect(resolved.weight).toBe(weight);
      expect(resolved.boldWeight).toBe(boldWeight);
      expect(resolved.errors).toHaveLength(errorCount);
      for (const error of resolved.errors) expect(error).toMatch(/terminal (font|bold) weight/);
    },
  );
});
