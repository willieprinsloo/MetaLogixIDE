import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { m, useIsPresent } from 'motion/react';
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

const FOLD_SIZE_VAR = '--fold-size' as const;

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

/** Blurs focus inside the pane and returns `inert` while it is leaving, when `enabled`; otherwise nothing. */
function useLeavingInert(enabled: boolean, outer: RefObject<HTMLDivElement | null>): { inert?: '' } {
  const present = useIsPresent();
  const leaving = enabled && !present;
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (leaving && focused instanceof HTMLElement && outer.current?.contains(focused)) focused.blur();
  }, [leaving, outer]);
  return leaving ? { inert: '' } : {};
}

const clampWidth = ({ min, max, reserve }: FoldClamp) => `clamp(${min}px, calc(100cqw - ${reserve}px), ${max}px)`;

type FoldStyle = CSSProperties & { [FOLD_SIZE_VAR]?: string };

function foldTerms(size: FoldSize): { outer: string; size: FoldStyle; inner: CSSProperties } {
  const scaled = `var(${FOLD_SIZE_VAR}) * var(--fold)`;
  if (typeof size === 'object' && 'clamp' in size) {
    return { outer: scaled, size: { [FOLD_SIZE_VAR]: clampWidth(size.clamp) }, inner: { width: `var(${FOLD_SIZE_VAR})` } };
  }
  if (size === 'intrinsic') return { outer: scaled, size: {}, inner: {} };
  return { outer: `${size.share} * 100% * var(--fold)`, size: {}, inner: { width: 'calc(100% / max(var(--fold), 0.001))' } };
}

function widths(size: FoldSize, bleedPx = 0): { outer: FoldStyle; inner: CSSProperties } {
  const terms = foldTerms(size);
  if (!bleedPx) return { outer: { ...terms.size, width: `calc(${terms.outer})` }, inner: terms.inner };
  const outer = { ...terms.size, width: `calc(${terms.outer} + ${bleedPx}px)`, marginInlineStart: -bleedPx, paddingInlineStart: bleedPx };
  return { outer, inner: terms.inner };
}

/**
 * A pane that folds in and out beside a `flex-1` neighbour, for use as a keyed child of
 * `AnimatePresence`. Motion animates only the outer's `--fold` (0–1); the outer's width is its
 * final size times that, so the neighbour takes the freed space frame by frame with no hole. The
 * inner element keeps the final size throughout and is pinned to `anchor`, so content slides
 * under the moving edge instead of reflowing. `size` is a share of the row's content box (the
 * inner is then sized from it), `'intrinsic'` (the inner is `w-max`, measured) or a `clamp`
 * against the nearest inline-size container (pure CSS, no measuring). At rest nothing is clipped
 * beyond `overflow: hidden`, nothing is transformed and opacity is 1. `custom` carries the
 * instant/reduced flags; `onFoldComplete` reports the end of an enter or exit. `options` (off by
 * default): `inertWhileExiting` makes the leaving pane inert and blurs focus inside it as the exit
 * starts; `startBleedPx` widens the clip box that far past the start edge (negative margin plus
 * padding, so layout is unchanged) to keep an overhanging start handle painted and hit-testable.
 */
export function FoldPane({ size, anchor, custom, onFoldComplete, className = '', innerClassName = '', options, children }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const intrinsic = size === 'intrinsic';
  useIntrinsicFoldSize(intrinsic, outerRef, innerRef);
  const style = widths(size, options?.startBleedPx);
  const leavingProps = useLeavingInert(options?.inertWhileExiting ?? false, outerRef);

  return (
    <m.div
      ref={outerRef}
      {...leavingProps}
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
