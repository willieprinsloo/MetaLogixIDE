/**
 * `files:read-bytes` IPC — the image/PDF viewer depends on this. The
 * bytes it returns must be a standalone Uint8Array (owning its full
 * ArrayBuffer at offset 0), otherwise Electron's structured clone can
 * hand the renderer a view over Node's shared Buffer pool — the browser
 * then builds a Blob out of the wrong bytes and draws a broken-image
 * icon.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlers } from '@main/ipc/register';
import type { Services } from '@main/services';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeServices(projectPath: string): Services {
  return {
    projects: { get: (id: number) => (id === 7 ? { id: 7, path: projectPath, name: 'p' } : null) },
  } as unknown as Services;
}

describe('files:read-bytes', () => {
  it('returns bytes that own the whole ArrayBuffer (not a pool view)', async () => {
    // Several small reads from the same tmpdir force Node's Buffer pool
    // into use. A pool-allocated Buffer is a view over an ArrayBuffer
    // that's much larger than the file — structured clone can preserve
    // that, so the renderer's Blob ends up containing the pool, not the
    // file. The handler must own its own buffer at offset 0.
    const dir = mkdtempSync(join(tmpdir(), 'read-bytes-'));
    try {
      const file = join(dir, 'tiny.png');
      // 12 bytes: PNG signature + 4 arbitrary trailing bytes.
      const content = new Uint8Array([...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0d]);
      writeFileSync(file, content);
      // Prime the pool with a few unrelated small reads.
      for (let i = 0; i < 5; i++) {
        const other = join(dir, `other-${i}.bin`);
        writeFileSync(other, new Uint8Array([i, i, i]));
        await handlers['files:read-bytes'](makeServices(dir), { projectId: 7, relPath: `other-${i}.bin` });
      }
      const got = await handlers['files:read-bytes'](makeServices(dir), { projectId: 7, relPath: 'tiny.png' });
      // Standalone: the ArrayBuffer is exactly the file size, view at 0.
      expect(got.bytes.byteOffset).toBe(0);
      expect(got.bytes.buffer.byteLength).toBe(got.bytes.byteLength);
      expect(got.bytes.byteLength).toBe(content.byteLength);
      // And of course the content is right.
      expect(Array.from(got.bytes)).toEqual(Array.from(content));
      expect(got.mime).toBe('image/png');
      expect(got.sizeBytes).toBe(content.byteLength);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-bytes-'));
    try {
      await expect(
        handlers['files:read-bytes'](makeServices(dir), { projectId: 999, relPath: 'x.png' }),
      ).rejects.toThrow(/no project/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
