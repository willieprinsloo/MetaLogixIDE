import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom';
  children: React.ReactNode;
}

/**
 * Lightweight tooltip that renders through a portal so it can escape
 * scroll containers and overflow-hidden ancestors (the native `title`
 * attribute is slow, unstyleable, and often clipped inside our panels).
 *
 * Shows after a short delay on hover; hides immediately on leave / click.
 */
export function Tooltip({ label, shortcut, side = 'bottom', children }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  function place() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: r.left + r.width / 2,
      y: side === 'bottom' ? r.bottom + 6 : r.top - 6,
    });
  }

  function onEnter() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(place, 350);
  }
  function onLeave() {
    if (timer.current) window.clearTimeout(timer.current);
    setPos(null);
  }

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onMouseDown={onLeave}
        className="inline-flex"
      >
        {children}
      </span>
      {pos && createPortal(
        <div
          className={`fixed z-[9999] pointer-events-none select-none px-2 py-1 text-[11px] rounded-md
            bg-[--panel-strong] text-[--text] border border-[--border] shadow-lg
            ${side === 'bottom' ? '-translate-x-1/2' : '-translate-x-1/2 -translate-y-full'}`}
          style={{ left: pos.x, top: pos.y }}
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
