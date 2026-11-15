/**
 * Owner-only staging directory for dropped bytes and pasted clipboard images
 * (spec AC9, AC14, AC15, AC17, AC18). Every write re-verifies the directory
 * (real directory, not a symlink, owned by the current uid, mode exactly
 * 0700 on POSIX) and creates files exclusively with mode 0600, so a hostile
 * pre-created directory or a planted symlink in a shared temp dir is never
 * followed. Expected failures are returned as values, never thrown. All I/O
 * is `fs/promises` so the main process never blocks on disk.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, copyFile, link, lstat, mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { MAX_STAGED_BYTES, type StageResult } from '@shared/terminal-drop-contract';
import { MAX_NAME_LENGTH, pastedImageName, safeFileName } from './file-name';

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const MAX_NAME_ATTEMPTS = 100;

/** Staged files older than this are removed by the once-per-launch startup prune (AC18). */
export const DROP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DropStagingOptions {
  /** Absolute staging directory, resolved once by the composition root. */
  readonly dir: string;
  readonly now: () => Date;
  /** Current uid for the ownership check; null on Windows, where the checks are skipped. */
  readonly uid: number | null;
}

export interface PruneSummary {
  readonly removed: number;
  readonly failed: number;
}

/** What a finished upload is staged as: a sanitised file name, or `pasted-<timestamp>.png`. */
export type UploadKind = 'file' | 'clipboard-image';

/**
 * One in-progress upload, written chunk by chunk to a hidden `.part` file in the
 * staging directory so the bytes are never held whole in memory (R2). Exactly one
 * of `commit` or `abort` finishes it; afterwards `append` rejects and `abort` is a no-op.
 */
export interface UploadSink {
  /** Appends `bytes` at the end of the temp file. */
  append(bytes: Uint8Array): Promise<void>;
  /** Re-verifies the directory, then links the temp file under a free final name without clobbering. */
  commit(name: string, mime: string, kind: UploadKind): Promise<StageResult>;
  /** Removes the temp file; the directory is left as it was before `openUpload`. */
  abort(): Promise<void>;
}

export type OpenUploadResult =
  | { readonly kind: 'open'; readonly sink: UploadSink }
  | { readonly kind: 'failed'; readonly reason: string };

export interface DropStaging {
  readonly dir: string;
  /** Writes `bytes` under a sanitised form of `name`; `mime` picks the fallback extension. */
  stage(name: string, mime: string, bytes: Uint8Array): Promise<StageResult>;
  /** Writes a clipboard PNG as `pasted-<timestamp>.png`. */
  stagePastedImage(png: Uint8Array): Promise<StageResult>;
  /** Removes regular files older than `maxAgeMs`; rejects when the directory exists but is untrusted. */
  pruneOlderThan(maxAgeMs: number): Promise<PruneSummary>;
  /** Opens an exclusive owner-only temp file for a chunked upload. */
  openUpload(): Promise<OpenUploadResult>;
  /** Bytes held by regular files in the directory, `.part` files included; rejects when it is untrusted. */
  usageBytes(): Promise<number>;
}

/** Default staging location: `<tmp>/metaide-drops-<uid>` on POSIX, `<tmp>/metaide-drops` on Windows. */
export function defaultDropDir(platform: string, tmp: string, uid: number | null): string {
  return platform === 'win32' || uid === null
    ? join(tmp, 'metaide-drops')
    : join(tmp, `metaide-drops-${uid}`);
}

/** Node errno code of `err`, or undefined when it carries none. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/** Human-readable reason for a failed result. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Returns why the directory at `dir` must not be trusted, or null when it is safe to use. */
async function untrustedReason(dir: string, uid: number | null): Promise<string | null> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) return `drop directory ${dir} is a symlink`;
  if (!st.isDirectory()) return `drop directory ${dir} is not a directory`;
  if (uid === null) return null;
  if (st.uid !== uid) return `drop directory ${dir} is owned by uid ${st.uid}, not ${uid}`;
  const mode = st.mode & 0o777;
  if (mode !== OWNER_ONLY_DIR)
    return `drop directory ${dir} has mode ${mode.toString(8)}, expected 700`;
  return null;
}

