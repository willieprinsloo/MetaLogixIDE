import type { KeyboardEvent } from 'react';
import { SPLIT_COPY } from '../split-copy';
import { SPLIT_RATIO_MAX, SPLIT_RATIO_MIN, ratioAriaValue, stepRatio } from '../split-ratio';

interface Props {
  ratio: number;
  dragging: boolean;
  onDragStart: () => void;
  onRatioChange: (r: number) => void;
}

/** Ratio step for a key pressed on the gutter: ArrowLeft → -1, ArrowRight → 1, anything else → null. */
export function gutterKeyStep(key: string): -1 | 1 | null {
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return null;
}

/**
 * Whitespace gutter between the split cards: a focusable window-splitter separator with a centred
 * grab pill. Mouse down starts a drag (the caller tracks the pointer); ArrowLeft/ArrowRight emit a
 * stepped ratio. Carries no data-testid so `split-right` stays the first one inside the fold container.
 */
export function SplitGutter({ ratio, dragging, onDragStart, onRatioChange }: Props) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir = gutterKeyStep(e.key);
    if (dir == null) return;
    e.preventDefault();
    onRatioChange(stepRatio(ratio, dir));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={SPLIT_COPY.resize}
      aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
      aria-valuenow={ratioAriaValue(ratio)}
      tabIndex={0}
      onMouseDown={onDragStart}
      onKeyDown={onKeyDown}
      className="group shrink-0 w-[10px] flex items-center justify-center cursor-col-resize"
    >
      <span
        aria-hidden="true"
        className={`w-[3px] h-9 rounded-[2px] ${dragging ? 'bg-[color:var(--accent-mark,var(--accent))]' : 'bg-[--split-grip] group-hover:bg-[color:var(--accent-mark,var(--accent))]'}`}
      />
    </div>
  );
}
