import type { TerminalFontWeight } from '@shared/terminal-font-weight';

export const UI_FONT_CSS_PROPERTY = '--metaide-ui-font-family';

export const FONT_TEST_IDS = {
  uiInput: 'ui-font-input',
  /** The "System default" option in the UI font list. */
  uiReset: 'ui-font-reset',
  uiStatus: 'ui-font-status',
  terminalInput: 'terminal-font-input',
  /** The "System default" option in the terminal font list. */
  terminalReset: 'terminal-font-reset',
  terminalStatus: 'terminal-font-status',
  terminalSizeInput: 'terminal-font-size-input',
  terminalWeightSelect: 'terminal-font-weight-select',
  terminalBoldSelect: 'terminal-bold-weight-select',
} as const;

/** CSS weight names shown in the terminal font weight dropdown. */
export const TERMINAL_FONT_WEIGHT_NAMES: Readonly<Record<TerminalFontWeight, string>> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

export const FONT_COPY = {
  sectionLabel: 'Fonts',
  uiLabel: 'Interface',
  terminalLabel: 'Terminal',
  defaultValue: 'System default',
  loading: 'Loading installed fonts…',
  retry: 'Retry',
  saving: 'Saving…',
  saveFailed: 'Could not save this font. Your previous font remains active.',
  customOption: (family: string): string => `Use “${family}”`,
  discoveryUnsupported: 'Installed fonts can’t be listed here. Type an exact family name.',
  discoveryDenied: 'Access to installed fonts was denied. Type an exact family name.',
  discoveryError: 'Installed fonts could not be loaded. Type an exact family name.',
  unavailable: 'Font is not available on this computer.',
  unknown: 'Font availability is unknown.',
  terminalSizeLabel: 'Terminal font size',
  terminalSizeHint: 'Every terminal uses this size. ⌘= / ⌘- / ⌘0 also change it.',
  terminalSizeUnit: 'px',
  terminalSizeSaveFailed: 'Could not save the terminal font size. Your previous size remains active.',
  terminalWeightLabel: 'Terminal font weight',
  terminalWeightHint: 'Changing this also sets bold to 200 heavier, up to 900. Fonts without this weight use the nearest one.',
  terminalWeightSaveFailed: 'Could not save the terminal font weight. Your previous weight remains active.',
  terminalBoldLabel: 'Terminal bold weight',
  terminalBoldHint: 'Bold text is drawn at this weight. It must be heavier than the font weight.',
  terminalBoldSaveFailed: 'Could not save the terminal bold weight. Your previous bold weight remains active.',
  /** Dropdown option label, e.g. "Medium (500)". */
  terminalWeightOptionLabel: (weight: TerminalFontWeight): string => `${TERMINAL_FONT_WEIGHT_NAMES[weight]} (${weight})`,
} as const;
