import { describe, it, expect, vi } from 'vitest';
import { createClipboardImage, type ImageClipboard } from '@main/drops/clipboard-image';

function source(image: {
  empty: boolean;
  png?: Buffer;
}): ImageClipboard & { readImage: ReturnType<typeof vi.fn> } {
  return {
    readImage: vi.fn(() => ({
      isEmpty: () => image.empty,
      toPNG: () => image.png ?? Buffer.alloc(0),
    })),
  };
}

describe('createClipboardImage().readPng', () => {
  it('returns null when the clipboard holds no image', () => {
    expect(createClipboardImage(source({ empty: true })).readPng()).toBeNull();
  });

  it('returns the PNG encoding of the clipboard image', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(createClipboardImage(source({ empty: false, png })).readPng()).toEqual(png);
  });

  it('reads the clipboard lazily, on each call', () => {
    const src = source({ empty: true });
    const reader = createClipboardImage(src);
    expect(src.readImage).not.toHaveBeenCalled();
    reader.readPng();
    reader.readPng();
    expect(src.readImage).toHaveBeenCalledTimes(2);
  });
});
