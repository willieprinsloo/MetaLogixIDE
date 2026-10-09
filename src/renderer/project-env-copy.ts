/** Exact user-facing strings and test ids for the per-project environment variables editor (the Env tab). */
export const ENV_COPY = {
  tabLabel: 'Env',
  tabUnsavedLabel: 'Env, unsaved changes', // aria-label when a draft differs
  tabUnsavedMarker: '•', // visible, aria-hidden
  contextMenuItem: 'Environment variables…',
  panelTitle: 'Environment variables', // heading inside the tab
  emptyState: 'No environment variables for this project.',
  noticeNewShells:
    'Changes apply to newly opened shells only. Shells that are already running keep their current environment.',
  noticeUnencrypted: 'Values are stored unencrypted on this machine.',
  noticeLaunchArgs:
    'If a launch command uses a variable in its arguments, that value is saved with the shell.', // D13
  tokensHint:
    'Values can use ${HOME}, ${PROJECT_PATH}, ${PROJECT_NAME} and ${env.NAME}. To extend PATH: ${PROJECT_PATH}/node_modules/.bin:${env.PATH}',
  nameLabel: (row: number) => `Name, row ${row}`,
  valueLabel: (row: number) => `Value, row ${row}`,
  removeLabel: (row: number) => `Remove variable, row ${row}`,
  addRow: 'Add variable',
  save: 'Save',
  discard: 'Discard',
  saveFailed: 'Could not save environment variables',
  loadFailed: 'Could not load environment variables',
  revealLabel: (row: number) => `Show value, row ${row}`,
  hideLabel: (row: number) => `Hide value, row ${row}`,
  copyLabel: (row: number) => `Copy value, row ${row}`,
  inheritedValueLabel: (row: number) => `App-wide value, row ${row}`,
  inheritedRevealLabel: (row: number) => `Show app-wide value, row ${row}`,
  inheritedHideLabel: (row: number) => `Hide app-wide value, row ${row}`,
  inheritedCopyLabel: (row: number) => `Copy app-wide value, row ${row}`,
  revealTooltip: 'Show value',
  hideTooltip: 'Hide value',
  copyTooltip: 'Copy value',
  copied: 'Value copied',
  copyFailed: 'Could not copy value',
  inheritedTitle: 'From app settings',
  inheritedEmpty: 'No variables from app settings.',
  inheritedOverridden: 'Overridden by this project',
  openAppEnv: 'Open app environment settings',
  reason: {
    invalid: 'Use letters, digits and _, not starting with a digit',
    'too-long': 'Name must be 255 characters or fewer',
    reserved: 'Reserved — METAIDE_ names and __proto__ cannot be used',
    duplicate: 'Duplicate name',
    nul: 'Value contains a NUL character',
  },
} as const;
export const ENV_TESTIDS = {
  tab: 'main-tab-env',
  unsaved: 'project-env-unsaved',
  panel: 'project-env-panel',
  row: 'project-env-row',
  name: 'project-env-name',
  value: 'project-env-value',
  remove: 'project-env-remove',
  reason: 'project-env-reason',
  add: 'project-env-add',
  save: 'project-env-save',
  discard: 'project-env-discard',
  empty: 'project-env-empty',
  reveal: 'env-reveal',
  copy: 'env-copy',
  inherited: 'project-env-inherited',
  inheritedRow: 'project-env-inherited-row',
  inheritedName: 'project-env-inherited-name',
  inheritedValue: 'project-env-inherited-value',
  inheritedOverridden: 'project-env-inherited-overridden',
  inheritedEmpty: 'project-env-inherited-empty',
  openAppEnv: 'project-env-open-app-env',
} as const;

/** Strings for the Settings → Environment section. Notices, hint, row labels, reasons, Add/Save/Discard and toasts are shared from ENV_COPY. */
export const APP_ENV_COPY = {
  navLabel: 'Environment',
  navUnsavedLabel: 'Environment, unsaved changes', // aria-label while the app draft differs; the visible marker is ENV_COPY.tabUnsavedMarker
  panelTitle: 'App-wide environment variables',
  panelSubtitle: 'Applied to every shell in every project. A project variable with the same name wins.',
  emptyState: 'No app-wide environment variables.',
} as const;
export const APP_ENV_TESTIDS = {
  panel: 'app-env-panel',
  unsaved: 'app-env-unsaved',
  empty: 'app-env-empty',
} as const;
