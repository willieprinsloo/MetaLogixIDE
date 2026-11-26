/**
 * Typed renderer wrapper over the remote-upload IPC (`p2p:upload`, `p2p:upload-cancel`,
 * `drops:stat-app-file` and the `p2p:upload-progress` event). Built once over the preload bridge;
 * everything above it depends on the `UploadClient` interface so tests inject a fake.
 */
import { api } from '@renderer/api';
import type { AppFileDragPayload } from '@shared/terminal-drop-contract';
import type {
  StatAppFileResult,
  UploadProgressEvent,
  UploadRequest,
  UploadResult,
} from '@shared/remote-upload-contract';

/** Intent-named upload effects; `upload` resolves every outcome as a value. */
export interface UploadClient {
  upload(request: UploadRequest): Promise<UploadResult>;
  cancel(uploadId: string): Promise<void>;
  statAppFile(payload: AppFileDragPayload): Promise<StatAppFileResult>;
  onProgress(listener: (event: UploadProgressEvent) => void): () => void;
}

/** The part of the preload bridge the client needs. */
export type UploadBridge = Pick<typeof api, 'invoke' | 'on'>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Creates the client over `bridge`. A bridge rejection (a channel that should never reject) is
 * mapped to a `failed` value so callers handle one shape; a failed cancel is logged and dropped,
 * because the host's idle timeout discards the partial upload anyway.
 */
export function createUploadClient(bridge: UploadBridge): UploadClient {
  return {
    upload: (request) =>
      bridge
        .invoke('p2p:upload', request)
        .catch((err: unknown): UploadResult => ({ kind: 'failed', reason: errorMessage(err) })),
    cancel: (uploadId) =>
      bridge.invoke('p2p:upload-cancel', { uploadId }).then(
        () => undefined,
        (err: unknown) => console.warn('[metaide] upload cancel failed', errorMessage(err)),
      ),
    statAppFile: (payload) =>
      bridge
        .invoke('drops:stat-app-file', payload)
        .catch((err: unknown): StatAppFileResult => ({ kind: 'failed', reason: errorMessage(err) })),
    onProgress: (listener) => bridge.on('p2p:upload-progress', listener),
  };
}

let shared: UploadClient | null = null;

/** The app-wide client over the real preload bridge, built on first use. */
export function uploadClient(): UploadClient {
  shared ??= createUploadClient(api);
  return shared;
}
