import { useCallback } from 'react';
import { usePersistedNumber } from './usePersistedNumber';

/**
 * Document-zoom level (font-scale multiplier) shared between the Markdown
 * editor and preview, and image / PDF viewers. 1.0 is the baseline; range is
 * 0.5..3.0 in fixed steps so ⌘+/⌘-/⌘0 always land on a clean value.
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_DEFAULT = 1.0;
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0] as const;

function nextStep(v: number): number {
  for (const s of ZOOM_STEPS) if (s > v + 1e-6) return s;
  return ZOOM_MAX;
}
function prevStep(v: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STEPS[i]!;
    if (s < v - 1e-6) return s;
  }
  return ZOOM_MIN;
}

export interface ZoomControls {
  readonly zoom: number;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly setZoom: (v: number) => void;
}

/**
 * Persisted per-storage-key. Markdown passes `'metaide.markdownZoom'` so
 * it survives restarts; image and PDF viewers pass their own keys to keep
 * independent levels (a viewer zoomed to 300% to inspect a chart should not
 * carry over to the next document).
 */
export function useDocumentZoom(storageKey: string): ZoomControls {
  const [zoom, setZoom] = usePersistedNumber(storageKey, ZOOM_DEFAULT, ZOOM_MIN, ZOOM_MAX);
  const zoomIn = useCallback(() => setZoom(nextStep(zoom)), [zoom, setZoom]);
  const zoomOut = useCallback(() => setZoom(prevStep(zoom)), [zoom, setZoom]);
  const resetZoom = useCallback(() => setZoom(ZOOM_DEFAULT), [setZoom]);
  return { zoom, zoomIn, zoomOut, resetZoom, setZoom };
}
