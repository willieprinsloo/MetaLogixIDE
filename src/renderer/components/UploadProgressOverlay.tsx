/**
 * Progress indicator for a file drop or image paste being sent to a remote terminal's host
 * (AC-D5, AC-D6). It pins to the top of the terminal so the prompt line stays visible, reuses the
 * terminal overlays' panel surface so theme and frost carry over, announces the file and percent
 * through a polite live region, and offers a keyboard-reachable Cancel.
 *
 * Usage: `<UploadProgressOverlay view={uploads.view} onCancel={uploads.cancel} />`; a null `view`
 * renders nothing.
 */
import { m } from 'motion/react';
import type { UploadView } from '@renderer/remote-upload/useUploadProgress';
import { REMOTE_UPLOAD_COPY } from '@shared/remote-upload-contract';

interface Props {
  readonly view: UploadView | null;
  readonly onCancel: () => void;
}

const ENTER = { initial: { opacity: 0, y: -4 }, animate: { opacity: 1, y: 0 } } as const;
const TRANSITION = { duration: 0.16, ease: [0.23, 1, 0.32, 1] } as const;

/** Renders the indicator for `view`, or nothing when no upload has been running for 500 ms. */
export function UploadProgressOverlay({ view, onCancel }: Props) {
  if (!view) return null;
  const label = REMOTE_UPLOAD_COPY.progressLabel(view.name, view.index, view.count, view.percent);
  return (
    <div className="absolute inset-x-3 top-3 flex justify-center pointer-events-none" data-testid="upload-progress">
      <m.div
        {...ENTER}
        transition={TRANSITION}
        className="pointer-events-auto flex min-w-0 max-w-full items-center gap-3 bg-[--panel-strong] border border-[--border] rounded-md shadow-xl px-3 py-2 text-xs text-[--text]"
      >
        <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate font-medium">
          {label}
        </span>
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent}
          className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-[--border]"
        >
          <div className="h-full bg-[color:var(--accent)] transition-[width] duration-150 ease-out" style={{ width: `${view.percent}%` }} />
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="pressable shrink-0 border border-[--border] rounded-md px-2.5 py-1 font-medium hover:bg-[--surface-hover] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
        >
          {REMOTE_UPLOAD_COPY.cancel}
        </button>
      </m.div>
    </div>
  );
}
