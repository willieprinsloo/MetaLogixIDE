/**
 * Pure rules for a remote project's terminal tabs. The pane keeps tabs it opened (`opening`) and
 * tabs it closed (`closing`) on top of the host's polled shell list, so the strip reacts at once and
 * then agrees with the host's 3 s poll; these functions merge, reconcile and pick the shown tab.
 */
import { REMOTE_MENU_COPY } from '@renderer/remote-pane-contract';
import type { RemoteProjectShell } from './useRemoteProjectShells';

/** The host's display name, or "The other machine" when it is empty or blank. */
export function remoteMachineLabel(deviceName: string): string {
  return deviceName.trim() || REMOTE_MENU_COPY.unknownMachine;
}

/** The `shellIndex` of a launch RPC result, or `null` when the result does not carry one. */
export function rpcIndex(result: unknown): number | null {
  return result && typeof result === 'object' && 'shellIndex' in result && typeof result.shellIndex === 'number' ? result.shellIndex : null;
}

/** The tabs to show: polled shells minus closed ones, plus opened ones the host has not listed yet (labelled "Terminal"), in shell order. */
export function mergeRemoteTabs(polled: readonly RemoteProjectShell[], opening: readonly number[], closing: ReadonlySet<number>): RemoteProjectShell[] {
  const listed = new Set(polled.map((s) => s.shellIndex));
  const live = polled.filter((s) => !closing.has(s.shellIndex));
  const pending = opening.filter((i) => !listed.has(i) && !closing.has(i))
    .map((shellIndex): RemoteProjectShell => ({ shellIndex, launchName: 'Terminal', agent: null, agentState: null }));
  return [...live, ...pending].sort((a, b) => a.shellIndex - b.shellIndex);
}

/** Drops opened tabs the host now lists; returns the same array when nothing changed. */
export function reconcileOpening(opening: readonly number[], polledIds: ReadonlySet<number>): readonly number[] {
  return opening.some((i) => polledIds.has(i)) ? opening.filter((i) => !polledIds.has(i)) : opening;
}

/** Drops closed tabs the host no longer lists, unless their kill is still in flight; returns the same set when nothing changed. */
export function reconcileClosing(closing: ReadonlySet<number>, polledIds: ReadonlySet<number>, inFlight: ReadonlySet<number>): ReadonlySet<number> {
  const done = (i: number): boolean => !polledIds.has(i) && !inFlight.has(i);
  return [...closing].some(done) ? new Set([...closing].filter((i) => !done(i))) : closing;
}

export interface ShownInput {
  readonly shells: readonly RemoteProjectShell[];
  readonly picked: number | null;
  readonly launched: number | null;
  /** True before the host has listed anything for this pane (nothing polled, opened or closed). */
  readonly awaitingList: boolean;
}

/** The shown tab: the picked tab, else the first-launched tab, else the first live tab; before the first list, the launch result. */
export function shownShell({ shells, picked, launched, awaitingList }: ShownInput): number | null {
  const has = (i: number | null): i is number => i !== null && shells.some((s) => s.shellIndex === i);
  if (has(picked)) return picked;
  if (has(launched)) return launched;
  return shells[0]?.shellIndex ?? (awaitingList ? launched : null);
}

/** The tab shown once `closed` is gone, by the same fallback; the caller makes it the picked tab. */
export function shownAfterClose({ shells, picked, launched }: Omit<ShownInput, 'awaitingList'>, closed: number): number | null {
  const without = (i: number | null): number | null => (i === closed ? null : i);
  return shownShell({ shells: shells.filter((s) => s.shellIndex !== closed), picked: without(picked), launched: without(launched), awaitingList: false });
}
