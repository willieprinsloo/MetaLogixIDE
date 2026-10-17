/**
 * Shared contract for terminal drag-and-drop and clipboard image paste.
 * The renderer pipeline, the main-process staging handlers and the E2E
 * suite all build against these names; change them here and nowhere else.
 */

/** Upper bound on bytes the app will stage to a temporary file (AC14). */
export const MAX_STAGED_BYTES = 50 * 1024 * 1024;

/** Drag type set by the Files tree; its data is JSON `AppFileDragPayload` (AC7). */
export const APP_FILE_DRAG_TYPE = 'application/x-metaide-file';

export interface AppFileDragPayload {
  readonly projectId: number;
  readonly relPath: string;
}

/** Expected staging outcomes are values, never thrown errors. */
export type StageResult =
  | { readonly kind: 'staged'; readonly path: string }
  | { readonly kind: 'too-large'; readonly limitBytes: number }
  | { readonly kind: 'failed'; readonly reason: string };

export type ClipboardImageResult = StageResult | { readonly kind: 'no-image' };

export type ResolveAppFileResult =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'failed'; readonly reason: string };

export interface StageFileRequest {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export type PathStyle = 'posix' | 'windows';
export type PathStyleForFn = (platform: string) => PathStyle;
export type SanitizePasteFn = (text: string) => string;
export type EscapePathFn = (path: string, style: PathStyle) => string;
export type JoinEscapedPathsFn = (paths: readonly string[], style: PathStyle) => string;

/** Every user-facing string this feature shows; tests assert against these. */
export const DROP_COPY = {
  overlayPath: 'Drop to paste path',
  overlayText: 'Drop to paste text',
  tooLargeTitle: 'Too large to paste',
  tooLargeDetail: (name: string): string => `${name} is over the 50 MB limit.`,
  stageFailedTitle: 'Could not save dropped file',
  resolveFailedTitle: 'Could not resolve dragged file',
  clipboardImageFailedTitle: 'Could not paste image',
} as const;
