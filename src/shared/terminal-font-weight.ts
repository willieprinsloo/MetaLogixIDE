/** Settings key for the integrated-terminal font weight (normal text). Write via settings:set-terminal-font-weight only. */
export const TERMINAL_FONT_WEIGHT_KEY = 'terminal_font_weight' as const;

/** Settings key for the integrated-terminal bold weight. Write via settings:set-terminal-bold-weight only. */
export const TERMINAL_BOLD_WEIGHT_KEY = 'terminal_bold_weight' as const;

/** The nine CSS weights a user can choose for terminal text. */
export const TERMINAL_FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export type TerminalFontWeight = (typeof TERMINAL_FONT_WEIGHTS)[number];

/** Normal-text weight in use when nothing (or something invalid) is stored; equals xterm's 'normal'. */
export const TERMINAL_FONT_WEIGHT_DEFAULT: TerminalFontWeight = 400;

/** Bold weight in use when nothing is stored; equals xterm's 'bold'. */
export const TERMINAL_BOLD_WEIGHT_DEFAULT: TerminalFontWeight = 700;

/** The normal and bold weights a terminal renders with. */
export interface TerminalWeights {
  readonly weight: TerminalFontWeight;
  readonly boldWeight: TerminalFontWeight;
}

export type TerminalFontWeightParseResult =
  | { readonly ok: true; readonly value: TerminalFontWeight }
  | { readonly ok: false; readonly error: string };

/** Validator shared by main and renderer for either key: accepts only a number in TERMINAL_FONT_WEIGHTS. */
export function parseTerminalFontWeight(value: unknown): TerminalFontWeightParseResult {
  if (typeof value === 'number' && (TERMINAL_FONT_WEIGHTS as readonly number[]).includes(value)) {
    return { ok: true, value: value as TerminalFontWeight };
  }
  return { ok: false, error: 'terminal font weight must be one of 100, 200, ... 900' };
}

/** Bold weight set when the user chooses a font weight: 200 heavier, capped at 900. */
export function derivedBoldWeight(weight: TerminalFontWeight): TerminalFontWeight {
  return Math.min(weight + 200, 900) as TerminalFontWeight;
}

/** Bold must be heavier than the font weight; at font weight 900 the only valid bold is 900. */
export function isValidBoldWeight(weight: TerminalFontWeight, bold: TerminalFontWeight): boolean {
  return bold > weight || (weight === 900 && bold === 900);
}

/** The bold weights a user may choose for a given font weight. */
export function boldWeightChoices(weight: TerminalFontWeight): readonly TerminalFontWeight[] {
  return TERMINAL_FONT_WEIGHTS.filter((bold) => isValidBoldWeight(weight, bold));
}

/**
 * Resolves the stored pair into the weights in use. A missing value falls back silently;
 * a present but invalid value falls back and adds one error. Bold falls back to 700 when
 * that is valid for the font weight in use, otherwise to derivedBoldWeight(weight).
 */
export function resolveTerminalWeights(
  storedWeight: unknown,
  storedBold: unknown,
): TerminalWeights & { readonly errors: readonly string[] } {
  const errors: string[] = [];

  let weight = TERMINAL_FONT_WEIGHT_DEFAULT;
  if (storedWeight !== null && storedWeight !== undefined) {
    const parsed = parseTerminalFontWeight(storedWeight);
    if (parsed.ok) weight = parsed.value;
    else errors.push(`stored terminal font weight ${JSON.stringify(storedWeight)} is invalid; using ${weight}`);
  }

  const fallbackBold = isValidBoldWeight(weight, TERMINAL_BOLD_WEIGHT_DEFAULT)
    ? TERMINAL_BOLD_WEIGHT_DEFAULT
    : derivedBoldWeight(weight);
  let boldWeight = fallbackBold;
  if (storedBold !== null && storedBold !== undefined) {
    const parsed = parseTerminalFontWeight(storedBold);
    if (parsed.ok && isValidBoldWeight(weight, parsed.value)) boldWeight = parsed.value;
    else errors.push(`stored terminal bold weight ${JSON.stringify(storedBold)} is invalid for font weight ${weight}; using ${fallbackBold}`);
  }

  return { weight, boldWeight, errors };
}
