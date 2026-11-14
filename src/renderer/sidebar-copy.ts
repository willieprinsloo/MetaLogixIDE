import { SHORTCUT_COPY } from './shortcut-copy';

/** User-facing copy for the sidebar header, "+" menu and section headings. */
export const SIDEBAR_COPY = {
  filterPlaceholder: 'Filter projects',
  filterLabel: 'Filter projects',
  addButtonLabel: 'New project',
  menuNewProject: 'New project…',
  /** Mac value, kept for existing callers; the menu uses `SHORTCUT_COPY.newProjectHint(platform)`. */
  menuNewProjectHint: SHORTCUT_COPY.newProjectHint('mac'),
  menuAddRoot: 'Add root folder…',
  menuRescan: 'Rescan roots',
  menuRescanning: 'Rescanning…',
  projectsHeading: 'Projects',
} as const;

/** Test ids shared by the sidebar header, its "+" menu and the e2e suite. */
export const SIDEBAR_TESTIDS = {
  filter: 'sidebar-filter',
  addButton: 'sidebar-add-btn',
  menuNewProject: 'sidebar-add-new-project',
  menuAddRoot: 'sidebar-add-root',
  menuRescan: 'sidebar-add-rescan',
  sectionAll: 'section-all',
} as const;

/** localStorage collapse keys; 'All projects' is the pre-rename key, kept so stored state survives. */
export const SECTION_PERSIST_KEYS = { projects: 'All projects' } as const;

/** User-facing copy for the machine switcher (docs/specs/machine-switcher-dots.md AC6, AC17, AC20, AC25, AC26). */
export const MACHINE_COPY = {
  tablistLabel: 'Machines',
  thisMachineFallback: 'This machine',
  thisMachineTag: 'this machine',
  online: 'online',
  offline: 'offline',
  reconnect: 'Reconnect',
  reconnectLabel: (name: string) => `Reconnect to ${name}`,
  reconnected: (name: string) => `Reconnected to ${name}`,
  reconnectFailed: 'Reconnect failed',
  loading: 'Loading…',
} as const;

/** Test ids for the machine switcher; deliberately not `machine-` prefixed (AC7). */
export const MACHINE_TESTIDS = {
  band: 'switcher-band',
  row: 'switcher-dots',
  dot: (key: string) => `switcher-dot-${key}`,
  localList: 'switcher-local-list',
  remoteList: 'switcher-remote-list',
  remoteHeader: 'switcher-remote-header',
  remoteReconnect: 'switcher-remote-reconnect',
  remoteLastSeen: 'switcher-remote-last-seen',
  remoteInUse: 'switcher-remote-in-use',
  remoteRecents: 'switcher-remote-recents',
  remoteFolders: 'switcher-remote-folders',
  remoteProjectRow: 'remote-project-row',
} as const;
