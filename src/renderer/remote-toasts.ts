import { toast } from '@renderer/hooks/useToasts';
import { REMOTE_INPUT_COPY, SHORTCUT_COPY } from '@renderer/shortcut-copy';
import type { InputError } from '@renderer/p2p/input-queue';
import { errMessage } from '@renderer/p2p/err-message';
import { createToastThrottle } from './toast-throttle';

const TOAST_WINDOW_MS = 5000;

/**
 * Subscribes a remote shell handle's input errors to error toasts naming the host (read lazily
 * through `hostName`), at most one toast per error kind per 5 s.
 */
export function subscribeRemoteInputToasts(
  remote: { onInputError(cb: (e: InputError) => void): void },
  hostName: () => string,
): void {
  const throttle = createToastThrottle({ windowMs: TOAST_WINDOW_MS });
  remote.onInputError((e) => {
    if (!throttle.shouldShow(e.kind)) return;
    if (e.kind === 'too-large') toast(REMOTE_INPUT_COPY.tooLargeTitle(hostName()), { kind: 'error', detail: REMOTE_INPUT_COPY.tooLargeDetail(e.limitBytes) });
    else toast(REMOTE_INPUT_COPY.failedTitle(hostName()), { kind: 'error', detail: e.message });
  });
}

/** Returns an `onError` callback for clipboard writes that toasts "Copy failed", at most once per 5 s. */
export function createCopyFailedToast(): (err: unknown) => void {
  const throttle = createToastThrottle({ windowMs: TOAST_WINDOW_MS });
  return (err) => {
    if (!throttle.shouldShow('copy')) return;
    toast(SHORTCUT_COPY.clipboardErrorTitle('copy'), { kind: 'error', detail: errMessage(err) });
  };
}
