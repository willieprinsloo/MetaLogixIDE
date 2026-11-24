/**
 * Pure logic behind the sidebar's machine switcher (docs/specs/machine-switcher-dots.md): the
 * ordered dot list, the active-id fallback, roving-focus steps, the dot labels, and the sections of
 * a remote machine's project list. No React and no IPC, so every rule is unit-testable on its own.
 */
import type { FleetEntry } from '@shared/p2p-contract';
import type { AgentState } from '@shared/agent-state';
import type { Project, Root } from '@shared/types';
import { LOCAL_MACHINE_ID, type MachineDot } from './machine-switcher-contract';
import { MACHINE_COPY } from './sidebar-copy';

/** One root folder of a remote machine with the projects shown under it. */
export interface RemoteFolder { root: Root; projects: Project[] }

/** A remote machine's list; `projects` is null when the machine has no projects at all. */
export interface RemoteSections {
  inUse: Project[];
  recents: Project[];
  projects: { folders: RemoteFolder[]; orphans: Project[] } | null;
}

const RECENTS_CAP = 6;

/** DOM id of the sidebar list area the dots control (`role="tabpanel"`). */
export const SWITCHER_PANEL_ID = 'switcher-panel';

/** DOM id of a dot's tab, so the tabpanel can be labelled by the active dot. */
export function machineTabId(deviceId: string): string {
  return `switcher-tab-${deviceId}`;
}
const HOUR_MS = 3600_000;

