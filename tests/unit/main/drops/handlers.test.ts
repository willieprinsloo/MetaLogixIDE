import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dropHandlers } from '@main/drops/handlers';
import { createDropStaging } from '@main/drops/staging';
import type { ClipboardImage } from '@main/drops/clipboard-image';
import type { Services } from '@main/services';
import type { Project } from '@shared/types';
import {
  MAX_STAGED_BYTES,
  type AppFileDragPayload,
  type StageFileRequest,
} from '@shared/terminal-drop-contract';

const NOW = new Date(Date.UTC(2026, 9, 17, 9, 5, 7, 42));
const posix = process.platform !== 'win32';

let root: string;
let projectRoot: string;
let dropDir: string;
let clipboardPng: Buffer | null;

function project(id: number, path: string): Project {
  return { id, path } as Project;
}

function services(): Services {
  const projects = new Map<number, Project>([[7, project(7, projectRoot)]]);
  const clipboardImage: ClipboardImage = { readPng: () => clipboardPng };
  return {
    projects: { get: (id: number) => projects.get(id) ?? null },
    dropStaging: createDropStaging({
      dir: dropDir,
      now: () => NOW,
      uid: posix ? process.getuid!() : null,
    }),
    clipboardImage,
  } as unknown as Services;
}

const resolveAppFile = (req: unknown) =>
  dropHandlers['drops:resolve-app-file'](services(), req as AppFileDragPayload);
const stageFile = (req: unknown) =>
  dropHandlers['drops:stage-file'](services(), req as StageFileRequest);
const stageClipboard = () => dropHandlers['drops:stage-clipboard-image'](services(), undefined);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drops-handlers-'));
  projectRoot = join(root, 'proj');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(join(root, 'proj-evil'));
  dropDir = join(root, 'drops');
  clipboardPng = null;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('drops:resolve-app-file (AC7)', () => {
  it('resolves a project-relative path to the absolute path under the project root', async () => {
    await expect(resolveAppFile({ projectId: 7, relPath: 'src/main.ts' })).resolves.toEqual({
      kind: 'resolved',
      path: resolve(projectRoot, 'src/main.ts'),
    });
  });

  it('normalises a relPath that dips out and back in', async () => {
    await expect(resolveAppFile({ projectId: 7, relPath: 'src/../README.md' })).resolves.toEqual({
      kind: 'resolved',
      path: resolve(projectRoot, 'README.md'),
    });
  });

  it('accepts a file whose name merely starts with two dots', async () => {
    await expect(resolveAppFile({ projectId: 7, relPath: '..config' })).resolves.toEqual({
      kind: 'resolved',
      path: resolve(projectRoot, '..config'),
    });
  });

  const escapes: Array<[string, string]> = [
    ['parent traversal', '../x'],
    ['bare parent', '..'],
    ['sibling-prefix project', '../proj-evil/x'],
    ['deep traversal', 'src/../../proj-evil/x'],
    ['absolute path', '/etc/passwd'],
  ];

  it.each(escapes)('rejects %s (%s) with a failed value', async (_label, relPath) => {
    const result = await resolveAppFile({ projectId: 7, relPath });
    expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/outside|absolute/) });
  });

  it('rejects an absolute relPath even when it points inside the project', async () => {
    const result = await resolveAppFile({
      projectId: 7,
      relPath: join(projectRoot, 'src/main.ts'),
    });
    expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/absolute/) });
  });

  it('rejects an unknown projectId', async () => {
    await expect(resolveAppFile({ projectId: 99, relPath: 'a' })).resolves.toEqual({
      kind: 'failed',
      reason: expect.stringMatching(/unknown project/),
    });
  });

  const malformed: Array<[string, unknown]> = [
    ['a non-integer projectId', { projectId: 7.5, relPath: 'a' }],
    ['a string projectId', { projectId: '7', relPath: 'a' }],
    ['a non-string relPath', { projectId: 7, relPath: 42 }],
    ['a missing relPath', { projectId: 7 }],
    ['null', null],
    ['a non-object', 'proj/a'],
  ];

  it.each(malformed)('rejects %s as an invalid request', async (_label, req) => {
    await expect(resolveAppFile(req)).resolves.toEqual({
      kind: 'failed',
      reason: expect.stringMatching(/invalid/),
    });
  });
});

