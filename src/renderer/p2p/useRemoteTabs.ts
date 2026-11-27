/**
 * State hooks behind a remote project's terminal tabs. `useRemoteTabs` owns the tab list (the polled
 * host list plus optimistic opens and closes, see `remote-tabs.ts`), the shown tab and the open /
 * close / select actions, including keyboard focus for a picked or opened tab. `useRemoteShellMenu`
 * backs the + menu with the host's saved profiles and its auto-launch default.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { terminalFocus } from '@renderer/hooks/useWindowTerminalFocus';
import type { RemoteShellMenu, ShellLaunched, ShellMenuProfile } from '@renderer/components/ShellTabsBar';
import { errMessage } from './err-message';
import { mergeRemoteTabs, reconcileClosing, reconcileOpening, rpcIndex, shownAfterClose, shownShell } from './remote-tabs';
import { useRemoteProjectShells, type RemoteProjectShell } from './useRemoteProjectShells';

/** One RPC to the pane's host, scoped to its project (`projectId` is added to `params`). */
export type RemoteCall = (method: string, params: Record<string, unknown>) => Promise<{ result: unknown }>;

export type RemoteOpenMethod = 'shells.launchProfile' | 'shells.launchPlain';

export interface RemoteTabs {
  readonly shells: readonly RemoteProjectShell[];
  /** The shown tab, or `null` for none (still loading, or the empty state). */
  readonly shellIndex: number | null;
  /** Why the pane's first `shells.launch` failed, if it did. */
  readonly error: string | null;
  /** Whether the pane's first `shells.launch` has settled (either way); until then the pane is still loading. */
  readonly attached: boolean;
  readonly select: (shellIndex: number) => void;
  readonly open: (method: RemoteOpenMethod, params: Record<string, unknown>, onLaunched?: ShellLaunched) => Promise<void>;
  readonly close: (shellIndex: number) => void;
  readonly call: RemoteCall;
}

const without = (set: ReadonlySet<number>, index: number): ReadonlySet<number> => {
  const next = new Set(set);
  next.delete(index);
  return next;
};

/**
 * The shell the pane attaches to when it opens. `shells.launch` is idempotent per project on the host
 * (it reuses the live shell), so StrictMode's double mount just launches twice and the `cancelled`
 * flag drops the stale result; there is deliberately no kill on cancel.
 */
function useLaunchedShell(call: RemoteCall) {
  const [launched, setLaunched] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setAttached(false);
    call('shells.launch', {}).then(
      ({ result }) => { if (!cancelled) { setLaunched(rpcIndex(result) ?? 0); setAttached(true); } },
      (e: unknown) => { if (!cancelled) { setError(errMessage(e)); setAttached(true); } },
    );
    return () => { cancelled = true; };
  }, [call]);
  return { launched, setLaunched, error, attached };
}

/** Tabs opened or closed here, kept until the host's polled list agrees. */
function useOptimisticTabs(polled: readonly RemoteProjectShell[]) {
  const [opening, setOpening] = useState<readonly number[]>([]);
  const [closing, setClosing] = useState<ReadonlySet<number>>(new Set());
  const inFlight = useRef(new Set<number>());
  const polledIds = useMemo(() => new Set(polled.map((s) => s.shellIndex)), [polled]);
  const polledRef = useRef(polledIds);
  polledRef.current = polledIds;
  useEffect(() => { setOpening((prev) => reconcileOpening(prev, polledIds)); }, [polledIds, opening]);
  useEffect(() => { setClosing((prev) => reconcileClosing(prev, polledIds, inFlight.current)); }, [polledIds]);
  const shells = useMemo(() => mergeRemoteTabs(polled, opening, closing), [polled, opening, closing]);
  const awaitingList = polled.length === 0 && opening.length === 0 && closing.size === 0;
  const markOpened = useCallback((i: number) => setOpening((prev) => (prev.includes(i) ? prev : [...prev, i])), []);
  const markClosing = useCallback((i: number) => {
    inFlight.current.add(i);
    setOpening((prev) => prev.filter((o) => o !== i));
    setClosing((prev) => new Set(prev).add(i));
  }, []);
  const settleClose = useCallback((i: number, killed: boolean) => {
    inFlight.current.delete(i);
    setClosing((prev) => (killed && polledRef.current.has(i) ? prev : without(prev, i)));
  }, []);
  return { shells, awaitingList, markOpened, markClosing, settleClose };
}

