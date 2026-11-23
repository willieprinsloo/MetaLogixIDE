/** IDE chrome and a clipped native Board lease; the renderer never receives a navigable URL. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { api } from '@renderer/api';
import { MODAL_CLASSES } from '@renderer/modal-glass';
import type { MetaprojectAssignment, MetaprojectBoardState, MetaprojectExternalCandidate, MetaprojectFailure, MetaprojectIpc } from '@shared/metaproject-contract';
import { AccountStatus, SignedInPersistenceWarning, useMetaprojectSession, useSignInIntent } from './session';
import { failureCopy, mpButton } from './messages';
import type { Load } from './useAssignment';

type Bounds = MetaprojectIpc['metaproject:board-layout']['request']['bounds'];
type Target = { projectId: number; revision: string };
export type BoardLeaseControl = { hide: () => Promise<void>; close: () => void };
type ControlRef = MutableRefObject<BoardLeaseControl | null>;

/** Rounds inward so the native child cannot overlap chrome even at fractional scaling. */
export function clipBoardBounds(rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>, viewportWidth: number, viewportHeight: number, scale = 1): Bounds {
  const x = Math.ceil(Math.max(0, rect.left) * scale);
  const y = Math.ceil(Math.max(0, rect.top) * scale);
  const width = Math.floor(Math.min(viewportWidth, rect.right) * scale) - x;
  const height = Math.floor(Math.min(viewportHeight, rect.bottom) * scale) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function intersect(host: HTMLElement) {
  const { left, top, right, bottom } = host.getBoundingClientRect();
  const column = host.closest('main')?.getBoundingClientRect();
  return clipBoardBounds(column ? {
    left: Math.max(left, column.left), top: Math.max(top, column.top), right: Math.min(right, column.right), bottom: Math.min(bottom, column.bottom),
  } : { left, top, right, bottom }, window.innerWidth, window.innerHeight, window.visualViewport?.scale ?? 1);
}

function useBoardGeometry(host: RefObject<HTMLDivElement | null>, canShow: boolean, layout: (bounds: Bounds) => void) {
  useLayoutEffect(() => {
    const node = host.current;
    if (!canShow || !node) { layout(null); return; }
    let frame = 0;
    const modal = () => document.querySelector(`.${MODAL_CLASSES.scrim}, [aria-modal="true"]`) !== null;
    const schedule = () => {
      if (modal()) { layout(null); return; }
      if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; layout(modal() ? null : intersect(node)); });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    for (let element: HTMLElement | null = node; element; element = element.parentElement) observer?.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      layout(null);
    };
  }, [host, canShow, layout]);
}

type LeaseProps = Target & { epoch: number; covered: boolean; controls?: ControlRef; onReturn?: () => void; onSettings?: () => void };
type Phase = MetaprojectBoardState['phase'];
type LeaseLayout = (bounds: Bounds) => Promise<void>;
type SetError = (error: MetaprojectFailure | null) => void;

function useNativeBoard(covered: boolean, setError: SetError) {
  const lease = useRef<string | null>(null);
  const last = useRef<string | undefined>(undefined);
  const pendingLayout = useRef<Promise<void>>(Promise.resolve());
  const suspended = useRef(false);
  useLayoutEffect(() => { if (!covered) suspended.current = false; }, [covered]);
  const layout = useCallback((bounds: Bounds) => {
    const viewId = lease.current;
    if (!viewId || (bounds && suspended.current)) return pendingLayout.current;
    const serialized = JSON.stringify(bounds);
    if (last.current === serialized) return pendingLayout.current;
    last.current = serialized;
    const pending = api.invoke('metaproject:board-layout', { viewId, bounds }).then((result) => {
      if (!result.ok && result.reason !== 'stale' && lease.current === viewId) setError(result.reason);
    }).catch(() => { if (lease.current === viewId) setError('unavailable'); });
    pendingLayout.current = pending;
    return pending;
  }, [setError]);
  const close = useCallback(() => {
    const viewId = lease.current;
    if (!viewId) return;
    layout(null);
    lease.current = null;
    void api.invoke('metaproject:board-close', { viewId }).catch(() => undefined);
  }, [layout]);
  const hide = useCallback(() => { suspended.current = true; return layout(null); }, [layout]);
  const start = useCallback((viewId: string) => { lease.current = viewId; last.current = undefined; }, []);
  return { lease, start, close, hide, layout };
}

