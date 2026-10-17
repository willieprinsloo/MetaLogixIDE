/**
 * Wrapper over Electron's main-process clipboard for image paste (spec AC12,
 * AC13). The renderer is sandboxed and cannot read clipboard images, so the
 * main process reads them here behind one intent-named call. `toPNG()` is
 * synchronous on the main thread (about 100 ms for a 5K screenshot); that is
 * accepted because paste is a one-off user action and Electron offers no
 * async API.
 */
import { clipboard } from 'electron';

/** The slice of Electron's `Clipboard` this adapter needs; tests supply a fake. */
export interface ImageClipboard {
  readImage(): { isEmpty(): boolean; toPNG(): Buffer };
}

export interface ClipboardImage {
  /** PNG bytes of the clipboard image, or null when the clipboard holds no image. */
  readPng(): Buffer | null;
}

/** Builds the clipboard image reader over `source` (Electron's clipboard by default); reads lazily per call. */
export function createClipboardImage(source: ImageClipboard = clipboard): ClipboardImage {
  return {
    readPng: () => {
      const image = source.readImage();
      return image.isEmpty() ? null : image.toPNG();
    },
  };
}
