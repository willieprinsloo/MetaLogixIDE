/**
 * Modal material contract: the class names of the shared frosted-glass material (defined once in
 * styles.css) and the list of modal surfaces that use it, with each surface's z tier, motion and
 * radius. Unit and e2e tests iterate `MODAL_SURFACES` rather than restating it.
 */
import { PERMISSION_MODE_TEST_IDS } from './permission-mode-copy';

export const MODAL_CLASSES = {
  /** Full-window tinted, blurred backdrop. Sibling of the layer, never its parent. */
  scrim: 'modal-scrim',
  /** Pointer-transparent positioning layer that holds the sheet. No filter, opacity or transform. */
  layer: 'modal-layer',
  /** The translucent panel. Dialog radius. */
  sheet: 'modal-sheet',
  /** Modifier for the palette and the finders: compact radius. */
  sheetCompact: 'modal-sheet--compact',
  /** Opt-in fade for mouse-opened modals (existing motion class). */
  fadeScrim: 'modal-backdrop',
  /** Opt-in fade + settle for mouse-opened modals (existing motion class). */
  fadePanel: 'modal-panel',
} as const;

/** z pairs (scrim, layer): other modals < palette < toasts (60) < permission dialog. */
export type ModalTier = 'modal' | 'palette' | 'blocking';
export const MODAL_TIER_Z: Record<ModalTier, readonly [scrim: number, layer: number]> = {
  modal: [50, 51],
  palette: [52, 53],
  blocking: [100, 101],
};
/** Toast stack z-index: above every modal tier except `blocking`. */
export const TOAST_Z = 60;

export type ModalMotion = 'none' | 'fade';
export type ModalRadius = 'compact' | 'dialog';

export interface ModalSurface {
  readonly id: string;
  /** On the layer; the scrim carries `${testId}-scrim`. */
  readonly testId: string;
  readonly tier: ModalTier;
  readonly motion: ModalMotion;
  readonly radius: ModalRadius;
}

export const MODAL_SURFACES: readonly ModalSurface[] = [
  { id: 'palette', testId: 'command-palette', tier: 'palette', motion: 'none', radius: 'compact' },
  { id: 'settings', testId: 'settings-modal', tier: 'modal', motion: 'fade', radius: 'dialog' },
  { id: 'new-project', testId: 'new-project-dialog', tier: 'modal', motion: 'fade', radius: 'dialog' },
  { id: 'permission-mode', testId: PERMISSION_MODE_TEST_IDS.dialog, tier: 'blocking', motion: 'fade', radius: 'dialog' },
  { id: 'project-search', testId: 'project-search', tier: 'modal', motion: 'none', radius: 'compact' },
  { id: 'prompt-library', testId: 'prompt-library', tier: 'modal', motion: 'none', radius: 'dialog' },
  { id: 'scrollback-search', testId: 'scrollback-search', tier: 'modal', motion: 'none', radius: 'compact' },
  { id: 'rename-project', testId: 'rename-project', tier: 'modal', motion: 'none', radius: 'dialog' },
  { id: 'unload-session', testId: 'unload-session-dialog', tier: 'modal', motion: 'none', radius: 'dialog' },
  { id: 'shortcuts-help', testId: 'shortcuts-help', tier: 'modal', motion: 'none', radius: 'dialog' },
];

export function scrimTestId(testId: string): string {
  return `${testId}-scrim`;
}