/** This machine's dot first (fallback name when `selfName` is blank), then peers by name with device id as tie-break; `self` fleet entries are dropped. */
export function buildMachineList(selfName: string, fleet: readonly FleetEntry[]): MachineDot[] {
  const name = selfName.trim() || MACHINE_COPY.thisMachineFallback;
  const local: MachineDot = { deviceId: LOCAL_MACHINE_ID, name, online: true, lastSeenAt: null, self: true };
  const peers = fleet
    .filter((e) => !e.self)
    .map(({ deviceId, name: n, online, lastSeenAt }): MachineDot => ({ deviceId, name: n, online, lastSeenAt, self: false }))
    .sort((a, b) => a.name.localeCompare(b.name) || compareIds(a.deviceId, b.deviceId));
  return [local, ...peers];
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** `activeId` when it is still in `list`, otherwise this machine's id. */
export function resolveActiveId(activeId: string, list: readonly MachineDot[]): string {
  return list.some((m) => m.deviceId === activeId) ? activeId : LOCAL_MACHINE_ID;
}

/** Index focus moves to from `i` of `n` dots for `key` (Left/Right wrap, Home/End), or null for any other key. */
export function stepFocus(i: number, n: number, key: string): number | null {
  switch (key) {
    case 'ArrowRight': return (i + 1) % n;
    case 'ArrowLeft': return (i - 1 + n) % n;
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

/** Offline wording for a last-seen timestamp relative to `now`: "never seen", "last seen <1h ago", "…Nh ago" under 48 h, else "…Nd ago". */
export function lastSeen(ts: number | null, now: number): string {
  if (ts == null) return 'never seen';
  const h = Math.max(0, Math.floor((now - ts) / HOUR_MS));
  if (h < 1) return 'last seen <1h ago';
  if (h < 48) return `last seen ${h}h ago`;
  return `last seen ${Math.floor(h / 24)}d ago`;
}

function stateParts(m: MachineDot, now: number): string[] {
  if (m.self) return m.name === MACHINE_COPY.thisMachineFallback ? [] : [MACHINE_COPY.thisMachineTag];
  return m.online ? [MACHINE_COPY.online] : [MACHINE_COPY.offline, lastSeen(m.lastSeenAt, now)];
}

function agentWord(m: MachineDot): string[] {
  return m.agentState && m.online ? [MACHINE_COPY.agentState[m.agentState]] : [];
}

/** Tooltip text for a dot (AC25, AC35): "<name> · online", "<name> · offline · <last seen>", "<name> · this machine" or "This machine", then " · <status>" while an agent runs. */
export function dotTooltip(m: MachineDot, now: number): string {
  return [m.name, ...stateParts(m, now), ...agentWord(m)].join(' · ');
}

/** Accessible name for a dot (AC26, AC35): the tooltip's parts joined with ", ", the status read as "agent <status>". */
export function dotAccessibleName(m: MachineDot, now: number): string {
  return [m.name, ...stateParts(m, now), ...agentWord(m).map((w) => `${MACHINE_COPY.agentPrefix} ${w}`)].join(', ');
}

/** Rows whose name contains `filter` case-insensitively; every row when `filter` is empty. A non-string name never matches and never throws. */
export function filterByName<T extends { name: unknown }>(items: readonly T[], filter: string): T[] {
  if (!filter) return [...items];
  const needle = filter.toLowerCase();
  return items.filter((p) => typeof p.name === 'string' && p.name.toLowerCase().includes(needle));
}

function sanitise(p: Project): Project {
  const name = typeof p.name === 'string' ? p.name : '';
  const lastOpenedAt = typeof p.lastOpenedAt === 'string' ? p.lastOpenedAt : null;
  return name === p.name && lastOpenedAt === p.lastOpenedAt ? p : { ...p, name, lastOpenedAt };
}

function recentsOf(projects: Project[], aliveIds: ReadonlySet<number>, filter: string): Project[] {
  const opened = projects
    .filter((p) => !aliveIds.has(p.id) && p.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
  return filter ? filterByName(opened, filter) : opened.slice(0, RECENTS_CAP);
}

/**
 * A remote machine's sections (AC16, AC19): In use (live shells), Recents (newest first, minus In
 * use, capped at 6 only without a filter), folders per root with empty ones dropped, and projects
 * with no matching root as orphans. Untrusted rows with a non-string name render as an empty name.
 */
export function remoteSections(
  rows: readonly Project[], roots: readonly Root[], aliveIds: ReadonlySet<number>, filter: string,
): RemoteSections {
  const all = rows.map(sanitise);
  const shown = filterByName(all, filter);
  const rootIds = new Set(roots.map((r) => r.id));
  const folders = roots
    .map((root) => ({ root, projects: shown.filter((p) => p.rootId === root.id) }))
    .filter((f) => f.projects.length > 0);
  return {
    inUse: shown.filter((p) => aliveIds.has(p.id)),
    recents: recentsOf(all, aliveIds, filter),
    projects: all.length > 0 ? { folders, orphans: shown.filter((p) => !rootIds.has(p.rootId)) } : null,
  };
}

type MachineFields = Pick<FleetEntry, 'deviceId' | 'name' | 'online' | 'lastSeenAt' | 'self'>;
const machineKey = (m: MachineFields) => `${m.deviceId}|${m.name}|${m.online}|${m.lastSeenAt}|${m.self === true}`;

/** True when two fleet (or dot) lists hold the same machines in the same order: device id, name, online, last seen and self. */
export function sameMachines(a: readonly MachineFields[], b: readonly MachineFields[]): boolean {
  return a.length === b.length && a.every((m, i) => machineKey(m) === machineKey(b[i]!));
}

/** `role`/`id`/`aria-labelledby` the sidebar list area takes while the band is shown; empty otherwise. */
export type PanelProps = { role: 'tabpanel'; id: string; 'aria-labelledby': string } | Record<string, never>;

const LIST_CLASS = 'flex-initial min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7';

/** How the sidebar lays out for the current switcher state; see {@link switcherLayout}. */
export interface SwitcherLayout {
  banded: boolean;
  remote: MachineDot | null;
  framing: 'bare' | 'shown' | 'hidden';
  panelProps: PanelProps;
  listClass: string;
}

/**
 * The sidebar's layout decisions in one place: the band shows once a peer exists; the shown dot is
 * `remote` unless it is this machine; the local list is 'bare' (no wrapper, the pre-switcher DOM)
 * without the band, otherwise 'shown' or 'hidden'; the list area is the active dot's tabpanel only
 * with the band; and while the switcher floats over the list, the list gets bottom padding so its
 * last row scrolls clear above the pill (AC33). Nothing else about the list or drag fill changes.
 */
export function switcherLayout(s: { machines: readonly MachineDot[]; active: MachineDot; activeId: string }): SwitcherLayout {
  const remote = s.active.self ? null : s.active;
  if (s.machines.length < 2) {
    return { banded: false, remote: null, framing: 'bare', panelProps: {}, listClass: LIST_CLASS };
  }
  return {
    banded: true,
    remote,
    framing: remote ? 'hidden' : 'shown',
    panelProps: { role: 'tabpanel', id: SWITCHER_PANEL_ID, 'aria-labelledby': machineTabId(s.activeId) },
    listClass: `${LIST_CLASS} pb-9`,
  };
}

/** One peer's latest `shells.alive` result: its live project ids and its overall agent state. */
export interface PeerShells { aliveProjectIds: ReadonlySet<number>; agentState: AgentState | null }

/** The dots with their agent state (AC34): this machine takes `localState`, an online peer its polled state, anything else null. */
export function withAgentStates(
  base: readonly MachineDot[], localState: AgentState | null, shells: ReadonlyMap<string, PeerShells>,
): MachineDot[] {
  return base.map((m) => ({
    ...m,
    agentState: m.self ? localState : (m.online ? shells.get(m.deviceId)?.agentState ?? null : null),
  }));
}

/** The visible dot's class list and state attributes; colours live in styles.css `.machine-dot`. */
export interface DotAttrs {
  className: string;
  'data-agent-state'?: AgentState;
  'data-online': '0' | '1';
  'data-active'?: '';
}

const DOT_BASE = 'machine-dot block rounded-full transition-[width,height,background-color,opacity] duration-150 motion-reduce:transition-none';

/** Solid dot (AC21, AC32, AC34): 8px, 10px when active; coloured by agent state while online; only a busy online dot pulses (`live-dot`). */
export function dotAttrs(m: MachineDot, active: boolean): DotAttrs {
  const tint = m.online ? m.agentState ?? undefined : undefined;
  const size = active ? 'w-2.5 h-2.5' : 'w-2 h-2';
  return {
    className: `${DOT_BASE} ${size}${tint === 'busy' ? ' live-dot' : ''}`,
    'data-agent-state': tint,
    'data-online': m.online ? '1' : '0',
    'data-active': active ? '' : undefined,
  };
}
