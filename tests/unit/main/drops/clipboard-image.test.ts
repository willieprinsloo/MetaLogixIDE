import { describe, it, expect, vi } from 'vitest';
import { createClipboardImage, type ImageClipboard } from '@main/drops/clipboard-image';

describe('createClipboardImage().readPng', () => {
  it('ignores non-image formats without reading them', async () => {
    const getType = vi.fn(async () => new Blob(['text']));
    const source: ImageClipboard = { read: async () => [{ types: ['text/plain'], getType }] };
    await expect(createClipboardImage(source).readPng()).resolves.toBeNull();
    expect(getType).not.toHaveBeenCalled();
  });

  it('returns the PNG bytes without reading unrelated formats', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const getType = vi.fn(async () => new Blob([png], { type: 'image/png' }));
    const source: ImageClipboard = { read: async () => [{ types: ['text/plain', 'image/png'], getType }] };
    await expect(createClipboardImage(source).readPng()).resolves.toEqual(Buffer.from(png));
    expect(getType).toHaveBeenCalledTimes(1);
    expect(getType).toHaveBeenCalledWith('image/png');
  });

  it('ignores an empty PNG', async () => {
    const source: ImageClipboard = {
      read: async () => [{ types: ['image/png'], getType: async () => new Blob() }],
    };
    await expect(createClipboardImage(source).readPng()).resolves.toBeNull();
  });

  it('reads the clipboard lazily, on each call', async () => {
    const read = vi.fn(async () => []);
    const reader = createClipboardImage({ read });
    expect(read).not.toHaveBeenCalled();
    await reader.readPng();
    await reader.readPng();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('propagates read failures to the caller', async () => {
    const error = new Error('clipboard unavailable');
    const read = vi.fn().mockRejectedValue(error);
    await expect(createClipboardImage({ read }).readPng()).rejects.toBe(error);
  });
});
