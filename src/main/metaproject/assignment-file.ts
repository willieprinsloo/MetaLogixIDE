/** Bounded reads and synchronous compare-and-replace for the assignment file. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { editMetaprojectAssignment, parseAssignmentDocument } from '@shared/parse-metaproject';
import type { MetaprojectResult } from '@shared/metaproject-contract';
import { failure, ok } from './session-service';

const cap = 256 * 1024;
interface AssignmentFile {
  readonly root: string;
  readonly directory: string;
  readonly path: string;
  readonly revision: string;
  readonly mode: number;
  readonly document: NonNullable<ReturnType<typeof parseAssignmentDocument>>;
}

function errorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function safePath(root: string, directory: string): string | null {
  const sub = relative(resolve(root), resolve(directory));
  if (isAbsolute(sub) || sub === '..' || sub.startsWith(`..${sep}`)) return null;
  const expected = resolve(realpathSync(root), sub);
  if (realpathSync(directory) !== expected || !lstatSync(expected).isDirectory()) return null;
  return join(expected, '.metaproject.yaml');
}

function readBytes(path: string): { bytes: Buffer; identity: string; mode: number } | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (errorCode(error, 'ENOENT')) return { bytes: Buffer.alloc(0), identity: 'absent', mode: 0o600 };
    if (errorCode(error, 'ELOOP')) return null;
    throw error;
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > cap) return null;
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let n = 0;
    while (n < buffer.length) {
      const count = readSync(fd, buffer, n, buffer.length - n, n);
      if (!count) break;
      n += count;
    }
    const after = fstatSync(fd);
    if (n !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    return { bytes: buffer.subarray(0, n), identity: `${before.dev}:${before.ino}:${before.ctimeMs}`, mode: before.mode & 0o777 };
  } finally { closeSync(fd); }
}

/** Read a particular registered folder without following the assignment file as a link. */
export function readAssignmentFile(root: string, directory: string): MetaprojectResult<AssignmentFile> {
  try {
    const path = safePath(root, directory);
    if (!path) return failure('invalid-file');
    const entry = readBytes(path);
    if (!entry) return failure('invalid-file');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.bytes); }
    catch { return failure('invalid-file'); }
    const document = parseAssignmentDocument(text);
    if (!document) return failure('invalid-file');
    const dir = lstatSync(resolve(path, '..'));
    const revision = createHash('sha256').update(JSON.stringify([path, dir.dev, dir.ino, entry.identity])).update(entry.bytes).digest('hex');
    return ok({ root, directory, path, revision, mode: entry.mode, document });
  } catch { return failure('unavailable'); }
}

/** Stage and sync new bytes, then recheck ownership and the observed file before the one commit. */
export function commitAssignmentFile(file: AssignmentFile, link: Parameters<typeof editMetaprojectAssignment>[1], owns: () => boolean): MetaprojectResult<undefined> {
  if (!owns()) return failure('stale');
  const text = editMetaprojectAssignment(file.document, link);
  if (Buffer.byteLength(text) > cap || !parseAssignmentDocument(text)) return failure('invalid-file');
  const temp = resolve(file.path, '..', `.metaproject-${randomUUID()}.tmp`);
  let staged = false;
  try {
    const fd = openSync(temp, 'wx', file.mode);
    staged = true;
    try { writeFileSync(fd, text); fchmodSync(fd, file.mode); fsyncSync(fd); }
    finally { closeSync(fd); }
    const current = readAssignmentFile(file.root, file.directory);
    if (!current.ok || current.value.revision !== file.revision) return failure('conflict');
    if (!owns()) return failure('stale');
    renameSync(temp, file.path);
    staged = false;
    return ok(undefined);
  } catch { return failure('unavailable'); }
  finally {
    if (staged) {
      try { unlinkSync(temp); }
      catch { console.warn('[metaproject] could not remove staged assignment'); }
    }
  }
}