describe('drops:stage-file (AC9, AC14, AC15)', () => {
  it('stages the bytes under the sanitised name and returns the path', async () => {
    const result = await stageFile({
      name: 'a<b>|c.png',
      mime: 'image/png',
      bytes: new Uint8Array([1, 2]),
    });
    expect(result).toEqual({ kind: 'staged', path: resolve(dropDir, 'a_b__c.png') });
    expect([...readFileSync(resolve(dropDir, 'a_b__c.png'))]).toEqual([1, 2]);
  });

  it('accepts a name and MIME at their length limits', async () => {
    const result = await stageFile({
      name: 'n'.repeat(1024),
      mime: 'm'.repeat(255),
      bytes: new Uint8Array([1]),
    });
    expect(result.kind).toBe('staged');
  });

  const malformed: Array<[string, unknown]> = [
    ['a non-string name', { name: 1, mime: 'image/png', bytes: new Uint8Array(1) }],
    [
      'a name over 1024 characters',
      { name: 'n'.repeat(1025), mime: 'image/png', bytes: new Uint8Array(1) },
    ],
    ['a non-string mime', { name: 'a', mime: null, bytes: new Uint8Array(1) }],
    ['a mime over 255 characters', { name: 'a', mime: 'm'.repeat(256), bytes: new Uint8Array(1) }],
    ['bytes as a plain array', { name: 'a', mime: 'image/png', bytes: [1, 2] }],
    ['bytes as an ArrayBuffer', { name: 'a', mime: 'image/png', bytes: new ArrayBuffer(2) }],
    ['missing bytes', { name: 'a', mime: 'image/png' }],
    ['null', null],
  ];

  it.each(malformed)('rejects %s with a failed value and writes nothing', async (_label, req) => {
    await expect(stageFile(req)).resolves.toEqual({
      kind: 'failed',
      reason: expect.stringMatching(/invalid/),
    });
    expect(existsSync(dropDir)).toBe(false);
  });

  it('returns too-large for an over-limit length and writes nothing', async () => {
    const result = await stageFile({
      name: 'big.bin',
      mime: 'application/octet-stream',
      bytes: new Uint8Array(MAX_STAGED_BYTES + 1),
    });
    expect(result).toEqual({ kind: 'too-large', limitBytes: MAX_STAGED_BYTES });
    expect(existsSync(dropDir)).toBe(false);
  });

  it.skipIf(!posix)('returns a failed value when the drop directory is untrusted', async () => {
    mkdirSync(dropDir);
    chmodSync(dropDir, 0o755);
    const result = await stageFile({
      name: 'a.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });
    expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/mode/) });
    expect(readdirSync(dropDir)).toEqual([]);
  });
});

describe('drops:stage-clipboard-image (AC12, AC13, AC14)', () => {
  it('returns no-image when the clipboard has no image, and writes nothing', async () => {
    await expect(stageClipboard()).resolves.toEqual({ kind: 'no-image' });
    expect(existsSync(dropDir)).toBe(false);
  });

  it('stages the clipboard PNG as pasted-<ts>.png', async () => {
    clipboardPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await stageClipboard();
    const expected = resolve(dropDir, 'pasted-20261017-090507-042.png');
    expect(result).toEqual({ kind: 'staged', path: expected });
    expect(readFileSync(expected)).toEqual(clipboardPng);
  });

  it('returns too-large for a PNG over the cap and writes nothing', async () => {
    clipboardPng = Buffer.alloc(MAX_STAGED_BYTES + 1);
    await expect(stageClipboard()).resolves.toEqual({
      kind: 'too-large',
      limitBytes: MAX_STAGED_BYTES,
    });
    expect(existsSync(dropDir)).toBe(false);
  });

  it('turns a clipboard read error into a failed value', async () => {
    const s = services();
    s.clipboardImage = {
      readPng: () => {
        throw new Error('clipboard unavailable');
      },
    };
    await expect(dropHandlers['drops:stage-clipboard-image'](s, undefined)).resolves.toEqual({
      kind: 'failed',
      reason: 'clipboard unavailable',
    });
  });
});
