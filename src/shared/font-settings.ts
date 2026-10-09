export const FONT_SETTING_KEYS = ['ui_font_family', 'terminal_font_family'] as const;
export type FontSettingKey = (typeof FONT_SETTING_KEYS)[number];
export type FontFamilyPreference = string | null;

export const MAX_FONT_FAMILY_CODE_POINTS = 256;
// system-ui leads: it is the desktop's UI font everywhere (SF Pro on macOS,
// Segoe UI on Windows, the GTK/fontconfig font on Linux). On Linux, Chromium
// resolves -apple-system and BlinkMacSystemFont to plain sans-serif, so they
// must not come first.
export const UI_FONT_FALLBACK = 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
export const TERMINAL_SYMBOL_FONT = 'Symbols Nerd Font Mono';
export const TERMINAL_FONT_FALLBACK = `"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, "${TERMINAL_SYMBOL_FONT}", monospace`;

export type FontFamilyParseResult =
  | { readonly ok: true; readonly value: FontFamilyPreference }
  | { readonly ok: false; readonly error: string };

export function isFontSettingKey(value: unknown): value is FontSettingKey {
  return value === 'ui_font_family' || value === 'terminal_font_family';
}
export function parseFontFamilyPreference(value: unknown): FontFamilyParseResult {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'font family must be a string or null' };
  const family = value.trim();
  if (family.length === 0) return { ok: false, error: 'font family cannot be empty' };
  if (/[\u0000-\u001F]/u.test(family)) return { ok: false, error: 'font family cannot contain control characters' };
  let codePoints = 0;
  for (let offset = 0; offset < family.length;) {
    const codePoint = family.codePointAt(offset);
    if (codePoint === undefined) break;
    codePoints += 1;
    if (codePoints > MAX_FONT_FAMILY_CODE_POINTS) {
      return { ok: false, error: `font family cannot exceed ${MAX_FONT_FAMILY_CODE_POINTS} Unicode code points` };
    }
    offset += codePoint > 0xFFFF ? 2 : 1;
  }
  return { ok: true, value: family };
}
