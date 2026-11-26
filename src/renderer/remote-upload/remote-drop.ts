/**
 * Pure planner for drops onto a remote (fleet) terminal (AC-D1..D4, AC-D6, AC-D9, AC-D10, AC-U2,
 * AC-U5, AC-U12, decisions Q2/Q4). Precedence matches the local `planDrop`: the Files-tree drag
 * type, then files, then `text/plain`. Files are sent to the host one at a time and the host's own
 * paths are typed, escaped in the host's style; a viewer path is never typed. Every effect
 * (upload, stat, confirm, toast) is injected through `RemoteDropDeps`.
 */
import type { DropKind } from '@renderer/drag-hover';
import type { RemoteTarget } from '@renderer/remote-upload/useUploadProgress';
import { parseAppFile, type DropFile, type DropSnapshot } from '@renderer/terminal-drop';
import { sanitizePaste } from '@shared/paste-sanitize';
import {
  REMOTE_UPLOAD_COPY,
  UPLOAD_CONFIRM_ABOVE_BYTES,
  type StatAppFileResult,
  type UploadResult,
  type UploadSource,
} from '@shared/remote-upload-contract';
import { joinEscapedPaths } from '@shared/shell-escape';
import {
  DROP_COPY,
  MAX_STAGED_BYTES,
  type AppFileDragPayload,
  type PathStyle,
} from '@shared/terminal-drop-contract';

/** Which file of a drop is uploading, for the progress indicator ("n of m"). */
export interface UploadItem {
  readonly name: string;
  readonly index: number;
  readonly count: number;
}

/** Injected effects; `upload` resolves every outcome as a value, `confirm` is `window.confirm`. */
export interface RemoteDropDeps {
  readonly hostName: string;
  upload(source: UploadSource, item: UploadItem, confirmed: boolean): Promise<UploadResult>;
  statAppFile(payload: AppFileDragPayload): Promise<StatAppFileResult>;
  confirm(message: string): boolean;
  notify(title: string, detail: string): void;
}

interface Entry {
  readonly name: string;
  readonly size: number;
  readonly isDirectory: boolean;
  source(): Promise<UploadSource>;
}

interface Staged {
  readonly path: string;
  readonly style: PathStyle;
}

/** `staged` carries host paths; `cancelled` means the whole drop types nothing (Q4). */
type Outcome = { readonly kind: 'staged'; readonly paths: readonly Staged[] } | { readonly kind: 'cancelled' };

const MB = 1024 * 1024;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Formats a byte count for the confirm dialog, e.g. `12.3 MB`. */
export const formatUploadSize = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/** Drop overlay copy: on a remote terminal a file drag reads "Drop to send to <host>" (AC-D11). */
export function dropOverlayLabel(kind: DropKind, hostName: string | null): string {
  if (kind === 'text') return DROP_COPY.overlayText;
  return hostName === null ? DROP_COPY.overlayPath : REMOTE_UPLOAD_COPY.overlaySend(hostName);
}

function fileEntries<F extends DropFile>(snapshot: DropSnapshot<F>): Entry[] {
  return snapshot.files.map((file, i) => ({
    name: file.name,
    size: file.size,
    isDirectory: snapshot.isDirectory?.[i] === true,
    source: async () => ({
      kind: 'bytes',
      name: file.name,
      mime: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }),
  }));
}

async function appFileEntries(payload: AppFileDragPayload, deps: RemoteDropDeps): Promise<Entry[]> {
  const stat = await deps.statAppFile(payload);
  if (stat.kind === 'failed') {
    deps.notify(DROP_COPY.resolveFailedTitle, stat.reason);
    return [];
  }
  const source = async (): Promise<UploadSource> => ({ kind: 'app-file', ...payload });
  return [{ name: stat.name, size: stat.size, isDirectory: stat.isDirectory, source }];
}

/** Drops folders and over-limit files with a toast each, before any byte is read (AC-D9, AC-U5). */
function sendable(entries: readonly Entry[], deps: RemoteDropDeps): Entry[] {
  return entries.filter((entry) => {
    if (entry.isDirectory) {
      deps.notify(REMOTE_UPLOAD_COPY.folderRefusedTitle(deps.hostName), entry.name);
      return false;
    }
    if (entry.size > MAX_STAGED_BYTES) {
      deps.notify(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail(entry.name));
      return false;
    }
    return true;
  });
}

