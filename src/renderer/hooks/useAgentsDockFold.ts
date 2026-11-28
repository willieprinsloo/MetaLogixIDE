import { useCallback, useEffect, useState } from 'react';
import { completeDockFold, dockFoldCustom, initialDockFold, stepDockFold, type DockFoldInput } from '@renderer/agents-dock-fold';
import type { FoldCustom } from '@renderer/pane-fold';
import { onTerminalGeometryRelease } from '@renderer/terminal-geometry-hold';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import { useTerminalGeometryHold } from './useTerminalGeometryHold';

/**
 * The Agents dock's fold flags and terminal hold. Runs `stepDockFold` on each render's
 * `{setting, context, source}` (the same render-time comparison as the sidebar's fold), holds
 * terminal geometry while a pointer slide is in flight, and reads reduced motion live. If the
 * hold's watchdog gives up on a lost completion, the fold is treated as complete so the next slide
 * takes a fresh hold. Returns the fold's `custom` and its completion handler.
 */
export function useAgentsDockFold(input: DockFoldInput): { custom: FoldCustom; onFoldComplete: () => void } {
  const reduced = usePrefersReducedMotion();
  const [state, setState] = useState(() => initialDockFold(input));
  const current = stepDockFold(state, input);
  if (current !== state) setState(current);
  useTerminalGeometryHold(current.folding, input.setting);
  const onFoldComplete = useCallback(() => setState(completeDockFold), []);
  useEffect(() => (current.folding ? onTerminalGeometryRelease(onFoldComplete) : undefined), [current.folding, onFoldComplete]);
  return { custom: dockFoldCustom(current, reduced), onFoldComplete };
}
