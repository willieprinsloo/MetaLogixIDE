/** Reads the system clipboard's PNG representation for terminal image paste. */
import { clipboard } from 'electron';

/** The slice of Electron's `Clipboard` this adapter needs; tests supply a fake. */
export interface ImageClipboard {
  read(): Promise<readonly { readonly types: readonly string[]; getType(type: 'image/png'): Promise<Blob | Electron.ClipboardBookmark> }[]>;
}

export interface ClipboardImage {
  /** PNG bytes of the clipboard image, or null when the clipboard holds no image. */
  readPng(): Promise<Buffer | null>;
}

/** Builds the clipboard image reader over `source` (Electron's clipboard by default); reads lazily per call. */
export function createClipboardImage(source: ImageClipboard = clipboard): ClipboardImage {
  return {
    async readPng(): Promise<Buffer | null> {
      const image = (await source.read()).find((item) => item.types.includes('image/png'));
      if (!image) return null;
      const png = await image.getType('image/png');
      return png instanceof Blob && png.size > 0 ? Buffer.from(await png.arrayBuffer()) : null;
    },
  };
}
