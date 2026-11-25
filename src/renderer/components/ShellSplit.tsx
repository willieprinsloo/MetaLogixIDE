import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence } from 'motion/react';
import { ShellTab } from './ShellTab';
import { api } from '../api';
import { FoldPane } from './FoldPane';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { useTerminalGeometryHold } from '../hooks/useTerminalGeometryHold';
import { SplitGutter } from './SplitGutter';
import { SplitPaneHeader } from './SplitPaneHeader';
import { clampRatio } from '../split-ratio';
import { SPLIT_TESTIDS } from '../split-copy';

/** One pane's shell: its index, chip label, status-dot node, and whether it runs in a popout window. */
export interface SplitPane {
  index: number;
  label: string;
  dot: ReactNode;
  popped: boolean;
}

/** What the split shows and does: left pane, right pane (null = single shell), project path for the headers, the right pane's actions, and the reports that one right pane's fold-out has finished and that every exit has settled. */
export interface SplitPanes {
  left: SplitPane;
  right: SplitPane | null;
  path: string;
  onMoveToTab: () => void;
  onClose: () => void;
  onRightExited: (index: number) => void;
  onExitsSettled: () => void;
}

interface Props {
  projectId: number;
  projectName: string;
  panes: SplitPanes;
  ratio: number;
  onRatioChange: (r: number) => void;
  onOpenFile: (relPath: string, line: number | null, projectId?: number) => void;
  onOpenLaunchSettings?: () => void;
}

type Side = 'left' | 'right';

const CARD = 'rounded-[14px] bg-[--surface-sheet]';
const RING = 'shadow-[inset_0_0_0_1px_var(--pane-ring)]';

/** Left share of the split row at a pointer x. */
function ratioAt(row: HTMLElement, clientX: number): number {
  const rect = row.getBoundingClientRect();
  return clampRatio((clientX - rect.left) / rect.width);
}

/** Window-level pointer tracking for a gutter drag; returns the dragging flag and its starter. */
function useDividerDrag(rowRef: RefObject<HTMLDivElement | null>, onRatioChange: (r: number) => void) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      if (rowRef.current) onRatioChange(ratioAt(rowRef.current, e.clientX));
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onRatioChange, rowRef]);
  return { dragging, startDrag: () => setDragging(true) };
}

/**
 * Pane-mode bookkeeping. Pane mode lasts while a right pane is rendered, including its fold-out,
 * so `exiting` holds it on until AnimatePresence reports the exit complete. `opening` lasts until
 * an enter's fold completes. Terminal geometry is held for either, so the left terminal refits
 * once: after an open's fold, or in the commit that drops the split layout after a close.
 * Split toggles are click-only, so `custom` never asks for an instant fold.
 * The focused-pane mark resets to the left whenever a split opens; it is local and never persisted.
 */
