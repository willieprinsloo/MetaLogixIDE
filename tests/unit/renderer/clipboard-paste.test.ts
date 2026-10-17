import { describe, it, expect, vi } from 'vitest';
import { resolveClipboardPaste, type ClipboardPasteDeps } from '@renderer/clipboard-paste';
import {
  DROP_COPY,
  MAX_STAGED_BYTES,
  type ClipboardImageResult,
} from '@shared/terminal-drop-contract';

function deps(result: ClipboardImageResult | Error, style: ClipboardPasteDeps['style'] = 'posix') {
  const stageClipboardImage = vi.fn(async (): Promise<ClipboardImageResult> => {
    if (result instanceof Error) throw result;
    return result;
  });
  const notify = vi.fn<(title: string, detail: string) => void>();
  const d: ClipboardPasteDeps = { style, stageClipboardImage, notify };
  return { d, stageClipboardImage, notify };
}

const staged = (path: string): ClipboardImageResult => ({ kind: 'staged', path });

describe('resolveClipboardPaste with text (AC12)', () => {
  it('returns the text and never touches the clipboard image', async () => {
    const { d, stageClipboardImage } = deps(staged('/tmp/x.png'));
    await expect(resolveClipboardPaste('npm run build', d)).resolves.toBe('npm run build');
    expect(stageClipboardImage).not.toHaveBeenCalled();
  });

  it('sanitises control characters in the text (AC2)', async () => {
    const { d } = deps(staged('/tmp/x.png'));
    await expect(resolveClipboardPaste('x\x1b[201~y\x7f\tz\n', d)).resolves.toBe('x [201~y \tz\n');
  });

  it('treats whitespace-only text as text, not as an empty clipboard', async () => {
    const { d, stageClipboardImage } = deps(staged('/tmp/x.png'));
    await expect(resolveClipboardPaste(' ', d)).resolves.toBe(' ');
    expect(stageClipboardImage).not.toHaveBeenCalled();
  });
});

describe('resolveClipboardPaste with no text (AC12, AC13, AC14)', () => {
  it('stages the clipboard image and returns its escaped path', async () => {
    const { d, stageClipboardImage, notify } = deps(staged('/tmp/metaide drops/pasted-1.png'));
    await expect(resolveClipboardPaste('', d)).resolves.toBe('/tmp/metaide\\ drops/pasted-1.png');
    expect(stageClipboardImage).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('escapes the staged path in the injected style', async () => {
    const { d } = deps(staged('C:\\Temp\\metaide drops\\p.png'), 'windows');
    await expect(resolveClipboardPaste('', d)).resolves.toBe('"C:\\Temp\\metaide drops\\p.png"');
  });

  it('returns null with no toast when the clipboard has no image (AC13)', async () => {
    const { d, notify } = deps({ kind: 'no-image' });
    await expect(resolveClipboardPaste('', d)).resolves.toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('toasts the limit and returns null when the image is too large (AC14)', async () => {
    const { d, notify } = deps({ kind: 'too-large', limitBytes: MAX_STAGED_BYTES });
    await expect(resolveClipboardPaste('', d)).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(
      DROP_COPY.tooLargeTitle,
      DROP_COPY.tooLargeDetail('Clipboard image'),
    );
  });

  it('toasts the reason and returns null when staging fails', async () => {
    const { d, notify } = deps({ kind: 'failed', reason: 'unsafe drop directory' });
    await expect(resolveClipboardPaste('', d)).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(
      DROP_COPY.clipboardImageFailedTitle,
      'unsafe drop directory',
    );
  });

  it('toasts and returns null when the staging call rejects', async () => {
    const { d, notify } = deps(new Error('no handler for channel'));
    await expect(resolveClipboardPaste('', d)).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(
      DROP_COPY.clipboardImageFailedTitle,
      'no handler for channel',
    );
  });

  it('reports a non-Error rejection as its string form', async () => {
    const stageClipboardImage = vi.fn(() => Promise.reject('channel closed'));
    const notify = vi.fn<(title: string, detail: string) => void>();
    const d: ClipboardPasteDeps = { style: 'posix', stageClipboardImage, notify };
    await expect(resolveClipboardPaste('', d)).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.clipboardImageFailedTitle, 'channel closed');
  });
});
