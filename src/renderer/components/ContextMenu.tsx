import { useEffect, useRef } from 'react';
import { m, useIsPresent, useReducedMotion } from 'motion/react';
import { menuMotion } from '../menu-motion';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  separatorAfter?: boolean;
  disabled?: boolean;
  /** Muted, right-aligned secondary text such as a shortcut. */
  hint?: string;
  testId?: string;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Opt-in menu keyboard: focus the first enabled item on open; ArrowUp/ArrowDown cycle enabled items. */
  autoFocus?: boolean;
}

/**
 * Index of the next enabled item from `from` in direction `dir`, wrapping at
 * either end; `from` may be -1 (or `items.length`) to start before the list.
 * Returns -1 when no item is enabled.
 */
export function nextEnabledIndex(items: ContextMenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

/** Opt-in menu keyboard for ContextMenu: refs for each item button, initial focus on the first enabled item, and an ArrowUp/ArrowDown handler. */
function useMenuKeyboard(items: ContextMenuItem[], enabled: boolean, present: boolean) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const latest = useRef({ items, enabled });
  latest.current = { items, enabled };
  useEffect(() => {
    const { items: current, enabled: on } = latest.current;
    if (present && on) itemRefs.current[nextEnabledIndex(current, -1, 1)]?.focus();
  }, [present]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (!enabled || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    const from = current === -1 ? (dir === 1 ? -1 : items.length) : current;
    itemRefs.current[nextEnabledIndex(items, from, dir)]?.focus();
  }

  return { itemRefs, onMenuKeyDown };
}

/** Closes on Escape while `active`; a leaving menu must not hold the listener. */
function useEscapeClose(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, active]);
}

/** Top-left of a menu at (x, y) clamped so it stays inside the viewport. */
function clampToViewport(x: number, y: number, count: number): { left: number; top: number } {
  const maxX = typeof window !== 'undefined' ? window.innerWidth - 220 : x;
  const maxY = typeof window !== 'undefined' ? window.innerHeight - count * 28 - 12 : y;
  return { left: Math.min(x, maxX), top: Math.min(y, maxY) };
}

function itemTone(it: ContextMenuItem): string {
  if (it.disabled) return 'text-[--text-muted] cursor-not-allowed opacity-60';
  return it.danger ? 'text-[--danger] hover:bg-[--danger]/15' : 'text-[--text] hover:bg-[--panel]';
}

function MenuItemRow({ item, buttonRef, onChoose }: {
  item: ContextMenuItem;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onChoose: () => void;
}) {
  return (
    <div>
      <button
        ref={buttonRef}
        disabled={item.disabled}
        onClick={onChoose}
        className={`w-full text-left px-3 py-1 flex items-center justify-between gap-3 ${itemTone(item)}`}
        role="menuitem"
        data-testid={item.testId}
      >
        <span>{item.label}</span>
        {item.hint && <span className="text-xs text-[--text-muted]">{item.hint}</span>}
      </button>
      {item.separatorAfter && <div className="my-1 h-px bg-[--border]" />}
    </div>
  );
}

/** Floating menu at (x, y), clamped to the viewport; Escape or an outside click calls `onClose`, and choosing an item closes before running it. While leaving it is inert: no backdrop, pointer or keyboard activation. */
export function ContextMenu({ x, y, items, onClose, autoFocus = false }: Props) {
  const present = useIsPresent();
  const { itemRefs, onMenuKeyDown } = useMenuKeyboard(items, autoFocus, present);
  const motionProps = menuMotion(useReducedMotion() ?? false);
  useEscapeClose(onClose, present);
  const { left, top } = clampToViewport(x, y, items.length);
  const leavingProps = present ? {} : { inert: '' };

  return (
    <>
      {present && <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />}
      <m.div
        {...motionProps}
        {...leavingProps}
        className={`fixed z-50 min-w-[200px] rounded-md border border-[--border] bg-[--panel-strong] shadow-xl backdrop-blur-md py-1 text-sm${present ? '' : ' pointer-events-none'}`}
        // Grow out of the click point, even when clamping shifted the menu.
        style={{ left, top, transformOrigin: `${x - left}px ${y - top}px` }}
        role={present ? 'menu' : undefined}
        data-overlay
        data-testid={present ? 'context-menu' : 'context-menu-leaving'}
        onKeyDown={onMenuKeyDown}
      >
        {items.map((it, i) => (
          <MenuItemRow
            key={i}
            item={it}
            buttonRef={(el) => { itemRefs.current[i] = el; }}
            onChoose={() => { if (!present) return; onClose(); it.onClick(); }}
          />
        ))}
      </m.div>
    </>
  );
}
