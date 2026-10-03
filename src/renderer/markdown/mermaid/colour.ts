/**
 * Pure sRGB colour maths for the Mermaid palette: parses the colour forms the
 * theme tokens use (hex and `rgb()`/`rgba()`), composites translucent colours
 * source-over, computes WCAG 2.1 relative luminance and contrast, and moves a
 * colour's HSL lightness (keeping its hue) until it meets a contrast ratio.
 * Anything it cannot parse comes back as `null` rather than a guess.
 */
import type { Rgb, Rgba } from './paletteContract';

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_FUNCTION = /^rgba?\((.*)\)$/i;
const NUMBER = /^(\d+(\.\d+)?|\.\d+)$/;
const ALPHA = /^(\d+(\.\d+)?|\.\d+)(%)?$/;

function parseHex(digits: string): Rgba {
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
  const channel = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16);
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: full.length === 8 ? channel(3) / 255 : 1,
  };
}

function splitArguments(body: string): string[] | null {
  if (body.includes(',')) return body.split(',').map((part) => part.trim());
  const [channels = '', alpha, ...rest] = body.split('/').map((part) => part.trim());
  if (rest.length > 0) return null;
  const parts = channels.split(/\s+/);
  return alpha === undefined ? parts : [...parts, alpha];
}

function parseAlpha(value: string | undefined): number | null {
  if (value === undefined) return 1;
  const match = ALPHA.exec(value);
  if (!match) return null;
  const alpha = Number(match[1]) / (match[3] ? 100 : 1);
  return alpha <= 1 ? alpha : null;
}

function parseRgbFunction(body: string): Rgba | null {
  const parts = splitArguments(body);
  if (!parts || parts.length < 3 || parts.length > 4) return null;
  const channels = parts.slice(0, 3).map((part) => (NUMBER.test(part) ? Number(part) : NaN));
  const a = parseAlpha(parts[3]);
  if (a === null || channels.some((c) => !(c >= 0 && c <= 255))) return null;
  const [r = 0, g = 0, b = 0] = channels;
  return { r, g, b, a };
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`; `null` for anything else. */
export function parseColour(value: string): Rgba | null {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex?.[1]) return parseHex(hex[1]);
  const fn = RGB_FUNCTION.exec(text);
  return fn?.[1] === undefined ? null : parseRgbFunction(fn[1]);
}

/** Paints `top` source-over the opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgb): Rgb {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b) };
}

/** One sRGB channel (0 to 255) as linear light (0 to 1), per WCAG 2.1 / IEC 61966-2-1. */
export function linearChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * linearChannel(c.r) + 0.7152 * linearChannel(c.g) + 0.0722 * linearChannel(c.b);
}

/** WCAG 2.1 contrast ratio between two opaque colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Serialises to lowercase `#rrggbb`, rounding and clamping each channel. */
export function toHex(c: Rgb): string {
  const byte = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl({ r, g, b }: Rgb): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const sector =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / d + 2
        : (rn - gn) / d + 4;
  return { h: sector * 60, s, l };
}

function fromHsl({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - (c / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return { r: channel(0), g: channel(8), b: channel(4) };
}

/** HSL lightness, 0 to 1. */
export function hslLightness(c: Rgb): number {
  return toHsl(c).l;
}

/** HSL hue in degrees, `[0, 360)`; 0 for greys. */
export function hslHue(c: Rgb): number {
  return toHsl(c).h;
}

/** The colour at HSL lightness `l` (0 to 1) with the same hue and saturation, as whole channels. */
export function withLightness(c: Rgb, l: number): Rgb {
  return fromHsl({ ...toHsl(c), l: Math.min(1, Math.max(0, l)) });
}

/** The colour with its HSL hue turned by `degrees`, same saturation and lightness, as whole channels. */
export function rotateHue(c: Rgb, degrees: number): Rgb {
  const hsl = toHsl(c);
  return fromHsl({ ...hsl, h: (((hsl.h + degrees) % 360) + 360) % 360 });
}

const LIGHTNESS_STEP = 0.0025;

function meets(c: Rgb, backgrounds: readonly Rgb[], min: number): boolean {
  return backgrounds.every((bg) => contrastRatio(c, bg) >= min);
}

/**
 * The colour nearest `c` in HSL lightness, same hue and saturation, whose
 * contrast against every one of `backgrounds` is at least `min`; `c` itself
 * when it already qualifies, and `null` when no lightness does.
 */
export function adjustToContrast(c: Rgb, backgrounds: readonly Rgb[], min: number): Rgb | null {
  if (meets(c, backgrounds, min)) return c;
  const { l } = toHsl(c);
  for (let step = LIGHTNESS_STEP; step <= 1; step += LIGHTNESS_STEP) {
    for (const candidate of [l + step, l - step]) {
      if (candidate < 0 || candidate > 1) continue;
      const moved = withLightness(c, candidate);
      if (meets(moved, backgrounds, min)) return moved;
    }
  }
  return null;
}
