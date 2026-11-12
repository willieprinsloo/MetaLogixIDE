/**
 * Shared contract for the macOS keep-awake timer: state and result shapes,
 * limits, every user-facing string, test ids and E2E env-seam names. Main,
 * renderer and E2E all import from here so nothing is retyped.
 */

/** Keep-awake state as held by the main process and broadcast to every window. */
export type KeepAwakeState = { active: false } | { active: true; endsAt: number };

/** Response to `keep-awake:start`. `unsupported` off darwin; `invalid` for a bad or out-of-range `endsAt`. */
export type KeepAwakeStartResult =
  | { ok: true; state: KeepAwakeState }
  | { ok: false; error: 'invalid' | 'unsupported' };

/** Response to `keep-awake:darken`. `inactive` when no keep-awake is running. */
export type KeepAwakeDarkenResult =
  | { ok: true }
  | { ok: false; error: 'inactive' | 'unsupported' };

/** Request for `keep-awake:start`: absolute deadline in epoch milliseconds. */
export interface KeepAwakeStartRequest {
  endsAt: number;
}

export interface KeepAwakePreset {
  id: '30m' | '1h' | '2h' | '4h' | '8h';
  minutes: number;
  title: string;
}

/** Palette presets, in display order. */
export const KEEP_AWAKE_PRESETS: readonly KeepAwakePreset[] = [
  { id: '30m', minutes: 30, title: 'Keep awake: 30 minutes' },
  { id: '1h', minutes: 60, title: 'Keep awake: 1 hour' },
  { id: '2h', minutes: 120, title: 'Keep awake: 2 hours' },
  { id: '4h', minutes: 240, title: 'Keep awake: 4 hours' },
  { id: '8h', minutes: 480, title: 'Keep awake: 8 hours' },
];

/** Longest allowed keep-awake, measured from now. */
export const KEEP_AWAKE_MAX_MS = 24 * 60 * 60 * 1000;

/** Delay between start and the darken action, so the palette or dialog closes first. */
export const KEEP_AWAKE_DARKEN_DELAY_MS = 1500;

/** Every user-facing string for the feature. */
export const KEEP_AWAKE_COPY = {
  palette: {
    until: 'Keep awake until…',
    stop: 'Keep awake: Stop',
    darkenNow: 'Keep awake: Turn screen off now',
  },
  chip: {
    /** Visible chip text, e.g. "1h 42m". */
    label: (remaining: string) => remaining,
    /** Accessible name; includes the remaining time. */
    aria: (remaining: string) => `Keep awake active, ${remaining} left`,
    /** Tooltip with the exact end time, e.g. "Keep awake until 18:30 today". */
    tooltip: (endTime: string) => `Keep awake until ${endTime}`,
  },
  popover: {
    stop: 'Stop',
    darkenNow: 'Turn screen off now',
    lidHint: 'Keep the lid open: a closed lid on battery still sleeps.',
  },
  dialog: {
    title: 'Keep awake until',
    label: 'End time (HH:MM, 24-hour)',
    placeholder: '18:30',
    confirm: 'Start',
    cancel: 'Cancel',
    errorEmpty: 'Enter a time.',
    errorMalformed: 'Use HH:MM, for example 18:30.',
    /** Resolved-deadline preview, e.g. "Until 07:00 tomorrow". */
    preview: (endTime: string) => `Until ${endTime}`,
  },
  notification: {
    title: 'Keep awake ended',
    body: 'Your Mac can sleep again.',
  },
  toast: {
    darkenFailed: 'Could not turn the screen off',
    darkenFailedDetail: 'Keep awake is still on.',
    startFailed: 'Could not start keep awake',
  },
} as const;

/** `data-testid` values for unit and E2E tests. */
export const KEEP_AWAKE_TESTIDS = {
  chip: 'keep-awake-chip',
  popover: 'keep-awake-popover',
  stop: 'keep-awake-stop',
  darkenNow: 'keep-awake-darken-now',
  dialog: 'keep-awake-dialog',
  input: 'keep-awake-input',
  error: 'keep-awake-error',
  preview: 'keep-awake-preview',
  confirm: 'keep-awake-confirm',
} as const;

/**
 * E2E env seams, honoured only when `METAIDE_TEST_MODE=1`. In test mode the
 * real darken never runs; a recorder appends one line per call to `darkenLog`.
 * `darkenFail=1` makes the recorder report failure.
 */
export const KEEP_AWAKE_ENV = {
  darkenLog: 'METAIDE_KEEP_AWAKE_DARKEN_LOG',
  darkenFail: 'METAIDE_KEEP_AWAKE_DARKEN_FAIL',
} as const;