/** Creates the directory when missing, then verifies it; returns a refusal reason or null. */
async function ensureTrustedDir(dir: string, uid: number | null): Promise<string | null> {
  try {
    await mkdir(dir, { mode: OWNER_ONLY_DIR });
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
  }
  return untrustedReason(dir, uid);
}

/**
 * The `attempt`-th candidate name: `shot.png`, then `shot-1.png`, `shot-2.png`,
 * and so on. The stem is trimmed so the suffixed name stays within
 * `MAX_NAME_LENGTH` and keeps its extension; when the extension leaves no room
 * for a stem, the whole name is trimmed and suffixed instead.
 */
function candidateName(name: string, attempt: number): string {
  if (attempt === 0) return name;
  const suffix = `-${attempt}`;
  const ext = extname(name);
  const stemRoom = MAX_NAME_LENGTH - suffix.length - ext.length;
  if (stemRoom < 1) return `${name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
  return `${name.slice(0, Math.min(name.length - ext.length, stemRoom))}${suffix}${ext}`;
}

/** Writes `bytes` to `path` only if it does not exist; on a write error the partial file is removed and the write error is rethrown. */
async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', OWNER_ONLY_FILE);
  try {
    await handle.writeFile(bytes);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw err;
  }
  await handle.close();
}

/** Writes under the first free candidate name and returns its path; throws when every candidate is taken. */
async function writeUnderFreeName(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const path = join(dir, candidateName(name, attempt));
    try {
      await writeExclusive(path, bytes);
      return path;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
    }
  }
  throw new Error(`no free file name for ${name} after ${MAX_NAME_ATTEMPTS} attempts`);
}

/** Removes `path` when it is a regular file last modified before `cutoffMs`; returns whether it was removed. */
async function pruneEntry(path: string, cutoffMs: number): Promise<boolean> {
  const st = await lstat(path);
  if (!st.isFile() || st.mtimeMs >= cutoffMs) return false;
  await unlink(path);
  return true;
}

/** Errno codes for which a hard link is impossible on the target filesystem (FAT, exFAT), so a copy is used (risk R-B). */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

/** Creates `path` as a copy of `temp` only if `path` does not exist; never overwrites. */
async function placeExclusive(temp: string, path: string): Promise<void> {
  try {
    await link(temp, path);
  } catch (err) {
    if (!NO_HARD_LINK.has(errorCode(err) ?? '')) throw err;
    await copyFile(temp, path, fsConstants.COPYFILE_EXCL);
  }
}

/** Places `temp` under the first free candidate of `name` and returns its path; throws when every candidate is taken. */
async function placeUnderFreeName(dir: string, name: string, temp: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const path = join(dir, candidateName(name, attempt));
    try {
      await placeExclusive(temp, path);
      return path;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
    }
  }
  throw new Error(`no free file name for ${name} after ${MAX_NAME_ATTEMPTS} attempts`);
}

/** Size of `path` when it is a regular file, else 0; a file removed meanwhile counts as 0. */
async function regularFileBytes(path: string): Promise<number> {
  try {
    const st = await lstat(path);
    return st.isFile() ? st.size : 0;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Upload sink over an open temp file. `finalName` picks the staged name at commit
 * time and `verifyDir` re-runs the trust check, so a directory swapped mid-upload
 * is refused before anything is linked into it.
 */
function createUploadSink(
  dir: string,
  temp: string,
  handle: FileHandle,
  finalName: (name: string, mime: string, kind: UploadKind) => string,
  verifyDir: () => Promise<string | null>,
): UploadSink {
  let finished = false;
  const finish = async (): Promise<void> => {
    finished = true;
    await handle.close().catch(() => undefined);
  };
  const discard = async (): Promise<void> => {
    await finish();
    await unlink(temp).catch(() => undefined);
  };

  async function commit(name: string, mime: string, kind: UploadKind): Promise<StageResult> {
    if (finished) return { kind: 'failed', reason: 'upload already finished' };
    try {
      await finish();
      const refusal = await verifyDir();
      if (refusal !== null) return { kind: 'failed', reason: refusal };
      return { kind: 'staged', path: await placeUnderFreeName(dir, finalName(name, mime, kind), temp) };
    } catch (err) {
      return { kind: 'failed', reason: reasonOf(err) };
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  return {
    append: async (bytes) => {
      if (finished) throw new Error('upload already finished');
      await handle.write(bytes);
    },
    commit,
    abort: async () => {
      if (!finished) await discard();
    },
  };
}

/** Builds the staging service over `opts.dir`; nothing touches disk until the first call. */
export function createDropStaging(opts: DropStagingOptions): DropStaging {
  const dir = resolve(opts.dir);

  async function writeStaged(fileName: string, bytes: Uint8Array): Promise<StageResult> {
    if (bytes.byteLength > MAX_STAGED_BYTES)
      return { kind: 'too-large', limitBytes: MAX_STAGED_BYTES };
    try {
      const refusal = await ensureTrustedDir(dir, opts.uid);
      if (refusal !== null) return { kind: 'failed', reason: refusal };
      return { kind: 'staged', path: await writeUnderFreeName(dir, fileName, bytes) };
    } catch (err) {
      return { kind: 'failed', reason: reasonOf(err) };
    }
  }

  async function pruneOlderThan(maxAgeMs: number): Promise<PruneSummary> {
    let names: string[];
    try {
      const refusal = await untrustedReason(dir, opts.uid);
      if (refusal !== null) throw new Error(`refusing to prune: ${refusal}`);
      names = await readdir(dir);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return { removed: 0, failed: 0 };
      throw err;
    }
    const cutoffMs = opts.now().getTime() - maxAgeMs;
    const outcomes = await Promise.allSettled(names.map((n) => pruneEntry(join(dir, n), cutoffMs)));
    return {
      removed: outcomes.filter((o) => o.status === 'fulfilled' && o.value).length,
      failed: outcomes.filter((o) => o.status === 'rejected').length,
    };
  }

  const finalName = (name: string, mime: string, kind: UploadKind): string =>
    kind === 'clipboard-image' ? pastedImageName(opts.now()) : safeFileName(name, mime, opts.now());

  async function openUpload(): Promise<OpenUploadResult> {
    try {
      const refusal = await ensureTrustedDir(dir, opts.uid);
      if (refusal !== null) return { kind: 'failed', reason: refusal };
      // A leading dot never survives safeFileName, so a temp name cannot collide with a staged one.
      const temp = join(dir, `.${randomBytes(12).toString('hex')}.part`);
      const handle = await open(temp, 'wx', OWNER_ONLY_FILE);
      const sink = createUploadSink(dir, temp, handle, finalName, () => untrustedReason(dir, opts.uid));
      return { kind: 'open', sink };
    } catch (err) {
      return { kind: 'failed', reason: reasonOf(err) };
    }
  }

  async function usageBytes(): Promise<number> {
    let names: string[];
    try {
      const refusal = await untrustedReason(dir, opts.uid);
      if (refusal !== null) throw new Error(`refusing to measure: ${refusal}`);
      names = await readdir(dir);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return 0;
      throw err;
    }
    const sizes = await Promise.all(names.map((n) => regularFileBytes(join(dir, n))));
    return sizes.reduce((sum, n) => sum + n, 0);
  }

  return {
    dir,
    stage: (name, mime, bytes) => writeStaged(safeFileName(name, mime, opts.now()), bytes),
    stagePastedImage: (png) => writeStaged(pastedImageName(opts.now()), png),
    pruneOlderThan,
    openUpload,
    usageBytes,
  };
}

/**
 * Drop directory override for E2E runs. In test mode (`METAIDE_TEST_MODE=1`)
 * returns `METAIDE_DROP_DIR` when set, otherwise `<userDataDir>/drops`, so a
 * test launch never stages into or prunes the real user drop directory.
 * Returns undefined outside test mode. Read once at the entrypoint.
 */
export function testModeDropDir(env: Readonly<Record<string, string | undefined>>, userDataDir: string): string | undefined {
  if (env.METAIDE_TEST_MODE !== '1') return undefined;
  return env.METAIDE_DROP_DIR || join(userDataDir, 'drops');
}
