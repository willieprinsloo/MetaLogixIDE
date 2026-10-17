/**
 * Pure resolver behind every terminal paste route: the capture-phase `paste` event, the
 * Ctrl+Shift+V key path and the context-menu Paste item (AC12, AC12a, AC13, AC14). Clipboard text
 * is sanitised and returned; an empty clipboard asks the main process to stage a clipboard image
 * and returns its escaped path; neither yields null. Effects are injected through
 * `ClipboardPasteDeps`. `installPasteInterceptor` is the DOM-free wiring of the capture-phase listener.
 */
import { sanitizePaste } from '@shared/paste-sanitize';
import { escapePath } from '@shared/shell-escape';
import {
  DROP_COPY,
  type ClipboardImageResult,
  type PathStyle,
} from '@shared/terminal-drop-contract';

/** Injected effects; `stageClipboardImage` wraps the `drops:stage-clipboard-image` channel. */
export interface ClipboardPasteDeps {
  readonly style: PathStyle;
  stageClipboardImage(): Promise<ClipboardImageResult>;
  notify(title: string, detail: string): void;
}

const CLIPBOARD_IMAGE_NAME = 'Clipboard image';

async function stagedImagePath(deps: ClipboardPasteDeps): Promise<string | null> {
  try {
    const result = await deps.stageClipboardImage();
    if (result.kind === 'staged') return escapePath(result.path, deps.style);
    if (result.kind === 'too-large') {
      deps.notify(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail(CLIPBOARD_IMAGE_NAME));
    } else if (result.kind === 'failed') {
      deps.notify(DROP_COPY.clipboardImageFailedTitle, result.reason);
    }
  } catch (err) {
    deps.notify(
      DROP_COPY.clipboardImageFailedTitle,
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

/** Resolves clipboard text to the payload for `term.paste`, or null when there is nothing to paste. */
export async function resolveClipboardPaste(
  text: string,
  deps: ClipboardPasteDeps,
): Promise<string | null> {
  if (text !== '') return sanitizePaste(text);
  return stagedImagePath(deps);
}

/** Binds `resolveClipboardPaste` to a paste sink; `paste` is only ever called with a non-empty payload. */
export function createPasteFromText(
  deps: ClipboardPasteDeps,
  paste: (text: string) => void,
): (text: string) => Promise<void> {
  return async (text) => {
    const payload = await resolveClipboardPaste(text, deps);
    if (payload) paste(payload);
  };
}

const CAPTURE = { capture: true } as const;

type PasteEvent = Event & { readonly clipboardData?: { getData(type: string): string } | null };

/**
 * Installs a capture-phase `paste` listener on `host` that runs before xterm's own textarea
 * listener, cancels the event, stops it reaching xterm, and routes the clipboard text through
 * `pasteFromText`; a rejection goes to `onError`. Returns a disposer.
 */
export function installPasteInterceptor(
  host: EventTarget,
  pasteFromText: (text: string) => Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  const onPaste = (e: PasteEvent) => {
    e.preventDefault();
    e.stopPropagation();
    pasteFromText(e.clipboardData?.getData('text/plain') ?? '').catch(onError);
  };
  host.addEventListener('paste', onPaste, CAPTURE);
  return () => host.removeEventListener('paste', onPaste, CAPTURE);
}
