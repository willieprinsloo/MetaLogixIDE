/**
 * IPC handlers for terminal drop and clipboard image paste. Each one guards
 * its untrusted request shape by hand (repo convention, no schema library),
 * then delegates to `Services.dropStaging` or the project repo. Expected
 * failures come back as typed result values; nothing here throws to the
 * renderer, because Electron strips thrown errors of their identity.
 */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import log from 'electron-log/main';
import type { Handler } from '@main/ipc/register';
import { isInsideRoot } from '@main/domain/path-containment';
import type { Services } from '@main/services';
import type { StatAppFileResult } from '@shared/remote-upload-contract';
import type {
  AppFileDragPayload,
  ClipboardImageResult,
  ResolveAppFileResult,
  StageFileRequest,
} from '@shared/terminal-drop-contract';

type DropChannel =
  | 'drops:resolve-app-file'
  | 'drops:stage-file'
  | 'drops:stage-clipboard-image'
  | 'drops:stat-app-file';

/** A located Files-tree file: `StatAppFileResult` plus the absolute path, for main-process readers only. */
export type LocatedAppFile =
  | { readonly kind: 'ok'; readonly path: string; readonly name: string; readonly size: number; readonly isDirectory: boolean }
  | { readonly kind: 'failed'; readonly reason: string };

const MAX_NAME_CHARS = 1024;
const MAX_MIME_CHARS = 255;

/** Narrows an untrusted value to a plain object whose fields can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True when `req` is a well-formed Files-tree drag payload. */
function isAppFilePayload(req: unknown): req is AppFileDragPayload {
  return isRecord(req) && Number.isInteger(req.projectId) && typeof req.relPath === 'string';
}

/** True when `req` is a well-formed stage-file request within the field length limits. */
function isStageFileRequest(req: unknown): req is StageFileRequest {
  return (
    isRecord(req) &&
    typeof req.name === 'string' &&
    req.name.length <= MAX_NAME_CHARS &&
    typeof req.mime === 'string' &&
    req.mime.length <= MAX_MIME_CHARS &&
    req.bytes instanceof Uint8Array
  );
}

/**
 * Resolves `relPath` against `root` and returns the absolute path only when
 * it stays inside `root`, judged by the shared `isInsideRoot` rule so drops
 * and the Files handlers cannot disagree about containment.
 */
export function resolveWithinRoot(root: string, relPath: string): ResolveAppFileResult {
  if (isAbsolute(relPath)) return { kind: 'failed', reason: 'relPath must not be absolute' };
  const abs = resolve(root, relPath);
  return isInsideRoot(root, abs)
    ? { kind: 'resolved', path: abs }
    : { kind: 'failed', reason: 'relPath resolves outside the project' };
}

/**
 * Resolves a Files-tree drag payload with the same containment as
 * `drops:resolve-app-file` and stats it (symlinks followed, as a read would).
 * The absolute path never goes back to the renderer; the upload client uses it
 * to read the file in main (AC-D2).
 */
export async function locateAppFile(s: Pick<Services, 'projects'>, req: unknown): Promise<LocatedAppFile> {
  if (!isAppFilePayload(req)) return { kind: 'failed', reason: 'invalid request' };
  const project = s.projects.get(req.projectId);
  if (!project) return { kind: 'failed', reason: `unknown project ${req.projectId}` };
  const resolved = resolveWithinRoot(project.path, req.relPath);
  if (resolved.kind === 'failed') return resolved;
  try {
    const st = await stat(resolved.path);
    return { kind: 'ok', path: resolved.path, name: basename(resolved.path), size: st.size, isDirectory: st.isDirectory() };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Logs a non-staged outcome at debug, so failed drops leave a trace without
 * the file contents. These are user-driven validation outcomes — invalid
 * request, unknown project, path outside project, too-large — surfaced to
 * the renderer as toasts; warn would flood the log on every rejected drop
 * (logs showed 700+ of these last week, kept at debug deliberately).
 */
function logged<R extends ClipboardImageResult | ResolveAppFileResult | StatAppFileResult>(
  op: DropChannel,
  result: R,
): R {
  if (result.kind === 'failed' || result.kind === 'too-large')
    log.debug(`[drops] ${op} ${result.kind}`, result);
  return result;
}

/** IPC handlers for terminal drop and clipboard image paste. */
export const dropHandlers: { [C in DropChannel]: Handler<C> } = {
  'drops:resolve-app-file': async (s, req) => {
    if (!isAppFilePayload(req))
      return logged('drops:resolve-app-file', { kind: 'failed', reason: 'invalid request' });
    const project = s.projects.get(req.projectId);
    if (!project)
      return logged('drops:resolve-app-file', {
        kind: 'failed',
        reason: `unknown project ${req.projectId}`,
      });
    return logged('drops:resolve-app-file', resolveWithinRoot(project.path, req.relPath));
  },
  'drops:stage-file': async (s, req) => {
    if (!isStageFileRequest(req))
      return logged('drops:stage-file', { kind: 'failed', reason: 'invalid request' });
    return logged('drops:stage-file', await s.dropStaging.stage(req.name, req.mime, req.bytes));
  },
  'drops:stage-clipboard-image': async (s) => {
    let png: Buffer | null;
    try {
      png = s.clipboardImage.readPng();
    } catch (err) {
      // "clipboard unavailable" is the normal case when nothing clipboard-
      // worthy is there (or Electron hasn't surfaced it to the renderer
      // yet); the renderer treats it as "nothing to paste". Keep the trace
      // for forensic needs but not at error — those were 32 noisy lines a
      // week for a case that is not a bug.
      const reason = err instanceof Error ? err.message : String(err);
      log.debug('[drops] clipboard image read failed', err);
      return { kind: 'failed', reason };
    }
    if (png === null) return { kind: 'no-image' };
    return logged('drops:stage-clipboard-image', await s.dropStaging.stagePastedImage(png));
  },
  'drops:stat-app-file': async (s, req) => {
    const located = await locateAppFile(s, req);
    if (located.kind === 'failed') return logged('drops:stat-app-file', located);
    return { kind: 'ok', name: located.name, size: located.size, isDirectory: located.isDirectory };
  },
};
