/** Builds the xterm weight options from the shared terminal weights; terminal construction and live update both use it so the normal/bold pair is always applied together. */
import type { TerminalFontWeight, TerminalWeights } from '@shared/terminal-font-weight';

export interface TerminalFontWeightOptions {
  readonly fontWeight: TerminalFontWeight;
  readonly fontWeightBold: TerminalFontWeight;
}

/** Returns `fontWeight` = `weights.weight` and `fontWeightBold` = `weights.boldWeight`, as numbers xterm accepts. */
export function terminalFontWeightOptions(weights: TerminalWeights): TerminalFontWeightOptions {
  return { fontWeight: weights.weight, fontWeightBold: weights.boldWeight };
}