function usePaneMode(right: SplitPane | null) {
  const [prevRight, setPrevRight] = useState(right?.index ?? null);
  const [exiting, setExiting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [focused, setFocused] = useState<Side>('left');
  const rightIndex = right?.index ?? null;
  if (prevRight !== rightIndex) {
    setPrevRight(rightIndex);
    setExiting(prevRight != null && rightIndex == null);
    setOpening(rightIndex != null);
    if (prevRight == null) setFocused('left');
  }
  useTerminalGeometryHold(opening || exiting, rightIndex);
  const reduced = usePrefersReducedMotion();
  const paneMode = right != null || exiting;
  return {
    paneMode,
    custom: { instant: false, reduced },
    focused,
    focusAttr: (side: Side) => (paneMode ? String(focused === side) : undefined),
    cardClass: (side: Side) => (paneMode ? `${CARD} ${focused === side ? RING : ''}` : ''),
    markFocused: (side: Side) => { if (focused !== side) setFocused(side); },
    onOpened: () => setOpening(false),
    onExited: () => setExiting(false),
  };
}

function PaneBody({ projectId, projectName, pane, primary, rightKey, onOpenFile, onOpenLaunchSettings }: {
  projectId: number;
  projectName: string;
  pane: SplitPane;
  primary: boolean;
  rightKey: boolean;
  onOpenFile: Props['onOpenFile'];
  onOpenLaunchSettings?: Props['onOpenLaunchSettings'];
}) {
  const content = pane.popped
    ? <PoppedPlaceholder projectId={projectId} shellIndex={pane.index} name={projectName} />
    : <ShellTab key={`${projectId}:${pane.index}${rightKey ? ':right' : ''}`} projectId={projectId}
        shellIndex={pane.index} primary={primary}
        onOpenFile={onOpenFile} onOpenLaunchSettings={onOpenLaunchSettings} />;
  return (
    <div className="flex-1 min-h-0 relative">
      {content}
    </div>
  );
}

/**
 * The shell area: the left pane alone, or the left and right panes as two cards split by a
 * resizable gutter. The left pane is always the same `.split-left` element (`flex-1`) with the
 * same child positions and ShellTab key, so opening or closing the split never remounts its
 * terminal; the cards, headers and focused-pane ring exist only in pane mode. The
 * right pane folds in and out as a FoldPane keyed by shell index; `mode="wait"` keeps a reopen
 * from mounting a second right pane before the previous one has finished leaving.
 */
export function ShellSplit({ projectId, projectName, panes, ratio, onRatioChange, onOpenFile, onOpenLaunchSettings }: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const { dragging, startDrag } = useDividerDrag(rowRef, onRatioChange);
  const { paneMode, focused, focusAttr, cardClass, markFocused, custom, onOpened, onExited } = usePaneMode(panes.right);
  const body = { projectId, projectName, onOpenFile, onOpenLaunchSettings };
  const right = panes.right;

  return (
    <div ref={rowRef} className="h-full w-full flex min-h-0" data-split-layout={paneMode || undefined}>
      <div
        className={`split-left flex-1 min-h-0 min-w-0 relative flex flex-col ${cardClass('left')}`}
        data-pane-focused={focusAttr('left')}
        onFocus={() => markFocused('left')}
      >
        {paneMode && (
          <SplitPaneHeader label={panes.left.label} path={panes.path} focused={focused === 'left'} dot={panes.left.dot} />
        )}
        <PaneBody {...body} pane={panes.left} primary rightKey={false} />
      </div>
      <AnimatePresence initial={false} mode="wait" custom={custom} onExitComplete={() => { onExited(); panes.onExitsSettled(); }}>
        {right && (
          <FoldPane
            key={right.index}
            size={{ share: 1 - ratio }}
            anchor="start"
            custom={custom}
            onFoldComplete={(phase) => (phase === 'enter' ? onOpened() : panes.onRightExited(right.index))}
          >
            <SplitGutter ratio={ratio} dragging={dragging} onDragStart={startDrag} onRatioChange={onRatioChange} />
            <section
              data-testid={SPLIT_TESTIDS.right}
              className={`flex-1 min-h-0 min-w-0 relative flex flex-col ${cardClass('right')}`}
              data-pane-focused={focusAttr('right')}
              onFocus={() => markFocused('right')}
            >
              <SplitPaneHeader
                label={right.label}
                path={panes.path}
                focused={focused === 'right'}
                dot={right.dot}
                actions={{ onToTab: panes.onMoveToTab, onClose: panes.onClose }}
              />
              <PaneBody {...body} pane={right} primary={false} rightKey />
            </section>
          </FoldPane>
        )}
      </AnimatePresence>
    </div>
  );
}

function PoppedPlaceholder({ projectId, shellIndex, name }: { projectId: number; shellIndex: number; name: string }) {
  return (
    <div className="h-full flex items-center justify-center p-8 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-sm text-[--text-muted]">Shell is running in a separate window</div>
        <div className="text-lg font-semibold">{name}</div>
        <button
          onClick={async () => { await api.invoke('windows:return-shell', { projectId, shellIndex }); }}
          className="text-sm px-4 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-[--accent-text] hover:brightness-110"
          data-testid="return-popout"
        >
          Bring back to this window
        </button>
      </div>
    </div>
  );
}
