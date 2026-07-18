import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  /** Current width in px */
  value: number;
  /** Called with new width during drag AND on commit */
  onChange: (v: number) => void;
  /** Called with the reset default when the user double-clicks */
  onReset?: () => void;
  min: number;
  max: number;
  /** 'left' handles a left-anchored pane (Sidebar) — dragging right grows it */
  side?: 'left' | 'right';
}

export function ResizeHandle({ value, onChange, onReset, min, max, side = 'left' }: Props) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onDown = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    startW.current = value;
    setDragging(true);
    e.preventDefault();
  }, [value]);

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - startX.current;
    const raw = side === 'left' ? startW.current + dx : startW.current - dx;
    const clamped = Math.min(max, Math.max(min, raw));
    onChange(clamped);
  }, [dragging, onChange, min, max, side]);

  const onUp = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setDragging(false);
  }, []);

  const onDoubleClick = useCallback(() => { onReset?.(); }, [onReset]);

  useEffect(() => {
    if (dragging) document.body.style.cursor = 'col-resize';
    else document.body.style.cursor = '';
    return () => { document.body.style.cursor = ''; };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={onDoubleClick}
      data-testid="resize-handle"
      className={`shrink-0 w-1 cursor-col-resize -mx-0.5 hover:bg-[color:var(--accent)] transition ${
        dragging ? 'bg-[color:var(--accent)]' : 'bg-transparent'
      }`}
      title="Drag to resize · Double-click to reset"
    />
  );
}
