import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { KEEP_AWAKE_COPY, KEEP_AWAKE_TESTIDS, type KeepAwakeState } from '@shared/keep-awake-contract';
import { formatEndTime, formatRemaining } from '@renderer/keep-awake-time';
import { ICON_SIZE } from './icon-size';

/** Chip refresh period: the label has minute granularity, so a quarter minute never shows a stale minute. */
export const NOW_TICK_MS = 15_000;

/** The current time, refreshed every `NOW_TICK_MS` while `active`; no timer runs while inactive. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Open state of the chip's popover. While open, Escape or a mousedown outside the anchor (chip plus
 * popover) closes it and returns focus to the chip. It also closes when `active` turns false, so a
 * later start does not reopen it.
 */
export function useChipPopover(active: boolean) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (): void => { setOpen(false); chipRef.current?.focus(); };
    const onDown = (e: MouseEvent): void => {
      if (!anchorRef.current?.contains(e.target as Node | null)) dismiss();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return { open: open && active, toggle, close, anchorRef, chipRef };
}

interface ViewProps {
  readonly endsAt: number;
  readonly now: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onStop: () => void;
  readonly onDarkenNow: () => void;
  readonly anchorRef: RefObject<HTMLDivElement>;
  readonly chipRef: RefObject<HTMLButtonElement>;
}

const POPOVER_ID = 'keep-awake-popover';
const ACTION =
  'w-full text-left px-2 py-1.5 rounded text-[--text] hover:bg-[--surface-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';

function EyeIcon(): React.JSX.Element {
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * Presentational keep-awake chip: the remaining time as the visible label, the exact end time as the
 * tooltip, the remaining time in the accessible name (no live region, so the countdown is never
 * announced), and, when `open`, a popover with Stop, Turn screen off now and the lid hint.
 */
export function KeepAwakeChipView({ endsAt, now, open, onToggle, onStop, onDarkenNow, anchorRef, chipRef }: ViewProps): React.JSX.Element {
  const remaining = formatRemaining(endsAt, now);
  return (
    <div ref={anchorRef} className="relative">
      <button
        ref={chipRef}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? POPOVER_ID : undefined}
        aria-label={KEEP_AWAKE_COPY.chip.aria(remaining)}
        title={KEEP_AWAKE_COPY.chip.tooltip(formatEndTime(endsAt, now))}
        data-testid={KEEP_AWAKE_TESTIDS.chip}
        className="flex items-center gap-1.5 px-1.5 py-0 rounded-md text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
      >
        <EyeIcon />
        <span>{KEEP_AWAKE_COPY.chip.label(remaining)}</span>
      </button>
      {open && (
        <div
          id={POPOVER_ID}
          data-testid={KEEP_AWAKE_TESTIDS.popover}
          data-overlay
          className="popover absolute bottom-full left-0 mb-2 w-[260px] rounded-md border border-[--border] bg-[--panel-strong] shadow-xl z-50 p-1 text-xs"
        >
          <button type="button" onClick={onStop} data-testid={KEEP_AWAKE_TESTIDS.stop} className={ACTION}>{KEEP_AWAKE_COPY.popover.stop}</button>
          <button type="button" onClick={onDarkenNow} data-testid={KEEP_AWAKE_TESTIDS.darkenNow} className={ACTION}>{KEEP_AWAKE_COPY.popover.darkenNow}</button>
          <p className="px-2 py-1.5 text-[--text-muted]">{KEEP_AWAKE_COPY.popover.lidHint}</p>
        </div>
      )}
    </div>
  );
}

interface Props {
  readonly state: KeepAwakeState;
  readonly onStop: () => void;
  readonly onDarkenNow: () => void;
}

/** Status-bar keep-awake chip: renders nothing while inactive; owns the popover and the clock tick. */
export function KeepAwakeChip({ state, onStop, onDarkenNow }: Props): React.JSX.Element | null {
  const now = useNow(state.active);
  const popover = useChipPopover(state.active);
  if (!state.active) return null;
  return (
    <KeepAwakeChipView
      endsAt={state.endsAt}
      now={now}
      open={popover.open}
      onToggle={popover.toggle}
      onStop={() => { popover.close(); onStop(); }}
      onDarkenNow={() => { popover.close(); onDarkenNow(); }}
      anchorRef={popover.anchorRef}
      chipRef={popover.chipRef}
    />
  );
}
