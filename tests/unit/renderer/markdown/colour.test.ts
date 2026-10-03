import { describe, expect, it } from 'vitest';
import {
  adjustToContrast,
  composite,
  contrastRatio,
  hslHue,
  parseColour,
  relativeLuminance,
  toHex,
} from '@renderer/markdown/mermaid/colour';

const hex = (value: string) => {
  const parsed = parseColour(value);
  if (!parsed) throw new Error(`test fixture ${value} did not parse`);
  return parsed;
};

describe('parseColour', () => {
  it.each([
    ['#abc', { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 }],
    ['#abcd', { r: 0xaa, g: 0xbb, b: 0xcc, a: 0xdd / 255 }],
    ['#3B82F6', { r: 0x3b, g: 0x82, b: 0xf6, a: 1 }],
    ['#11223380', { r: 0x11, g: 0x22, b: 0x33, a: 0x80 / 255 }],
    ['  #e6edf3 ', { r: 0xe6, g: 0xed, b: 0xf3, a: 1 }],
    ['rgb(1, 2, 3)', { r: 1, g: 2, b: 3, a: 1 }],
    ['rgba(22, 26, 34, 0.55)', { r: 22, g: 26, b: 34, a: 0.55 }],
    ['RGBA(22,26,34,.55)', { r: 22, g: 26, b: 34, a: 0.55 }],
    ['rgb(22 26 34 / 0.62)', { r: 22, g: 26, b: 34, a: 0.62 }],
    ['rgb(22 26 34 / 40%)', { r: 22, g: 26, b: 34, a: 0.4 }],
    ['rgba(0, 0, 0, 0)', { r: 0, g: 0, b: 0, a: 0 }],
  ])('parses %s', (input, expected) => {
    const parsed = parseColour(input);
    expect(parsed).not.toBeNull();
    expect(parsed?.r).toBe(expected.r);
    expect(parsed?.g).toBe(expected.g);
    expect(parsed?.b).toBe(expected.b);
    expect(parsed?.a).toBeCloseTo(expected.a, 6);
  });

  it.each([
    'var(--x)',
    'color-mix(in srgb, red 50%, blue)',
    'oklch(0.7 0.1 250)',
    'transparent',
    'red',
    'garbage',
    '',
    '#12',
    '#12345',
    '#ggg',
    'rgb(1, 2)',
    'rgb(300, 0, 0)',
    'rgba(1, 2, 3, 2)',
    'rgb(1, 2, 3, 4, 5)',
    'rgb(1 2 3',
    'rgb(-1, 0, 0)',
    'rgb(1, 2, 3) extra',
  ])('rejects %j', (input) => {
    expect(parseColour(input)).toBeNull();
  });
});

describe('composite', () => {
  it('composites a translucent colour source-over an opaque one', () => {
    expect(toHex(composite(hex('rgba(22, 26, 34, 0.55)'), hex('#000000')))).toBe('#0c0e13');
    expect(toHex(composite(hex('rgba(22, 26, 34, 0.55)'), hex('#ffffff')))).toBe('#7f8185');
  });

  it('returns the top colour when it is opaque and the bottom when fully transparent', () => {
    expect(toHex(composite(hex('#123456'), hex('#ffffff')))).toBe('#123456');
    expect(toHex(composite(hex('rgba(1, 2, 3, 0)'), hex('#abcdef')))).toBe('#abcdef');
  });
});

describe('WCAG luminance and contrast', () => {
  it('matches the WCAG 2.1 relative-luminance endpoints and a mid grey', () => {
    expect(relativeLuminance(hex('#000000'))).toBe(0);
    expect(relativeLuminance(hex('#ffffff'))).toBeCloseTo(1, 10);
    expect(relativeLuminance(hex('#777777'))).toBeCloseTo(0.1845, 4);
    expect(relativeLuminance(hex('#ff0000'))).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance(hex('#00ff00'))).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance(hex('#0000ff'))).toBeCloseTo(0.0722, 4);
  });

  it('uses the low-channel linear segment below the 0.04045 threshold', () => {
    expect(relativeLuminance(hex('#0a0a0a'))).toBeCloseTo(10 / 255 / 12.92, 6);
  });

  it('computes contrast ratios symmetrically', () => {
    expect(contrastRatio(hex('#000'), hex('#fff'))).toBeCloseTo(21, 6);
    expect(contrastRatio(hex('#777'), hex('#fff'))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(hex('#fff'), hex('#777'))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(hex('#3b82f6'), hex('#3b82f6'))).toBe(1);
  });
});

describe('toHex', () => {
  it('round-trips lowercase six-digit hex and rounds and clamps channels', () => {
    expect(toHex(hex('#3B82F6'))).toBe('#3b82f6');
    expect(toHex({ r: 12.5, g: 0.4, b: 254.6 })).toBe('#0d00ff');
    expect(toHex({ r: -3, g: 300, b: 16 })).toBe('#00ff10');
  });
});

describe('hslHue', () => {
  it.each([
    ['#ff0000', 0],
    ['#00ff00', 120],
    ['#0000ff', 240],
    ['#ff00ff', 300],
    ['#3b82f6', 217.2],
  ])('gives the HSL hue of %s', (input, hue) => {
    expect(hslHue(hex(input))).toBeCloseTo(hue, 1);
  });

  it('gives 0 for greys', () => {
    expect(hslHue(hex('#777777'))).toBe(0);
  });
});

describe('adjustToContrast', () => {
  const darkPanes = [hex('#11141a'), hex('#454850')];
  const lightPanes = [hex('#cacbcf'), hex('#eff0f4')];

  it('returns the colour unchanged when it already meets the ratio', () => {
    const colour = hex('#e6edf3');
    expect(adjustToContrast(colour, darkPanes, 4.5)).toEqual(colour);
  });

  it('lightens a colour that is too dark for dark panes, keeping its hue within 1°', () => {
    const accent = hex('#3b82f6');
    const adjusted = adjustToContrast(accent, darkPanes, 3);
    expect(adjusted).not.toBeNull();
    if (!adjusted) return;
    for (const pane of darkPanes) expect(contrastRatio(adjusted, pane)).toBeGreaterThanOrEqual(3);
    expect(relativeLuminance(adjusted)).toBeGreaterThan(relativeLuminance(accent));
    expect(Math.abs(hslHue(adjusted) - hslHue(accent))).toBeLessThanOrEqual(1);
  });

  it('moves only as far as needed: one step less would fail', () => {
    const accent = hex('#3b82f6');
    const adjusted = adjustToContrast(accent, darkPanes, 3);
    if (!adjusted) throw new Error('expected an adjusted colour');
    const minimum = Math.min(...darkPanes.map((p) => contrastRatio(adjusted, p)));
    expect(minimum).toBeLessThan(3.15);
  });

  it('darkens a colour that is too light for light panes', () => {
    const muted = hex('#8b949e');
    const adjusted = adjustToContrast(muted, lightPanes, 4.5);
    if (!adjusted) throw new Error('expected an adjusted colour');
    for (const pane of lightPanes)
      expect(contrastRatio(adjusted, pane)).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(adjusted)).toBeLessThan(relativeLuminance(muted));
  });

  it('returns null when no lightness can meet the ratio against every background', () => {
    expect(adjustToContrast(hex('#808080'), [hex('#000000'), hex('#ffffff')], 4.6)).toBeNull();
  });
});
