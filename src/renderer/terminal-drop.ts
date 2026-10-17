/**
 * Pure planner for terminal drops (AC6-AC11, AC14, AC15, AC20a). `planDrop` takes a synchronous
 * snapshot of a `DataTransfer` and returns the sanitised payload to hand to `term.paste`, or null
 * when nothing is usable. Precedence: the Files-tree drag type, then files, then `text/plain`.
 * Every side effect (path lookup, IPC resolve and staging, toasts) is injected through `DropDeps`.
 */
import { sanitizePaste } from '@shared/paste-sanitize';
import { joinEscapedPaths } from '@shared/shell-escape';
import {
  DROP_COPY,
  MAX_STAGED_BYTES,
  type AppFileDragPayload,
  type PathStyle,
  type ResolveAppFileResult,
  type StageFileRequest,
  type StageResult,
} from '@shared/terminal-drop-contract';

/** The part of a DOM `File` the planner reads. */
export interface DropFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** What the drop handler copies out of the `DataTransfer` before the event returns. */
export interface DropSnapshot<F extends DropFile> {
  readonly appFile: string;
  readonly files: readonly F[];
  readonly text: string;
}

/** Injected effects; `pathForFile` returns `''` for a file with no path on disk. */
export interface DropDeps<F extends DropFile> {
  readonly style: PathStyle;
  pathForFile(file: F): string;
  resolveAppFile(payload: AppFileDragPayload): Promise<ResolveAppFileResult>;
  stageFile(request: StageFileRequest): Promise<StageResult>;
  notify(title: string, detail: string): void;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function parseAppFile(raw: string): AppFileDragPayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { projectId, relPath } = value as Record<string, unknown>;
    if (!Number.isInteger(projectId) || typeof relPath !== 'string') return null;
    return { projectId: projectId as number, relPath };
  } catch {
    return null;
  }
}

async function resolveAppFilePath<F extends DropFile>(
  payload: AppFileDragPayload,
  deps: DropDeps<F>,
): Promise<string[]> {
  try {
    const result = await deps.resolveAppFile(payload);
    if (result.kind === 'resolved') return [result.path];
    deps.notify(DROP_COPY.resolveFailedTitle, result.reason);
  } catch (err) {
    deps.notify(DROP_COPY.resolveFailedTitle, errorMessage(err));
  }
  return [];
}

async function stageBytes<F extends DropFile>(file: F, deps: DropDeps<F>): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await deps.stageFile({ name: file.name, mime: file.type, bytes });
    if (result.kind === 'staged') return result.path;
    if (result.kind === 'too-large') {
      deps.notify(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail(file.name));
    } else {
      deps.notify(DROP_COPY.stageFailedTitle, result.reason);
    }
  } catch (err) {
    deps.notify(DROP_COPY.stageFailedTitle, errorMessage(err));
  }
  return null;
}

async function filePath<F extends DropFile>(file: F, deps: DropDeps<F>): Promise<string | null> {
  const path = deps.pathForFile(file);
  if (path) return path;
  if (file.size <= 0) return null;
  if (file.size > MAX_STAGED_BYTES) {
    deps.notify(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail(file.name));
    return null;
  }
  return stageBytes(file, deps);
}

/** Resolves files in drop order, one at a time, so at most one file's bytes are held (AC10). */
async function filePaths<F extends DropFile>(
  files: readonly F[],
  deps: DropDeps<F>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const path = await filePath(file, deps);
    if (path !== null) paths.push(path);
  }
  return paths;
}

/** Plans a drop; resolves to the payload for `term.paste`, or null when nothing is usable. */
export async function planDrop<F extends DropFile>(
  snapshot: DropSnapshot<F>,
  deps: DropDeps<F>,
): Promise<string | null> {
  const appFile = snapshot.appFile ? parseAppFile(snapshot.appFile) : null;
  let payload: string;
  if (appFile) {
    payload = joinEscapedPaths(await resolveAppFilePath(appFile, deps), deps.style);
  } else if (snapshot.files.length > 0) {
    payload = joinEscapedPaths(await filePaths(snapshot.files, deps), deps.style);
  } else {
    payload = snapshot.text;
  }
  const sanitized = sanitizePaste(payload);
  return sanitized === '' ? null : sanitized;
}
