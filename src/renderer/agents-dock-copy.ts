/** Test ids of the Agents dock; values are unchanged from before the slide (AC26). */
export const AGENTS_DOCK_TESTIDS = {
  dock: 'agents-dock',
  close: 'agents-dock-close',
  toggle: 'ab-agents',
  main: 'main-column',
  row: 'workspace-row',
} as const;

/** The folding box: aside → FoldPane inner → FoldPane outer (tests/e2e/helpers/frames.ts `^` syntax). */
export const AGENTS_DOCK_FOLD_TARGET = '[data-testid="agents-dock"]^^';
