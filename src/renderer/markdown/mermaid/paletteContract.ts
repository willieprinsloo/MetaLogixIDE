/**
 * Shared contract for the Mermaid app palette: the CSS tokens the palette
 * reads, the reference materials a diagram's transparent areas land on, and
 * the legibility thresholds the palette must meet. The DOM token reader, the
 * pure palette derivation and the E2E suite all agree on these; change them
 * here only.
 */
import type { EffectiveTheme } from '../contract';

/** Raw computed values of the app's theme tokens, as CSS strings. */
export interface ThemeTokens {
  bg: string;
  panel: string;
  panelStrong: string;
  text: string;
  textMuted: string;
  accent: string;
  danger: string;
  iconMd: string;
  iconImg: string;
  iconCode: string;
  hljsFunction: string;
  hljsVariable: string;
  hljsTag: string;
  hljsString: string;
  hljsNumber: string;
}

/** The CSS custom property behind each `ThemeTokens` field. */
export const THEME_TOKEN_NAMES: Record<keyof ThemeTokens, `--${string}`> = {
  bg: '--bg',
  panel: '--panel',
  panelStrong: '--panel-strong',
  text: '--text',
  textMuted: '--text-muted',
  accent: '--accent',
  danger: '--danger',
  iconMd: '--icon-md',
  iconImg: '--icon-img',
  iconCode: '--icon-code',
  hljsFunction: '--hljs-function',
  hljsVariable: '--hljs-variable',
  hljsTag: '--hljs-tag',
  hljsString: '--hljs-string',
  hljsNumber: '--hljs-number',
};

/**
 * Opaque bounds of what can sit behind the preview in each theme: `[lo, hi]`
 * as `#rrggbb`. The preview pane paints no background of its own, so a
 * diagram lands on `--bg` over the window's vibrancy material. The material
 * depends on the desktop and is invisible to `capturePage`, so the bounds
 * are the full black-to-white envelope rather than a measured sample.
 */
export const REFERENCE_MATERIALS: Record<EffectiveTheme, readonly [lo: string, hi: string]> = {
  dark: ['#000000', '#ffffff'],
  light: ['#000000', '#ffffff'],
};

/**
 * `--bg` is painted by both `html` and `body`, so the translucent layer over
 * the material is `--bg` composited this many times (measured 2026-09-29 with
 * `webContents.capturePage`: dark alpha 203/255, light 218/255).
 */
export const BG_LAYERS = 2;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  a: number;
}

/** A theme token whose value cannot be resolved to a colour. */
export class PaletteTokenError extends Error {
  constructor(
    readonly token: `--${string}`,
    readonly value: string,
    options?: { cause?: unknown },
  ) {
    super(`Theme token ${token} has an unparseable colour value: ${value}`, options);
    this.name = 'PaletteTokenError';
  }
}

/** WCAG 2.1 AA minimum contrast for text. */
export const CONTRAST_TEXT = 4.5;
/** WCAG 2.1 AA minimum contrast for meaningful non-text graphics. */
export const CONTRAST_GRAPHIC = 3;
/** Minimum CIEDE2000 distance between any two categorical colours. */
export const MIN_CATEGORY_DELTA_E = 15;
