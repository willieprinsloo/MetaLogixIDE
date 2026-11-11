/** The project view's main tabs. Renderer-only: the main process never sees the tab. */
export type MainTab = 'shell' | 'files' | 'diff' | 'settings' | 'activity';

export const MAIN_TABS: readonly MainTab[] = ['shell', 'files', 'diff', 'settings', 'activity'];

export function isMainTab(v: unknown): v is MainTab {
  return typeof v === 'string' && (MAIN_TABS as readonly string[]).includes(v);
}
