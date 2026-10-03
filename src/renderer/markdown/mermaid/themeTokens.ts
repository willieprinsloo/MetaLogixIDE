/**
 * DOM adapter that reads the app's theme tokens for the Mermaid palette. The
 * computed style already reflects `data-theme` and the System-mode media
 * query, so this reads whichever palette is live, with no theme logic of its
 * own. Values are returned raw (trimmed); parsing is the palette's job.
 */
import { THEME_TOKEN_NAMES, type ThemeTokens } from './paletteContract';

/** Reads every `THEME_TOKEN_NAMES` custom property from `root`'s computed style. */
export function readThemeTokens(root: Element = document.documentElement): ThemeTokens {
  const view = root.ownerDocument.defaultView ?? window;
  const style = view.getComputedStyle(root);
  const read = (field: keyof ThemeTokens) =>
    style.getPropertyValue(THEME_TOKEN_NAMES[field]).trim();
  return {
    bg: read('bg'),
    panel: read('panel'),
    panelStrong: read('panelStrong'),
    text: read('text'),
    textMuted: read('textMuted'),
    accent: read('accent'),
    danger: read('danger'),
    iconMd: read('iconMd'),
    iconImg: read('iconImg'),
    iconCode: read('iconCode'),
    hljsFunction: read('hljsFunction'),
    hljsVariable: read('hljsVariable'),
    hljsTag: read('hljsTag'),
    hljsString: read('hljsString'),
    hljsNumber: read('hljsNumber'),
  };
}
