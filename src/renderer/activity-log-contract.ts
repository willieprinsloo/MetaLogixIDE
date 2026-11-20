/**
 * Shared contract for the activity-log on/off setting: the settings key, the
 * test ids and the user-facing copy. The implementation and the E2E suite both
 * read from here so they never re-infer these strings separately.
 */
export const ACTIVITY_LOG_SETTING = 'activity_log_enabled' as const;

export const ACTIVITY_LOG_TESTIDS = {
  toggle: 'activity-log-toggle',
  tabButton: 'activity-tab-button',
} as const;

export const ACTIVITY_LOG_COPY = {
  label: 'Record agent activity',
  ariaLabel: 'Record agent activity',
  hint: 'Off stops writing .metaide/activity.jsonl in your projects and hides the Activity tab. Existing logs are kept.',
} as const;
