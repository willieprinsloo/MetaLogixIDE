import type { Project } from '@shared/types';

/** Immutable tab target identity; the settings session reads the latest persisted configuration. */
export type ProjectSettingsTarget = Readonly<Pick<Project, 'id' | 'name' | 'path'>>;

/** Shared accessible copy for project settings and the existing default-star shortcut. */
export const PROJECT_SETTINGS_COPY = {
  contextMenuItem: 'Project settings…',
  title: 'Settings',
  tab: 'Settings',
  noProject: 'Select a project to edit its settings.',
  defaultAgentLabel: 'Default agent',
  globalDefault: 'Use global default',
  terminalAgent: 'Terminal (login shell)',
  nextLaunchNotice: 'Changes apply to the next automatic launch. Running shells are not changed.',
  customCommandsNotice: 'Custom launch commands are active. Choosing or applying a default replaces both custom launch commands and affects only the next automatic launch.',
  replaceCustomCommands: 'Replace custom commands with this default',
  menuDefaultNotice: 'Choosing or clearing a default replaces any custom launch commands. Running shells are not changed.',
  loading: 'Loading project settings…',
  loadFailed: 'Could not load project settings',
  saveFailed: 'Could not save default agent',
  saving: 'Saving default agent…',
  saved: 'Default agent saved',
  retry: 'Retry',
  unavailableProfile: (name: string): string => `${name} (unavailable)`,
  missingProfileNotice: (name: string): string => `The saved profile “${name}” is unavailable. Choose another agent or use the global default.`,
  missingProfileFallback: 'Automatic launches use the global launch commands unless a custom launch command overrides them.',
} as const;

/** Stable selectors shared by UI and real-Electron acceptance tests. */
export const PROJECT_SETTINGS_TESTIDS = {
  tab: 'project-settings-tab',
  view: 'project-settings-view',
  panel: 'project-settings-panel',
  projectName: 'project-settings-name',
  projectPath: 'project-settings-path',
  defaultAgent: 'project-settings-default-agent',
  notice: 'project-settings-notice',
  legacyNotice: 'project-settings-legacy-notice',
  replaceCustomCommands: 'project-settings-replace-custom-commands',
  missingProfile: 'project-settings-missing-profile',
  loading: 'project-settings-loading',
  error: 'project-settings-error',
  status: 'project-settings-status',
  retry: 'project-settings-retry',
} as const;
