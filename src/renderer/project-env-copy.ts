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
} as const;
