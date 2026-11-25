/** The project view's main tabs. Renderer-only: the main process never sees the tab. */
export type MainTab = 'shell' | 'files' | 'diff' | 'settings' | 'activity';

export const MAIN_TABS: readonly MainTab[] = ['shell', 'files', 'diff', 'settings', 'activity'];

export function isMainTab(v: unknown): v is MainTab {
  return typeof v === 'string' && (MAIN_TABS as readonly string[]).includes(v);
}

/** The tab to actually show: a saved or active Activity tab becomes Shell while the activity log is off. */
export function visibleMainTab(tab: MainTab, activityEnabled: boolean): MainTab {
  return tab === 'activity' && !activityEnabled ? 'shell' : tab;
}
