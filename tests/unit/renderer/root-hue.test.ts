import { describe, expect, it } from 'vitest';
import { ROOT_HUE_TOKENS, rootHueColour, rootHueToken, rootHueVar } from '@renderer/root-hue';

describe('rootHueToken', () => {
  it('returns the same token for the same path', () => {
    const path = '/Users/frits/Projects/Metalogix';
    expect(rootHueToken(path)).toBe(rootHueToken(path));
  });

  it('ignores trailing separators', () => {
    expect(rootHueToken('/Users/frits/Projects/Trixta/')).toBe(rootHueToken('/Users/frits/Projects/Trixta'));
    expect(rootHueToken('C:\\code\\repo\\')).toBe(rootHueToken('C:\\code\\repo'));
  });

  it('always returns one of the palette hue tokens, including for an empty path', () => {
    for (const p of ['', '/', 'a', '/Users/frits/Projects/Personal', '~/Projects/Ünïcode']) {
      expect(ROOT_HUE_TOKENS).toContain(rootHueToken(p));
    }
  });

  it('spreads typical roots across every hue', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => rootHueToken(`/Users/me/Projects/root-${i}`)));
    expect(seen.size).toBe(ROOT_HUE_TOKENS.length);
  });
});

describe('rootHueVar', () => {
  it('is the colour of the path\'s token', () => {
    for (let i = 0; i < 50; i++) {
      const path = `/Users/me/Projects/root-${i}`;
      expect(rootHueVar(path)).toBe(rootHueColour(rootHueToken(path)));
    }
  });
});

describe('rootHueColour', () => {
  it.each(ROOT_HUE_TOKENS.filter((t) => t !== '--accent'))('wraps %s in var()', (token) => {
    expect(rootHueColour(token)).toBe(`var(${token})`);
  });

  it('paints the accent root with the chrome accent glyph token, falling back to --accent off the chrome (glass-settings D18)', () => {
    expect(rootHueColour('--accent')).toBe('var(--accent-mark, var(--accent))');
  });
});
