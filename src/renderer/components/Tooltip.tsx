import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom';
  /** Also show while a child has keyboard focus (`:focus-visible`); off by default. */
  focusable?: boolean;
  children: React.ReactNode;
}

/**
 * Lightweight tooltip that renders through a portal so it can escape
 * scroll containers and overflow-hidden ancestors (the native `title`
 * attribute is slow, unstyleable, and often clipped inside our panels).
 *
 * Shows after a short delay on hover; hides immediately on leave / click.
 * Once one tooltip has been seen, sweeping onto a neighbour within
 * WARM_MS opens it at once with no animation — the delay has already done
 * its job of filtering accidental hovers. With `focusable`, keyboard focus
 * on a child shows it too and blur hides it.
 */
const OPEN_DELAY_MS = 350;
const WARM_MS = 400;
let lastHiddenAt = 0;
let openCount = 0;

export function Tooltip({ label, shortcut, side = 'bottom', focusable = false, children }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; instant: boolean } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const open = pos !== null;
  useEffect(() => {
    if (!open) return;
    openCount++;
    return () => { openCount--; lastHiddenAt = Date.now(); };
  }, [open]);

  function place(instant: boolean) {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: r.left + r.width / 2,
      y: side === 'bottom' ? r.bottom + 6 : r.top - 6,
      instant,
    });
  }

  function onEnter() {
    if (timer.current) window.clearTimeout(timer.current);
    if (openCount > 0 || Date.now() - lastHiddenAt < WARM_MS) { place(true); return; }
    timer.current = window.setTimeout(() => place(false), OPEN_DELAY_MS);
  }
  function onLeave() {
    if (timer.current) window.clearTimeout(timer.current);
    setPos(null);
  }
  function onFocus(e: React.FocusEvent) {
    if (e.target instanceof Element && e.target.matches(':focus-visible')) onEnter();
  }

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onMouseDown={onLeave}
        onFocus={focusable ? onFocus : undefined}
        onBlur={focusable ? onLeave : undefined}
        className="inline-flex"
      >
        {children}
      </span>
      {pos && createPortal(
        <div
          className="tooltip fixed z-[9999] pointer-events-none select-none px-2 py-1 text-[11px] rounded-md
            bg-[--panel-strong] text-[--text] border border-[--border] shadow-lg"
          style={{ left: pos.x, top: pos.y }}
          data-side={side}
          data-instant={pos.instant || undefined}
          role="tooltip"
        >
          <span>{label}</span>
          {shortcut && (
            <span className="ml-2 opacity-60 font-mono">{shortcut}</span>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