function useLease({ projectId, revision, epoch, covered, controls, onReturn }: LeaseProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<MetaprojectFailure | null>(null);
  const [candidate, setCandidate] = useState<MetaprojectExternalCandidate | null>(null);
  const [generation, retry] = useState(0);
  const { lease, start, close, hide, layout } = useNativeBoard(covered, setError);
  useLayoutEffect(() => {
    const viewId = crypto.randomUUID();
    start(viewId);
    setPhase('loading'); setError(null); setCandidate(null);
    if (controls) controls.current = { hide, close };
    let observed = false;
    const same = (event: Target & { viewId: string; epoch: number }) => lease.current === viewId && event.viewId === viewId && event.epoch === epoch && event.projectId === projectId && event.revision === revision;
    const observe = (state: MetaprojectBoardState) => {
      if (!same(state)) return;
      observed = true;
      setPhase(state.phase); setError(state.phase === 'error' ? state.reason : null);
    };
    const offState = api.on('metaproject:board-state', observe);
    const offCandidate = api.on('metaproject:board-external-candidate', (event) => {
      if (same(event)) { void layout(null); setCandidate(event); }
    });
    const offFocus = api.on('metaproject:board-return-focus', (event) => { if (lease.current === viewId && event.viewId === viewId) onReturn?.(); });
    void api.invoke('metaproject:board-open', { projectId, revision, viewId, epoch }).then((result) => {
      if (lease.current !== viewId || observed) return;
      if (result.ok) observe(result.value); else { setPhase('error'); setError(result.reason); }
    }).catch(() => { if (lease.current === viewId) { setPhase('error'); setError('unavailable'); } });
    return () => { close(); if (controls) controls.current = null; offState(); offCandidate(); offFocus(); };
  }, [projectId, revision, epoch, generation, controls, close, layout, hide, start, lease, onReturn]);
  return { lease, phase, error, setError, candidate, setCandidate, layout, retry: () => retry((n) => n + 1) };
}

function useExternalDecision(board: ReturnType<typeof useLease>, covered: boolean, focus: RefObject<HTMLButtonElement | null>) {
  const { lease, candidate, setCandidate, setError } = board;
  const confirmation = useRef<HTMLButtonElement>(null);
  const submitted = useRef<MetaprojectExternalCandidate | null>(null);
  const restore = useRef(false);
  useLayoutEffect(() => { if (candidate && !covered) confirmation.current?.focus(); }, [candidate, covered]);
  useLayoutEffect(() => {
    if (candidate || covered || !restore.current) return;
    restore.current = false;
    if (focus.current?.disabled === false) focus.current.focus();
    else if (board.lease.current) focus.current?.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [candidate, covered, focus, board.lease]);
  async function handleExternal(approved: boolean) {
    if (!candidate || lease.current !== candidate.viewId || submitted.current === candidate) return;
    const { viewId, candidateId } = candidate;
    submitted.current = candidate;
    try {
      const result = await api.invoke(approved ? 'metaproject:board-external' : 'metaproject:board-dismiss-external', { viewId, candidateId });
      if (!result.ok && lease.current === viewId && (approved || result.reason !== 'stale')) setError(result.reason);
    } catch { if (lease.current === viewId) setError('unavailable'); }
    finally {
      if (submitted.current === candidate) submitted.current = null;
      if (lease.current === viewId) { restore.current = true; setCandidate((prior) => prior === candidate ? null : prior); }
    }
  }
  return { confirmation, handleExternal };
}

async function focusBoard(lease: RefObject<string | null>, host: RefObject<HTMLDivElement | null>, layout: LeaseLayout, setError: SetError) {
  const viewId = lease.current;
  const bounds = host.current ? intersect(host.current) : null;
  if (!viewId || !bounds) return;
  await layout(bounds);
  if (lease.current !== viewId) return;
  try { const result = await api.invoke('metaproject:board-focus', { viewId }); if (!result.ok && lease.current === viewId) setError(result.reason); }
  catch { if (lease.current === viewId) setError('unavailable'); }
}

/** Manages one native view lease, rejecting events for another revision, window view or epoch. */
export function BoardLease(props: LeaseProps) {
  const { covered, projectId, revision, onSettings } = props;
  const board = useLease(props);
  const { lease, phase, error, setError, candidate, layout, retry } = board;
  const host = useRef<HTMLDivElement>(null);
  const focus = useRef<HTMLButtonElement>(null);
  const { confirmation, handleExternal } = useExternalDecision(board, covered, focus);
  const shown = phase === 'ready' && !covered && !candidate && !error;
  useBoardGeometry(host, shown, layout);
  return <div className="flex flex-1 min-h-0 min-w-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs">
      <button ref={focus} className={mpButton} disabled={!shown} onClick={() => void focusBoard(lease, host, layout, setError)}>Focus Board</button>
      <BrowserButton projectId={projectId} revision={revision} />
      {error && <button className={mpButton} onClick={retry}>Retry Board</button>}
      {(error === 'denied' || error === 'not-found' || error === 'origin-mismatch' || error === 'conflict' || error === 'stale') && onSettings && <button className={mpButton} onClick={onSettings}>Open Project Settings</button>}
    </div>
    {phase === 'loading' && !error && <p role="status" className="p-3">Loading Board…</p>}
    {error && <p role="alert" className="p-3">{failureCopy[error]}</p>}
    {candidate && <div role="group" aria-label="Open external link?" className="space-y-2 p-3" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); void handleExternal(false); }
    }}>
      <p>Open {candidate.label} in your default browser? The browser uses its own account.</p>
      <div className="flex flex-wrap gap-2">
        <button ref={confirmation} className={mpButton} onClick={() => void handleExternal(false)}>Cancel external link</button>
        <button className={mpButton} onClick={() => void handleExternal(true)}>Open external link</button>
      </div>
    </div>}
    <div ref={host} data-testid="metaproject-board-host" className="flex-1 min-h-0 overflow-hidden" />
  </div>;
}

