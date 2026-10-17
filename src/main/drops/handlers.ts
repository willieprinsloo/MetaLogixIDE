/**
 * IPC handlers for terminal drop and clipboard image paste. Each one guards
 * its untrusted request shape by hand (repo convention, no schema library),
 * then delegates to `Services.dropStaging` or the project repo. Expected
 * failures come back as typed result values; nothing here throws to the
 * renderer, because Electron strips thrown errors of their identity.
 */
import { isAbsolute, resolve } from 'node:path';
import log from 'electron-log/main';
import type { Handler } from '@main/ipc/register';
import { isInsideRoot } from '@main/domain/path-containment';
import type {
  AppFileDragPayload,
  ClipboardImageResult,
  ResolveAppFileResult,
  StageFileRequest,
} from '@shared/terminal-drop-contract';

type DropChannel = 'drops:resolve-app-file' | 'drops:stage-file' | 'drops:stage-clipboard-image';

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

/** Logs a non-staged outcome at warn, so failed drops leave a trace without the file contents. */
function logged<R extends ClipboardImageResult | ResolveAppFileResult>(
  op: DropChannel,
  result: R,
): R {
  if (result.kind === 'failed' || result.kind === 'too-large')
    log.warn(`[drops] ${op} ${result.kind}`, result);
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
      const reason = err instanceof Error ? err.message : String(err);
      log.error('[drops] clipboard image read failed', err);
      return { kind: 'failed', reason };
    }
    if (png === null) return { kind: 'no-image' };
    return logged('drops:stage-clipboard-image', await s.dropStaging.stagePastedImage(png));
  },
};
