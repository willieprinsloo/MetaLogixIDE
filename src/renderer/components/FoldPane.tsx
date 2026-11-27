import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { m } from 'motion/react';
import { FOLD_LABELS, paneFoldVariants, type FoldCustom } from '../pane-fold';

/** Final width resolved by CSS from the nearest inline-size container: clamp(min, 100cqw - reserve, max), px. */
export interface FoldClamp { min: number; max: number; reserve: number }

/** How the folding pane's final width is found: a share of its row, its content's own width, or a CSS clamp. */
export type FoldSize = { share: number } | 'intrinsic' | { clamp: FoldClamp };

/** Opt-in behaviours; the sidebar and split leave them off. */
export interface FoldOptions { inertWhileExiting?: boolean; startBleedPx?: number }

interface Props {
  size: FoldSize;
  anchor: 'start' | 'end';
  custom: FoldCustom;
  onFoldComplete?: (phase: 'enter' | 'exit') => void;
  className?: string;
  innerClassName?: string;
  options?: FoldOptions;
  children: ReactNode;
}

const FOLD_SIZE_VAR = '--fold-size';

/** Mirrors the inner element's width into the outer's `--fold-size` so its fold has a final px size to scale. */
function useIntrinsicFoldSize(enabled: boolean, outer: RefObject<HTMLDivElement | null>, inner: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!enabled || !o || !i) return;
    const write = (px: number) => o.style.setProperty(FOLD_SIZE_VAR, `${px}px`);
    write(i.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => { if (entry) write(entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width); });
    ro.observe(i);
    return () => ro.disconnect();
  }, [enabled, outer, inner]);
}

function widths(size: FoldSize): { outer: CSSProperties; inner: CSSProperties } {
  if (typeof size === 'object' && 'clamp' in size) return { outer: {}, inner: {} }; // STUB: clamp sizing not implemented yet
  if (size === 'intrinsic') return { outer: { width: `calc(var(${FOLD_SIZE_VAR}) * var(--fold))` }, inner: {} };
  return {
    outer: { width: `calc(${size.share} * 100% * var(--fold))` },
    inner: { width: 'calc(100% / max(var(--fold), 0.001))' },
  };
}

/**
 * A pane that folds in and out beside a `flex-1` neighbour, for use as a keyed child of
 * `AnimatePresence`. Motion animates only the outer's `--fold` (0–1); the outer's width is its
 * final size times that, so the neighbour takes the freed space frame by frame with no hole. The
 * inner element keeps the final size throughout and is pinned to `anchor`, so content slides
 * under the moving edge instead of reflowing. `size` is a share of the row's content box (the
 * inner is then sized from it) or `'intrinsic'` (the inner is `w-max`, measured). At rest nothing
 * is clipped beyond `overflow: hidden`, nothing is transformed and opacity is 1. `custom` carries
 * the instant/reduced flags; `onFoldComplete` reports the end of an enter or exit.
 */
export function FoldPane({ size, anchor, custom, onFoldComplete, className = '', innerClassName = '', options, children }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const intrinsic = size === 'intrinsic';
  useIntrinsicFoldSize(intrinsic, outerRef, innerRef);
  const style = widths(size);
  void options; // STUB: options not implemented yet

  return (
    <m.div
      ref={outerRef}
      className={`flex min-h-0 shrink-0 overflow-hidden ${anchor === 'end' ? 'justify-end' : ''} ${className}`}
      style={style.outer}
      custom={custom}
      variants={paneFoldVariants}
      initial={FOLD_LABELS.initial}
      animate={FOLD_LABELS.enter}
      exit={FOLD_LABELS.exit}
      onAnimationComplete={(definition) => {
        if (definition === FOLD_LABELS.enter) onFoldComplete?.('enter');
        if (definition === FOLD_LABELS.exit) onFoldComplete?.('exit');
      }}
    >
      <div
        ref={innerRef}
        className={`flex h-full min-h-0 shrink-0 ${intrinsic ? 'w-max' : ''} ${innerClassName}`}
        style={style.inner}
      >
        {children}
      </div>
    </m.div>
  );
}
