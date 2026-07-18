import { useEffect } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  separatorAfter?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clamp so the menu stays inside the viewport.
  const maxX = typeof window !== 'undefined' ? window.innerWidth - 220 : x;
  const maxY = typeof window !== 'undefined' ? window.innerHeight - items.length * 28 - 12 : y;
  const clampedX = Math.min(x, maxX);
  const clampedY = Math.min(y, maxY);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 min-w-[200px] rounded-md border border-[--border] bg-[--panel-strong] shadow-xl backdrop-blur-md py-1 text-sm"
        style={{ left: clampedX, top: clampedY }}
        role="menu"
        data-testid="context-menu"
      >
        {items.map((it, i) => (
          <div key={i}>
            <button
              disabled={it.disabled}
              onClick={() => { onClose(); it.onClick(); }}
              className={`w-full text-left px-3 py-1 flex items-center justify-between gap-3 ${
                it.disabled
                  ? 'text-[--text-muted] cursor-not-allowed opacity-60'
                  : it.danger
                    ? 'text-[--danger] hover:bg-[--danger]/15'
                    : 'text-[--text] hover:bg-[--panel]'
              }`}
              role="menuitem"
            >
              <span>{it.label}</span>
            </button>
            {it.separatorAfter && <div className="my-1 h-px bg-[--border]" />}
          </div>
        ))}
      </div>
    </>
  );
}
