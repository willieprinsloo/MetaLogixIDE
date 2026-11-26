/** Exact test ids for the split shell and its toolbar toggle. */
export const SPLIT_TESTIDS = {
  toggle: 'tabbar-split',
  header: 'split-pane-header',
  toTab: 'split-to-tab',
  close: 'split-close',
  right: 'split-right',
} as const;

/** Exact user-facing strings for the split shell. */
export const SPLIT_COPY = {
  buttonLabel: 'Split',
  tooltipOn: 'Close split',
  tooltipOff: 'Split shell right',
  toTab: 'To tab',
  toTabTooltip: 'Move to its own tab',
  close: 'Close split',
  resize: 'Resize panes',
} as const;
