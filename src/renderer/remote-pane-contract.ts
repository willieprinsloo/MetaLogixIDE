/**
 * Shared names for the remote project pane: test ids, exact user-facing copy for the remote + menu,
 * and the class that marks the active terminal chip. The pane, the shared tabs bar and the e2e
 * spec all import these, so the strings cannot drift apart.
 */

export const REMOTE_PANE_TESTIDS = {
  pane: 'remote-project-pane',
  header: 'remote-workspace-header',
  shellTabs: 'remote-shell-tabs',
  noShells: 'remote-no-shells',
} as const;

export const REMOTE_MENU_COPY = {
  /** Shown when the host runs an older MetaLogix IDE that does not know the tab RPCs. */
  olderHost: (machine: string): string =>
    `${machine} needs a newer version of MetaLogix IDE to open terminals from here. Update it on that machine, then open this menu again.`,
  /** Stands in for the host's name when it is empty or unknown. */
  unknownMachine: 'The other machine',
  /** Shown for any other failure to load the host's profiles. */
  loadFailed: 'Could not load remote CLIs. Reconnect and open this menu again.',
} as const;

/** The class the shared tabs bar puts on the active chip (local and remote). */
export const REMOTE_ACTIVE_CHIP_CLASS = 'bg-[--surface-active]';
