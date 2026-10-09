/** Tests the xterm option pair built from the terminal weights: normal and bold passed through unchanged, as numbers (AC4, AC5). */
import { describe, expect, it } from 'vitest';
import { terminalFontWeightOptions } from '@renderer/terminal-font-weight-apply';

describe('terminalFontWeightOptions', () => {
  it.each([
    [400, 700],
    [500, 900],
    [100, 300],
    [900, 900],
  ] as const)('passes weight %i and bold %i straight through', (weight, boldWeight) => {
    expect(terminalFontWeightOptions({ weight, boldWeight })).toEqual({ fontWeight: weight, fontWeightBold: boldWeight });
  });
});
