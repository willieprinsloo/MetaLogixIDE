/** Non-sensitive renderer copy for Metaproject IPC outcomes. */
import type { MetaprojectFailure, PersistenceWarning } from '@shared/metaproject-contract';

export const failureCopy: Record<MetaprojectFailure, string> = {
  'invalid-input': 'Check your entries and try again.',
  'invalid-origin': 'Set a valid service origin in Settings → Metaproject before signing in.',
  'signed-out': 'Sign in to Metaproject to continue.',
  rejected: 'Metaproject did not accept those credentials.',
  expired: 'Your Metaproject session expired. Sign in again.',
  denied: 'Your Metaproject account does not have access.',
  'not-found': 'The project could not be found.',
  network: 'Could not reach Metaproject. Try again.',
  throttled: 'Too many sign-in attempts. Wait and try again.',
  protocol: 'Metaproject returned an unexpected response. Try again.',
  stale: 'The account or project changed. Review your selection and try again.',
  conflict: 'The assignment changed on disk. Reload it before trying again.',
  'invalid-file': 'The .metaproject.yaml assignment is invalid. Fix the file before making changes here.',
  unavailable: 'Could not complete the operation. Try again.',
  'origin-mismatch': 'This project is assigned to a different Metaproject origin.',
};

export const persistenceCopy: Record<PersistenceWarning, string> = {
  'not-remembered': 'Signed in, but this sign-in could not be remembered. You may need to sign in on restart.',
  'keychain-not-cleared': 'A saved credential could not be removed from your system keychain.',
  'forget-incomplete': 'Signed out locally, but could not clear remembered sign-in. Retry sign-out.',
};

export const assignmentReloadCopy = 'The assignment change was written to disk, but could not be confirmed. Reload the assignment before making more changes.';

export const mpButton = 'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded-md border border-[--border] bg-[--surface-active] px-2.5 py-1.5 text-xs text-[--text] hover:bg-[--panel-strong] focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-50';
export const mpInput = 'min-h-11 sm:min-h-0 min-w-0 w-full rounded-md border border-[--border] bg-[--surface-field] px-2.5 py-1.5 text-base sm:text-sm text-[--text] focus-visible:ring-2 focus-visible:ring-[--accent]';
