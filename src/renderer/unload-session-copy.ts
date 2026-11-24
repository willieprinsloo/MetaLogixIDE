/** Shared wording and selectors for the local primary-session unload confirmation. */
export const UNLOAD_SESSION_COPY = {
  title: 'Unload session?',
  consequence: (projectName: string): string =>
    `Unload the primary session for ${projectName}? Other terminal tabs and split shells will keep running.`,
  workWarning: 'The agent is working. Unloading this session may interrupt its work, including sub-agent work.',
  inputWarning: 'The agent needs your input. Unloading this session may interrupt its work.',
  visibleWarning: 'This terminal is currently visible and will stop.',
  keep: 'Keep session',
  unload: 'Unload session',
  ended: 'This session has already ended. Open the project to start a new session.',
  replaced: 'The session changed. Review the current session before unloading it.',
  escalated: 'The agent started working. Review this warning and confirm again to unload.',
  inspectionFailed: 'Could not check this session. Retry or keep it open.',
  stopFailed: 'Could not unload this session. Retry or keep it open.',
} as const;

export const UNLOAD_SESSION_TESTIDS = {
  dialog: 'unload-session-dialog',
  description: 'unload-session-description',
  warning: 'unload-session-warning',
  error: 'unload-session-error',
  keep: 'unload-session-keep',
  unload: 'unload-session-confirm',
  retry: 'unload-session-retry',
} as const;