/** One confirm per drop listing every file over 10 MB; true when there is none (Q2, OQ5). */
function confirmLarge(entries: readonly Entry[], deps: RemoteDropDeps): boolean {
  const large = entries.filter((entry) => entry.size > UPLOAD_CONFIRM_ABOVE_BYTES);
  if (large.length === 0) return true;
  const listed = large.map((entry) => ({ name: entry.name, size: formatUploadSize(entry.size) }));
  return deps.confirm(REMOTE_UPLOAD_COPY.confirmMessage(listed, deps.hostName));
}

/** Toast detail for a failed upload that has no copy of its own (refused, link lost, failed). */
export function uploadFailureDetail(result: UploadResult, hostName: string): string {
  if (result.kind === 'refused') {
    return result.reason === 'drop-folder-full'
      ? REMOTE_UPLOAD_COPY.dropFolderFullDetail(hostName)
      : REMOTE_UPLOAD_COPY.tooManyUploadsDetail(hostName);
  }
  if (result.kind === 'link-lost') return REMOTE_UPLOAD_COPY.linkLostDetail;
  return result.kind === 'failed' ? result.reason : result.kind;
}

/** Toasts one failed upload; returns true when the remaining files must not be attempted. */
function reportFailure(name: string, result: UploadResult, deps: RemoteDropDeps): boolean {
  const host = deps.hostName;
  if (result.kind === 'unsupported-host') {
    deps.notify(REMOTE_UPLOAD_COPY.sendFailedTitle(host), REMOTE_UPLOAD_COPY.oldHostDetail(host));
    return true;
  }
  if (result.kind === 'too-large') {
    deps.notify(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail(name));
  } else {
    deps.notify(REMOTE_UPLOAD_COPY.sendFileFailedTitle(name, host), uploadFailureDetail(result, host));
  }
  return false;
}

async function uploadEntry(entry: Entry, item: UploadItem, deps: RemoteDropDeps): Promise<UploadResult> {
  let source: UploadSource;
  try {
    source = await entry.source();
  } catch (err) {
    return { kind: 'failed', reason: errorMessage(err) };
  }
  return deps.upload(source, item, true);
}

/** Uploads in drop order with one file in flight (AC-D3); a cancel ends the whole drop (AC-D6). */
async function uploadAll(entries: readonly Entry[], deps: RemoteDropDeps): Promise<Outcome> {
  const paths: Staged[] = [];
  for (const [i, entry] of entries.entries()) {
    const item = { name: entry.name, index: i + 1, count: entries.length };
    const result = await uploadEntry(entry, item, deps);
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    if (result.kind === 'staged') paths.push({ path: result.path, style: result.style });
    else if (reportFailure(entry.name, result, deps)) break;
  }
  return { kind: 'staged', paths };
}

function payloadOf(paths: readonly Staged[]): string | null {
  const style = paths[0]?.style ?? 'posix';
  const sanitized = sanitizePaste(joinEscapedPaths(paths.map((p) => p.path), style));
  return sanitized === '' ? null : sanitized;
}

/** Plans a remote drop; resolves to the payload for `term.paste`, or null when nothing is typed. */
export async function planRemoteDrop<F extends DropFile>(
  snapshot: DropSnapshot<F>,
  deps: RemoteDropDeps,
): Promise<string | null> {
  const appFile = snapshot.appFile ? parseAppFile(snapshot.appFile) : null;
  if (!appFile && snapshot.files.length === 0) {
    const text = sanitizePaste(snapshot.text);
    return text === '' ? null : text;
  }
  const entries = appFile ? await appFileEntries(appFile, deps) : fileEntries(snapshot);
  const toSend = sendable(entries, deps);
  if (!confirmLarge(toSend, deps)) return null;
  const outcome = await uploadAll(toSend, deps);
  return outcome.kind === 'cancelled' ? null : payloadOf(outcome.paths);
}

/** The effects a remote drop needs beyond the upload itself. */
export type RemoteDropEffects = Pick<RemoteDropDeps, 'statAppFile' | 'confirm' | 'notify'>;

/** Runs `planRemoteDrop` as one upload batch on `target`'s tracker, closing it however it ends. */
export async function planRemoteDropOn<F extends DropFile>(
  snapshot: DropSnapshot<F>,
  target: RemoteTarget,
  effects: RemoteDropEffects,
): Promise<string | null> {
  const batch = target.uploads.batch(target.deviceId);
  try {
    return await planRemoteDrop(snapshot, { ...effects, hostName: target.hostName, upload: batch.upload });
  } finally {
    batch.end();
  }
}
