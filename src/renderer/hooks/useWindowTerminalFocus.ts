import { useEffect, useLayoutEffect } from 'react';
import { classifyActiveElement, createTerminalFocusCoordinator, type ElementLike } from '@renderer/terminal-focus';

function activeElement(): ElementLike | null {
  const el = document.activeElement;
  if (!el) return null;
  return { tagName: el.tagName, isContentEditable: el instanceof HTMLElement && el.isContentEditable, classList: el.classList };
}

/**
 * The window's single terminal-focus coordinator. Each renderer window is its
 * own JS realm, so this module-level instance is one owner per window.
 */
export const terminalFocus = createTerminalFocusCoordinator({
  activeElementKind: () => classifyActiveElement(activeElement()),
  now: () => performance.now(),
});

/**
 * Feeds window `focus`/`blur` into `terminalFocus` and keeps its overlay flag in
 * sync with `overlayOpen`. Call once per window. The focus call runs
 * synchronously in the handler so an activating click's own element focus,
 * which Chromium delivers afterwards, still wins.
 */
export function useWindowTerminalFocus(overlayOpen: boolean): void {
  // Layout effect: a request issued after an awaited IPC call must already see a click-closed overlay as closed.
  useLayoutEffect(() => {
    terminalFocus.setOverlayOpen(overlayOpen);
  }, [overlayOpen]);

  useEffect(() => {
    const onFocus = () => terminalFocus.onWindowFocus();
    const onBlur = () => terminalFocus.onWindowBlur();
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
