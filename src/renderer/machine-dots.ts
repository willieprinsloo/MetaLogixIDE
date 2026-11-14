/**
 * Pure logic behind the sidebar's machine switcher (docs/specs/machine-switcher-dots.md): the
 * ordered dot list, the active-id fallback, roving-focus steps, the dot labels, and the sections of
 * a remote machine's project list. No React and no IPC, so every rule is unit-testable on its own.
 */
import type { FleetEntry } from '@shared/p2p-contract';
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

/** Tooltip text for a dot (AC25): "<name> · online", "<name> · offline · <last seen>", "<name> · this machine" or "This machine". */
export function dotTooltip(m: MachineDot, now: number): string {
  return [m.name, ...stateParts(m, now)].join(' · ');
}

/** Accessible name for a dot (AC26): the tooltip's parts joined with ", ". */
export function dotAccessibleName(m: MachineDot, now: number): string {
  return [m.name, ...stateParts(m, now)].join(', ');
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
