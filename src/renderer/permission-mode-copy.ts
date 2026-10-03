/** Exact user-facing strings for the Claude permission-mode choice. */
export const PERMISSION_MODE_COPY = {
  dialogTitle: 'How should Claude run?',
  dialogIntro: 'Choose how Claude handles actions it takes in your projects.',
  auto: {
    label: 'Auto',
    badge: 'Recommended',
    description:
      "Claude runs actions itself; a safety classifier blocks risky ones. Falls back to asking you if your account or model doesn't support it.",
  },
  bypass: {
    label: 'Bypass',
    description: 'Claude runs every action without asking. Fastest; no safety checks.',
  },
  changeLaterNote: 'You can change this later in Settings → Launch commands.',
  confirm: 'Continue',
  settingsLabel: 'Claude permission mode',
  settingsHint:
    'Rewrites the Claude launch commands below. Applies from the next launch; running shells are not affected.',
} as const;

export const PERMISSION_MODE_TEST_IDS = {
  dialog: 'permission-mode-dialog',
  dialogOptionAuto: 'permission-mode-option-auto',
  dialogOptionBypass: 'permission-mode-option-bypass',
  dialogConfirm: 'permission-mode-confirm',
  dialogError: 'permission-mode-error',
  settingsAuto: 'settings-permission-mode-auto',
  settingsBypass: 'settings-permission-mode-bypass',
  launchEditorFirst: 'launch-editor-first',
  launchEditorSubsequent: 'launch-editor-subsequent',
} as const;
