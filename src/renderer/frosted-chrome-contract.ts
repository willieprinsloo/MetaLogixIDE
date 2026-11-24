/**
 * Root/region attributes the frosted-chrome CSS keys on. CSS cannot import this;
 * frosted-chrome-css.test.ts asserts the stylesheet uses these exact strings. `data-platform` is
 * present only while frosted chrome is active, and its value is the `FrostPlatform` (`mac` or
 * `linux`); the CSS gates on its presence, never on its value, so Linux shares the macOS cascade.
 */
export const FROST_ATTR = {
  platform: 'data-platform',
  chromeRoot: 'data-chrome-root',
  sheetContent: 'data-sheet-content',
  overlay: 'data-overlay',
  chromeFrost: 'data-chrome-frost',
  terminalFrost: 'data-terminal-frost',
  /**
   * Present whenever the window itself is transparent (Linux, whatever Frosted chrome says). With
   * Frosted chrome off it lets the CSS paint an opaque underlay, so the window still looks as it
   * did before Linux windows became transparent (AC7).
   */
  transparentWindow: 'data-transparent-window',
} as const;
export const MAC_PLATFORM = 'mac' as const;
export type SheetContent = 'shell' | 'other';

/** Settings > General > Appearance "Frosted glass" group copy (spec D12) and option labels. */
export const FROSTED_GLASS_COPY = {
  group: 'Frosted glass',
  frostChrome: 'Frosted chrome',
  frostChromeHint: 'Let the desktop show through the sidebar and title bar.',
  chromeFrost: 'Chrome frost',
  terminalFrost: 'Terminal frost',
  material: 'Material',
  materialHint: 'The macOS glass behind the window.',
  disabledReason: 'Needs Frosted chrome',
  frostChromeHintLinux: 'Let the desktop show through the sidebar and title bar. Blur depends on your compositor.',
  reduceTransparency: 'Reduce transparency is on in System Settings, so these surfaces stay solid.',
  reduceTransparencyLinux: 'Your system asks for reduced transparency, so these surfaces stay solid.',
  levels: { off: 'Off', subtle: 'Subtle', medium: 'Medium', strong: 'Strong' },
  materials: {
    sidebar: 'Sidebar',
    'under-window': 'Under window',
    hud: 'HUD',
    menu: 'Menu',
    popover: 'Popover',
  },
} as const;

export const FROSTED_GLASS_TESTIDS = {
  group: 'frosted-glass-group',
  frostChrome: 'frosted-glass-chrome-toggle',
  chromeFrost: 'frosted-glass-chrome-level',
  terminalFrost: 'frosted-glass-terminal-level',
  material: 'frosted-glass-material',
  reduceTransparency: 'frosted-glass-reduce-transparency',
} as const;
