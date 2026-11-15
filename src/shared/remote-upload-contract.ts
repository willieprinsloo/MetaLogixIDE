/**
 * Shared contract for sending pasted images and dropped files to a paired (remote) machine.
 * The viewer's renderer routes and confirms, the viewer's main process runs the upload, and the
 * host stages the bytes in its own drop folder (docs/specs/remote-clipboard.md AC-U*, AC-I*,
 * AC-D*). Change names here and nowhere else.
 */
import type { PathStyle } from './terminal-drop-contract';
import { MAX_STAGED_BYTES } from './terminal-drop-contract';

export { MAX_STAGED_BYTES };

/** Raw bytes per `drops.uploadChunk` call; base64 of this stays well under the 1 MiB frame. */
export const UPLOAD_CHUNK_BYTES = 256 * 1024;
/** Largest base64 `data` string a host accepts in one chunk. */
export const UPLOAD_CHUNK_MAX_B64_CHARS = 350_000;
/** Uploads a host accepts at once from one paired machine (AC-U8). */
export const MAX_UPLOADS_PER_PEER = 4;
/** Total bytes a host keeps in its drop folder, `.part` files included (AC-U8). */
export const MAX_STAGING_TOTAL_BYTES = 500 * 1024 * 1024;
/** Uploads above this size ask the user first (decision Q2). */
export const UPLOAD_CONFIRM_ABOVE_BYTES = 10 * 1024 * 1024;
/** A host discards an upload with no chunk for this long (AC-U6 backstop). */
export const UPLOAD_IDLE_TIMEOUT_MS = 60_000;
/** The progress indicator appears only for uploads still running after this long (AC-D5). */
export const UPLOAD_PROGRESS_DELAY_MS = 500;

/** Host-side `RpcError` codes for the upload methods. `unknown_method` comes from an old host. */
export type UploadRpcErrorCode =
  | 'upload_too_large'
  | 'too_many_uploads'
  | 'drop_folder_full'
  | 'upload_offset'
  | 'upload_overrun'
  | 'upload_incomplete'
  | 'upload_unknown';

/** What the viewer sends. Bytes for OS files; main reads app files and the clipboard image itself. */
export type UploadSource =
  | { readonly kind: 'bytes'; readonly name: string; readonly mime: string; readonly bytes: Uint8Array }
  | { readonly kind: 'app-file'; readonly projectId: number; readonly relPath: string }
  | { readonly kind: 'clipboard-image' };

/** Renderer → viewer main: start one upload. `confirmed` skips the over-10 MB check. */
export interface UploadRequest {
  readonly uploadId: string;
  readonly deviceId: string;
  readonly source: UploadSource;
  readonly confirmed?: boolean;
}

/** Every outcome is a value; `p2p:upload` never rejects. */
export type UploadResult =
  | { readonly kind: 'staged'; readonly path: string; readonly style: PathStyle }
  | { readonly kind: 'needs-confirm'; readonly size: number }
  | { readonly kind: 'no-image' }
  | { readonly kind: 'too-large'; readonly limitBytes: number }
  | { readonly kind: 'unsupported-host' }
  | { readonly kind: 'refused'; readonly reason: 'drop-folder-full' | 'too-many-uploads' }
  | { readonly kind: 'link-lost' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Viewer main → renderer, at most 10 per second per upload. */
export interface UploadProgressEvent {
  readonly uploadId: string;
  readonly sentBytes: number;
  readonly totalBytes: number;
}

/** Local stat of a Files-tab drag payload, for the confirm and folder checks (AC-D2, AC-D9). */
export type StatAppFileResult =
  | { readonly kind: 'ok'; readonly name: string; readonly size: number; readonly isDirectory: boolean }
  | { readonly kind: 'failed'; readonly reason: string };

/** Every user-facing string for remote uploads; tests assert against these. */
export const REMOTE_UPLOAD_COPY = {
  overlaySend: (host: string): string => `Drop to send to ${host}`,
  sendFailedTitle: (host: string): string => `Could not send file to ${host}`,
  sendFileFailedTitle: (file: string, host: string): string => `Could not send ${file} to ${host}`,
  oldHostDetail: (host: string): string =>
    `${host} is running an older version of MetaLogix IDE. Update it to paste images and drop files.`,
  dropFolderFullDetail: (host: string): string => `${host} drop folder is full`,
  tooManyUploadsDetail: (host: string): string => `${host} has too many uploads in progress`,
  linkLostDetail: 'The connection was lost during the upload.',
  folderRefusedTitle: (host: string): string => `Folders can't be sent to ${host}`,
  confirmMessage: (files: readonly { name: string; size: string }[], host: string): string =>
    `Send ${files.length === 1 ? 'this large file' : 'these large files'} to ${host}?\n\n${files.map((f) => `${f.name} (${f.size})`).join('\n')}`,
  progressLabel: (file: string, index: number, count: number, percent: number): string =>
    count > 1 ? `Sending ${file} (${index} of ${count}), ${percent}%` : `Sending ${file}, ${percent}%`,
  cancel: 'Cancel',
} as const;
