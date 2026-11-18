/**
 * Upload tracker for one remote terminal, plus the React hook that exposes it (AC-D5, AC-D6,
 * AC-D8). A drop or image paste opens a batch and sends each file through `batch.upload`; the
 * tracker gives every upload a fresh id, follows its `p2p:upload-progress` events while a batch is
 * open, reveals a view only once a batch has run for 500 ms, and `cancel()` stops the upload in
 * flight and makes every later upload of open batches resolve `cancelled` without sending.
 */
import { useCallback, useEffect, useState } from 'react';
import type { UploadItem } from '@renderer/remote-upload/remote-drop';
import type { UploadClient } from '@renderer/remote-upload/upload-client';
import {
  UPLOAD_PROGRESS_DELAY_MS,
  type UploadProgressEvent,
  type UploadRequest,
  type UploadResult,
  type UploadSource,
} from '@shared/remote-upload-contract';

/** What the progress indicator shows; `percent` is of the current file's bytes. */
export interface UploadView {
  readonly name: string;
  readonly index: number;
  readonly count: number;
  readonly percent: number;
}

/** One drop or paste; `end` must be called when it settles, whatever the outcome. */
export interface UploadBatch {
  upload(source: UploadSource, item: UploadItem, confirmed: boolean): Promise<UploadResult>;
  end(): void;
}

/** Per-terminal tracker; `view` returns the same object until something changes. */
export interface UploadTracker {
  batch(deviceId: string): UploadBatch;
  cancel(): void;
  view(): UploadView | null;
  subscribe(listener: () => void): () => void;
}

/** The paired machine a remote terminal's shell runs on, and that terminal's upload tracker. */
export interface RemoteTarget {
  readonly deviceId: string;
  readonly hostName: string;
  readonly uploads: UploadTracker;
}

export interface UploadTrackerDeps {
  readonly client: UploadClient;
  readonly newId?: () => string;
}

interface BatchState {
  cancelled: boolean;
  visible: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  activeId: string | null;
  item: UploadItem | null;
  percent: number;
}

const percentOf = (e: UploadProgressEvent): number =>
  e.totalBytes > 0 ? Math.min(100, Math.floor((e.sentBytes * 100) / e.totalBytes)) : 0;

function viewOf(batches: ReadonlySet<BatchState>): UploadView | null {
  const shown = [...batches].filter((b) => b.visible && !b.cancelled && b.item).at(-1);
  return shown?.item ? { ...shown.item, percent: shown.percent } : null;
}

interface TrackerCore {
  readonly client: UploadClient;
  readonly newId: () => string;
  readonly batches: Set<BatchState>;
  readonly listeners: Set<() => void>;
  snapshot: UploadView | null;
  offProgress: (() => void) | null;
}

type SendRequest = Omit<UploadRequest, 'uploadId'>;

function changed(core: TrackerCore): void {
  core.snapshot = viewOf(core.batches);
  for (const listener of core.listeners) listener();
}

function onProgress(core: TrackerCore, e: UploadProgressEvent): void {
  const batch = [...core.batches].find((b) => b.activeId === e.uploadId);
  if (!batch) return;
  batch.percent = percentOf(e);
  changed(core);
}

function openBatch(core: TrackerCore): BatchState {
  const state: BatchState = { cancelled: false, visible: false, timer: null, activeId: null, item: null, percent: 0 };
  core.batches.add(state);
  core.offProgress ??= core.client.onProgress((e) => onProgress(core, e));
  return state;
}

function closeBatch(core: TrackerCore, state: BatchState): void {
  if (state.timer) clearTimeout(state.timer);
  core.batches.delete(state);
  if (core.batches.size === 0) {
    core.offProgress?.();
    core.offProgress = null;
  }
  changed(core);
}

function scheduleReveal(core: TrackerCore, state: BatchState): void {
  state.timer ??= setTimeout(() => {
    state.visible = true;
    changed(core);
  }, UPLOAD_PROGRESS_DELAY_MS);
}

async function sendIn(core: TrackerCore, state: BatchState, request: SendRequest, item: UploadItem): Promise<UploadResult> {
  if (state.cancelled) return { kind: 'cancelled' };
  const uploadId = core.newId();
  Object.assign(state, { activeId: uploadId, item, percent: 0 });
  scheduleReveal(core, state);
  changed(core);
  try {
    return await core.client.upload({ uploadId, ...request });
  } finally {
    if (state.activeId === uploadId) state.activeId = null;
  }
}

function cancelAll(core: TrackerCore): void {
  for (const state of core.batches) {
    state.cancelled = true;
    if (state.activeId) void core.client.cancel(state.activeId);
  }
  changed(core);
}

/** Creates a tracker over `client`; ids default to `crypto.randomUUID()`. */
export function createUploadTracker(deps: UploadTrackerDeps): UploadTracker {
  const core: TrackerCore = {
    client: deps.client,
    newId: deps.newId ?? (() => crypto.randomUUID()),
    batches: new Set(),
    listeners: new Set(),
    snapshot: null,
    offProgress: null,
  };
  return {
    batch: (deviceId) => {
      const state = openBatch(core);
      return {
        upload: (source, item, confirmed) => sendIn(core, state, { deviceId, source, confirmed }, item),
        end: () => closeBatch(core, state),
      };
    },
    cancel: () => cancelAll(core),
    view: () => core.snapshot,
    subscribe: (listener) => {
      core.listeners.add(listener);
      return () => core.listeners.delete(listener);
    },
  };
}

/**
 * Owns one tracker for the calling terminal and re-renders on its view. Returns the tracker (to
 * hand to the paste and drop hooks), the current view (null hides the indicator) and `cancel`.
 * Unmount cancels whatever is in flight (AC-D8).
 */
export function useUploadProgress(client: UploadClient): {
  tracker: UploadTracker;
  view: UploadView | null;
  cancel: () => void;
} {
  const [tracker] = useState(() => createUploadTracker({ client }));
  const [view, setView] = useState<UploadView | null>(null);
  useEffect(() => {
    const off = tracker.subscribe(() => setView(tracker.view()));
    return () => {
      off();
      tracker.cancel();
    };
  }, [tracker]);
  const cancel = useCallback(() => tracker.cancel(), [tracker]);
  return { tracker, view, cancel };
}