function BrowserButton(target: Target) {
  const [error, setError] = useState<MetaprojectFailure | null>(null);
  return <><button className={mpButton} onClick={async () => {
    setError(null);
    try { const result = await api.invoke('metaproject:board-browser', target); if (!result.ok) setError(result.reason); }
    catch { setError('unavailable'); }
  }}>Open in Browser</button>{error && <span role="alert">{failureCopy[error]}</span>}</>;
}

interface PanelProps {
  name: string; projectId: number; assignment: Load<MetaprojectAssignment>; covered: boolean;
  controls: ControlRef; onClose: () => void; onSettings: () => void; onReload: () => void;
}

/** Keeps the Board affordances visible while the guest is absent, loading, denied or temporarily covered. */
export function BoardPanel({ name, projectId, assignment, covered, controls, onClose, onSettings, onReload }: PanelProps) {
  const { snapshot } = useMetaprojectSession();
  const signIn = useSignInIntent(projectId);
  const closeButton = useRef<HTMLButtonElement>(null);
  const prompted = useRef(false);
  const [cancelled, setCancelled] = useState(false);
  const requestSignIn = useCallback(() => signIn(`Open Board for ${name}`, () => setCancelled(false), () => setCancelled(true)), [name, signIn]);
  const linked = assignment.kind === 'loaded' && assignment.value.kind === 'linked' ? assignment.value : null;
  const revision = linked?.revision;
  const returnFocus = useCallback(() => { closeButton.current?.focus(); }, []);
  useLayoutEffect(returnFocus, [returnFocus]);
  useEffect(() => {
    if (!revision || covered || !snapshot?.origin || snapshot.phase !== 'signed-out' || snapshot.retryRestore || prompted.current) return;
    prompted.current = true;
    requestSignIn();
  }, [revision, covered, snapshot, requestSignIn]);
  return <section aria-label={`Board for ${name}`} className="absolute inset-0 flex min-h-0 flex-col overflow-auto bg-[--surface-sheet] text-sm text-[--text]"
    onKeyDown={(event) => { if (event.key === 'Escape' && !covered) { event.stopPropagation(); onClose(); } }}>
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 p-3">
      <h2 className="min-w-0 break-words font-semibold">Board · {name}</h2>
      <button ref={closeButton} className={mpButton} onClick={onClose}>Return to workspace</button>
    </header>
    {snapshot?.phase === 'signed-in' && !cancelled && <div className="px-3"><SignedInPersistenceWarning /></div>}
    {assignment.kind === 'loading' && <p className="p-3" role="status">Loading assignment…</p>}
    {assignment.kind === 'error' && <div className="p-3" role="alert">{failureCopy[assignment.reason]} <button className={mpButton} onClick={onReload}>Retry assignment</button></div>}
    {assignment.kind === 'loaded' && !linked && <div className="space-y-2 p-3">
      <p>{assignment.value.kind === 'origin-mismatch' ? failureCopy['origin-mismatch'] : 'This folder has no usable Board assignment.'}</p>
      <button className={mpButton} onClick={onSettings}>Open Project Settings</button>
    </div>}
    {linked && snapshot?.phase === 'signed-in' && !cancelled && <BoardLease key={`${snapshot.epoch}:${linked.revision}`} projectId={projectId} revision={linked.revision} epoch={snapshot.epoch} covered={covered} controls={controls} onReturn={returnFocus} onSettings={onSettings} />}
    {linked && (snapshot?.phase !== 'signed-in' || cancelled) && <div className="space-y-3 p-3">
      {snapshot?.phase === 'signed-in' ? <button className={mpButton} onClick={() => setCancelled(false)}>Open Board</button> :
        <AccountStatus onSignIn={requestSignIn} />}
      <BrowserButton projectId={projectId} revision={linked.revision} />
    </div>}
  </section>;
}