/**
 * The tab state of one remote project (AC11, AC14, AC15, AC17). Tabs opened here show at once and are
 * picked and focused; closed tabs vanish at once and the shown tab falls back to the picked, then the
 * first-launched, then the first live tab, which becomes the picked tab. A later notice request
 * (`openRequest` identity) picks its shell again.
 */
export function useRemoteTabs(deviceId: string, projectId: number, active: boolean, initialShellIndex: number | undefined, openRequest: unknown): RemoteTabs {
  const { shells: polled, refresh } = useRemoteProjectShells(deviceId, projectId, active);
  const call = useCallback<RemoteCall>((method, params) =>
    api.invoke('p2p:rpc-call', { deviceId, method, params: { projectId, ...params } }), [deviceId, projectId]);
  const { launched, setLaunched, error, attached } = useLaunchedShell(call);
  const [picked, setPicked] = useState<number | null>(initialShellIndex ?? null);
  useEffect(() => { if (initialShellIndex !== undefined) setPicked(initialShellIndex); }, [initialShellIndex, openRequest]);
  const tabs = useOptimisticTabs(polled);
  const { shells, markOpened, markClosing, settleClose } = tabs;
  const shellIndex = shownShell({ shells, picked, launched, awaitingList: tabs.awaitingList });
  const focusKey = useCallback((i: number) => ({ projectId, shellIndex: i, machine: deviceId }), [deviceId, projectId]);

  const select = useCallback((i: number) => {
    terminalFocus.cancelRequest();
    setPicked(i);
    terminalFocus.requestFocus(focusKey(i));
  }, [focusKey]);

  const open = useCallback(async (method: RemoteOpenMethod, params: Record<string, unknown>, onLaunched?: ShellLaunched) => {
    try {
      const index = rpcIndex((await call(method, params)).result);
      if (index === null) throw new Error('no shell index');
      markOpened(index);
      select(index);
      onLaunched?.(index);
      refresh();
    } catch (e) {
      toast('Could not open a terminal on the remote machine', { kind: 'error', detail: errMessage(e) });
    }
  }, [call, markOpened, select, refresh]);

  const close = useCallback((index: number) => {
    setPicked(shownAfterClose({ shells, picked, launched }, index));
    setLaunched((prev) => (prev === index ? null : prev));
    markClosing(index);
    call('shells.kill', { shellIndex: index }).then(() => { settleClose(index, true); refresh(); }, (e: unknown) => {
      settleClose(index, false);
      toast('Could not close the remote terminal', { kind: 'error', detail: errMessage(e) });
    });
  }, [shells, picked, launched, setLaunched, markClosing, settleClose, call, refresh]);

  return { shells, shellIndex, error, attached, select, open, close, call };
}

const PROFILE_SCOPES: ReadonlySet<unknown> = new Set(['project', 'global']);

/** Copies only a profile's name, scope and icon, so no command or environment a host sends can reach the menu (AC10). */
function toMenuProfile(raw: unknown): ShellMenuProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, scope, icon } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !PROFILE_SCOPES.has(scope)) return null;
  return { name, scope: scope as ShellMenuProfile['scope'], ...(typeof icon === 'string' ? { icon } : {}) };
}

const defaultNameOf = (result: unknown): string | null => {
  const name = result && typeof result === 'object' ? (result as { defaultName?: unknown }).defaultName : null;
  return typeof name === 'string' ? name : null;
};

/** The host's saved profiles for the + menu and the project's auto-launch default, both read and written on the host; `hostName` is shown when the host is too old. */
export function useRemoteShellMenu(call: RemoteCall, hostName: string): { menu: RemoteShellMenu; defaultName: string | null } {
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const menu = useMemo<RemoteShellMenu>(() => ({
    hostName,
    profiles: async () => {
      const { result } = await call('shells.cliProfiles', {});
      setDefaultName(defaultNameOf(result));
      const raw = result && typeof result === 'object' ? (result as { profiles?: unknown }).profiles : null;
      return Array.isArray(raw) ? raw.map(toMenuProfile).filter((p): p is ShellMenuProfile => p !== null) : [];
    },
    remove: async (name) => { await call('shells.removeCliProfile', { name }); },
    setDefault: async (name) => { setDefaultName(defaultNameOf((await call('shells.setDefaultCli', { name })).result)); },
  }), [call, hostName]);
  return { menu, defaultName };
}
