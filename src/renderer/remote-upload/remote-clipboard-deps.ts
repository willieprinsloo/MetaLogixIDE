/**
 * `ClipboardPasteDeps` for a remote (fleet) terminal (AC-I1..I5, AC-U12, OQ2). Instead of staging
 * on the viewer, `stageClipboardImage` asks the viewer's main process to send its clipboard image
 * to the host, confirms first when main reports it is over 10 MB, and returns the host path with
 * the host's escaping style. Silent outcomes (no image, a declined confirm, a cancel) map to
 * `no-image` so nothing is typed or toasted; the old-host toast is raised here because its title
 * differs from the paste-failure title.
 */
import type { ClipboardPasteDeps } from '@renderer/clipboard-paste';
import { formatUploadSize, uploadFailureDetail } from '@renderer/remote-upload/remote-drop';
import type { RemoteTarget, UploadBatch } from '@renderer/remote-upload/useUploadProgress';
import { REMOTE_UPLOAD_COPY, type UploadResult } from '@shared/remote-upload-contract';
import type { ClipboardImageResult } from '@shared/terminal-drop-contract';

/** User-facing effects; `confirm` is `window.confirm`, `notify` an error toast. */
export interface RemoteClipboardEffects {
  confirm(message: string): boolean;
  notify(title: string, detail: string): void;
}

const IMAGE_ITEM = { name: 'Clipboard image', index: 1, count: 1 } as const;
const SOURCE = { kind: 'clipboard-image' } as const;
const SILENT: ClipboardImageResult = { kind: 'no-image' };

async function uploadConfirmed(
  batch: UploadBatch,
  target: RemoteTarget,
  effects: RemoteClipboardEffects,
): Promise<UploadResult | null> {
  const first = await batch.upload(SOURCE, IMAGE_ITEM, false);
  if (first.kind !== 'needs-confirm') return first;
  const listed = [{ name: IMAGE_ITEM.name, size: formatUploadSize(first.size) }];
  if (!effects.confirm(REMOTE_UPLOAD_COPY.confirmMessage(listed, target.hostName))) return null;
  return batch.upload(SOURCE, IMAGE_ITEM, true);
}

function toClipboardResult(
  result: UploadResult | null,
  target: RemoteTarget,
  effects: RemoteClipboardEffects,
): ClipboardImageResult {
  if (result === null) return SILENT;
  switch (result.kind) {
    case 'staged':
      return result;
    case 'too-large':
      return result;
    case 'unsupported-host':
      effects.notify(
        REMOTE_UPLOAD_COPY.sendFailedTitle(target.hostName),
        REMOTE_UPLOAD_COPY.oldHostDetail(target.hostName),
      );
      return SILENT;
    case 'refused':
    case 'link-lost':
    case 'failed':
      return { kind: 'failed', reason: uploadFailureDetail(result, target.hostName) };
    default:
      return SILENT;
  }
}

/** Builds the remote paste deps; `style` is a fallback only, since staged results carry their own. */
export function createRemoteClipboardDeps(
  target: RemoteTarget,
  effects: RemoteClipboardEffects,
): ClipboardPasteDeps {
  return {
    style: 'posix',
    stageClipboardImage: async () => {
      const batch = target.uploads.batch(target.deviceId);
      try {
        return toClipboardResult(await uploadConfirmed(batch, target, effects), target, effects);
      } finally {
        batch.end();
      }
    },
    notify: effects.notify,
  };
}
