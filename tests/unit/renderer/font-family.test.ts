import { describe, expect, it } from 'vitest';
import { TERMINAL_FONT_FALLBACK, UI_FONT_FALLBACK } from '../../../src/shared/font-settings';
import {
  buildFontFamilyStack,
  serializeFontFamily,
} from '../../../src/renderer/fonts/font-family';

/** Contract tests for literal CSS family serialization and compatibility fallbacks. */
describe('font-family serialization', () => {
  it.each([
    ['Open Sans', '"Open Sans"'],
    ['Font, serif; color: red', '"Font, serif; color: red"'],
    ['Say "hello"', '"Say \\"hello\\""'],
    ['Back\\slash', '"Back\\\\slash"'],
    ['  日本語フォント  ', '"日本語フォント"'],
  ])('serializes %j as one quoted CSS family', (family, expected) => {
    expect(serializeFontFamily(family)).toBe(expected);
  });

  it.each(['', '   ', 'line\nbreak', 'nul\u0000byte', 'tab\tname'])(
    'rejects an invalid family %j',
    (family) => {
      expect(() => serializeFontFamily(family)).toThrow();
    },
  );

  it('rejects values longer than 256 Unicode code points rather than UTF-16 units', () => {
    expect(() => serializeFontFamily('😀'.repeat(256))).not.toThrow();
    expect(() => serializeFontFamily('😀'.repeat(257))).toThrow();
  });

  it('places one selected literal family ahead of the exact UI fallback', () => {
    expect(buildFontFamilyStack('Acme, "UI"; font', UI_FONT_FALLBACK)).toBe(
      '"Acme, \\"UI\\"; font", system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
    );
  });

  it('returns each exact legacy fallback for a null preference', () => {
    expect(buildFontFamilyStack(null, UI_FONT_FALLBACK)).toBe(UI_FONT_FALLBACK);
    expect(buildFontFamilyStack(null, TERMINAL_FONT_FALLBACK)).toBe(TERMINAL_FONT_FALLBACK);
  });
});
