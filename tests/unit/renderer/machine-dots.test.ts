/**
 * Pure machine-switcher logic (docs/specs/machine-switcher-dots.md AC5, AC6, AC15, AC16, AC19,
 * AC22, AC25, AC26, AC27): dot list, active-id fallback, roving focus, labels and remote sections.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMachineList, dotAccessibleName, sameMachines, switcherLayout, dotTooltip, filterByName, lastSeen, remoteSections, resolveActiveId, stepFocus,
} from '@renderer/machine-dots';
import { LOCAL_MACHINE_ID, type MachineDot } from '@renderer/machine-switcher-contract';
import type { FleetEntry } from '@shared/p2p-contract';
import type { Project, Root } from '@shared/types';

const HOUR = 3600_000;
const NOW = 1_000 * HOUR;

function peer(deviceId: string, name: string, extra: Partial<FleetEntry> = {}): FleetEntry {
  return { deviceId, name, online: true, lastSeenAt: null, ...extra };
}

function project(id: number, name: string, extra: Partial<Project> = {}): Project {
  return {
    id, name, rootId: 1, path: `/w/${name}`, metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false, firstLaunchedAt: null, config: {}, ...extra,
  };
}

function root(id: number, path: string): Root {
  return { id, path, addedAt: '2026-01-01T00:00:00Z', sortOrder: id };
}

const ids = (list: { id: number }[]) => list.map((p) => p.id);

describe('buildMachineList', () => {
  it('puts this machine first under the sentinel id, then peers sorted by name', () => {
    const list = buildMachineList('Laptop', [peer('c', 'Tower'), peer('a', 'Atlas'), peer('b', 'mini')]);
    expect(list.map((m) => m.deviceId)).toEqual([LOCAL_MACHINE_ID, 'a', 'b', 'c']);
    expect(list[0]).toEqual({ deviceId: LOCAL_MACHINE_ID, name: 'Laptop', online: true, lastSeenAt: null, self: true });
    expect(list.slice(1).every((m) => m.self === false)).toBe(true);
  });

  it('breaks name ties by device id, whatever the input order', () => {
    const one = buildMachineList('L', [peer('zz', 'Mac'), peer('aa', 'Mac')]);
    const two = buildMachineList('L', [peer('aa', 'Mac'), peer('zz', 'Mac')]);
    expect(one.map((m) => m.deviceId)).toEqual([LOCAL_MACHINE_ID, 'aa', 'zz']);
    expect(two.map((m) => m.deviceId)).toEqual(one.map((m) => m.deviceId));
  });

  it('drops a fleet entry flagged self, so this machine never gets a second dot', () => {
    const list = buildMachineList('Laptop', [peer('me', 'Laptop', { self: true }), peer('t', 'Tower')]);
    expect(list.map((m) => m.deviceId)).toEqual([LOCAL_MACHINE_ID, 't']);
  });

  it('keeps peer state fields and strips anything else', () => {
    const [, p] = buildMachineList('L', [peer('t', 'Tower', { online: false, lastSeenAt: 42 })]);
    expect(p).toEqual({ deviceId: 't', name: 'Tower', online: false, lastSeenAt: 42, self: false });
  });

  it.each(['', '   '])('names this machine "This machine" when the device name is %j', (name) => {
    expect(buildMachineList(name, [])[0]!.name).toBe('This machine');
  });

  it('does not mutate the fleet array it is given', () => {
    const fleet = [peer('b', 'B'), peer('a', 'A')];
    buildMachineList('L', fleet);
    expect(fleet.map((f) => f.deviceId)).toEqual(['b', 'a']);
  });
});

describe('resolveActiveId', () => {
  const list = buildMachineList('L', [peer('t', 'Tower')]);
  it('keeps an id that is in the list', () => expect(resolveActiveId('t', list)).toBe('t'));
  it('falls back to this machine when the id is missing', () => expect(resolveActiveId('gone', list)).toBe(LOCAL_MACHINE_ID));
});

describe('stepFocus', () => {
  it.each([
    [0, 3, 'ArrowRight', 1],
    [2, 3, 'ArrowRight', 0],
    [1, 3, 'ArrowLeft', 0],
    [0, 3, 'ArrowLeft', 2],
    [1, 3, 'Home', 0],
    [1, 3, 'End', 2],
  ])('from %i of %i, %s goes to %i', (i, n, key, want) => {
    expect(stepFocus(i, n, key)).toBe(want);
  });

  it.each(['Enter', ' ', 'ArrowUp', 'Tab', 'a'])('ignores %j', (key) => {
    expect(stepFocus(1, 3, key)).toBeNull();
  });
});

describe('lastSeen', () => {
  it.each([
    [null, 'never seen'],
    [NOW - 59 * 60_000, 'last seen <1h ago'],
    [NOW + 5 * HOUR, 'last seen <1h ago'],
    [NOW - 3 * HOUR, 'last seen 3h ago'],
    [NOW - 47 * HOUR, 'last seen 47h ago'],
    [NOW - 48 * HOUR, 'last seen 2d ago'],
    [NOW - 100 * HOUR, 'last seen 4d ago'],
  ])('%s reads %j', (ts, want) => {
    expect(lastSeen(ts, NOW)).toBe(want);
  });
});

const local = (name: string): MachineDot => buildMachineList(name, [])[0]!;
const online: MachineDot = { deviceId: 't', name: 'Studio Mac', online: true, lastSeenAt: null, self: false };
const offline: MachineDot = { deviceId: 't', name: 'Studio Mac', online: false, lastSeenAt: NOW - 3 * HOUR, self: false };

describe('dotTooltip', () => {
  it('reads "<name> · online"', () => expect(dotTooltip(online, NOW)).toBe('Studio Mac · online'));
  it('reads "<name> · offline · <last seen>"', () => {
    expect(dotTooltip(offline, NOW)).toBe('Studio Mac · offline · last seen 3h ago');
    expect(dotTooltip({ ...offline, lastSeenAt: null }, NOW)).toBe('Studio Mac · offline · never seen');
  });
  it('reads "<name> · this machine" for this machine', () => expect(dotTooltip(local('Laptop'), NOW)).toBe('Laptop · this machine'));
  it('reads just "This machine" under the fallback name', () => expect(dotTooltip(local(''), NOW)).toBe('This machine'));
});

describe('dotAccessibleName', () => {
  it('reads "<name>, online"', () => expect(dotAccessibleName(online, NOW)).toBe('Studio Mac, online'));
  it('reads "<name>, offline, <last seen>"', () => {
    expect(dotAccessibleName(offline, NOW)).toBe('Studio Mac, offline, last seen 3h ago');
  });
  it('reads "<name>, this machine" for this machine', () => {
    expect(dotAccessibleName(local('Laptop'), NOW)).toBe('Laptop, this machine');
  });
  it('reads just "This machine" under the fallback name', () => expect(dotAccessibleName(local(''), NOW)).toBe('This machine'));
});

describe('filterByName', () => {
  const rows = [project(1, 'Alpha'), project(2, 'beta'), project(3, 'ALPHABET')];
  it('returns every row when the filter is empty', () => expect(ids(filterByName(rows, ''))).toEqual([1, 2, 3]));
  it('matches a case-insensitive substring', () => expect(ids(filterByName(rows, 'alPHa'))).toEqual([1, 3]));
  it('matches inside the name, not only at the start', () => expect(ids(filterByName(rows, 'ET'))).toEqual([2, 3]));

  it('tolerates rows whose name is not a string and excludes them while filtering', () => {
    const bad = [{ id: 9, name: 42 }, { id: 8, name: null }, { id: 7, name: { x: 1 } }, { id: 1, name: 'alpha' }];
    expect(() => filterByName(bad, 'a')).not.toThrow();
    expect(ids(filterByName(bad, 'a'))).toEqual([1]);
    expect(ids(filterByName(bad, ''))).toEqual([9, 8, 7, 1]);
  });
});

describe('remoteSections', () => {
  const roots = [root(1, '/work'), root(2, '/play')];
  const t = (h: number) => new Date(NOW - h * HOUR).toISOString();

  it('builds In use, Recents (newest first, minus In use), folders per root, then orphans', () => {
    const projects = [
      project(1, 'live', { lastOpenedAt: t(0) }),
      project(2, 'old', { lastOpenedAt: t(10) }),
      project(3, 'new', { lastOpenedAt: t(1), rootId: 2 }),
      project(4, 'never'),
      project(5, 'stray', { rootId: 99 }),
    ];
    const s = remoteSections(projects, roots, new Set([1]), '');
    expect(ids(s.inUse)).toEqual([1]);
    expect(ids(s.recents)).toEqual([3, 2]);
    expect(s.projects!.folders.map((f) => [f.root.id, ids(f.projects)])).toEqual([[1, [1, 2, 4]], [2, [3]]]);
    expect(ids(s.projects!.orphans)).toEqual([5]);
  });

  it('caps Recents at 6 with no filter and uncaps it while filtering', () => {
    const projects = Array.from({ length: 9 }, (_, i) => project(i + 1, `p${i + 1}`, { lastOpenedAt: t(i) }));
    expect(ids(remoteSections(projects, roots, new Set(), '').recents)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(remoteSections(projects, roots, new Set(), 'p').recents)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns empty In use and Recents when nothing is live or opened', () => {
    const s = remoteSections([project(1, 'a')], roots, new Set(), '');
    expect(s.inUse).toEqual([]);
    expect(s.recents).toEqual([]);
  });

  it('drops a root folder with no projects', () => {
    const s = remoteSections([project(1, 'a')], roots, new Set(), '');
    expect(s.projects!.folders.map((f) => f.root.id)).toEqual([1]);
  });

  it('has no Projects section at all when the machine has no projects', () => {
    expect(remoteSections([], roots, new Set(), '').projects).toBeNull();
    expect(remoteSections([], roots, new Set(), 'x').projects).toBeNull();
  });

  it('filters every section by name and drops roots left empty', () => {
    const projects = [
      project(1, 'Alpha', { lastOpenedAt: t(0) }),
      project(2, 'beta', { lastOpenedAt: t(1) }),
      project(3, 'gamma', { rootId: 2 }),
      project(4, 'alpine', { rootId: 99 }),
    ];
    const s = remoteSections(projects, roots, new Set([1, 2]), 'ALP');
    expect(ids(s.inUse)).toEqual([1]);
    expect(ids(s.recents)).toEqual([]);
    expect(s.projects!.folders.map((f) => [f.root.id, ids(f.projects)])).toEqual([[1, [1]]]);
    expect(ids(s.projects!.orphans)).toEqual([4]);
  });

  it('with no matches hides In use and Recents but keeps an empty Projects section', () => {
    const projects = [project(1, 'a', { lastOpenedAt: t(0) }), project(2, 'b')];
    const s = remoteSections(projects, roots, new Set([2]), 'zzz');
    expect(s.inUse).toEqual([]);
    expect(s.recents).toEqual([]);
    expect(s.projects).toEqual({ folders: [], orphans: [] });
  });

  it('tolerates rows with a non-string name or lastOpenedAt, rendering the name as empty', () => {
    const bad = [
      { ...project(1, 'x'), name: 7 as unknown as string, lastOpenedAt: 5 as unknown as string },
      project(2, 'ok', { lastOpenedAt: t(1) }),
    ];
    expect(() => remoteSections(bad, roots, new Set([1]), '')).not.toThrow();
    const s = remoteSections(bad, roots, new Set([1]), '');
    expect(s.inUse.map((p) => p.name)).toEqual(['']);
    expect(ids(s.recents)).toEqual([2]);
    expect(ids(remoteSections(bad, roots, new Set([1]), 'o').projects!.folders[0]!.projects)).toEqual([2]);
  });
});

describe('sameMachines', () => {
  const fleet = [peer('a', 'A', { lastSeenAt: 1 }), peer('b', 'B')];
  it('is true for content-equal lists built from fresh objects', () => {
    expect(sameMachines(fleet, fleet.map((m) => ({ ...m })))).toBe(true);
    expect(sameMachines(buildMachineList('L', fleet), buildMachineList('L', [peer('b', 'B'), peer('a', 'A', { lastSeenAt: 1 })]))).toBe(true);
  });
  it('treats a missing self like self: false', () => {
    expect(sameMachines([peer('a', 'A')], [peer('a', 'A', { self: false })])).toBe(true);
  });
  it.each([
    ['a name', [peer('a', 'A2', { lastSeenAt: 1 }), peer('b', 'B')]],
    ['online', [peer('a', 'A', { lastSeenAt: 1, online: false }), peer('b', 'B')]],
    ['lastSeenAt', [peer('a', 'A', { lastSeenAt: 2 }), peer('b', 'B')]],
    ['self', [peer('a', 'A', { lastSeenAt: 1, self: true }), peer('b', 'B')]],
    ['a device id', [peer('a', 'A', { lastSeenAt: 1 }), peer('c', 'B')]],
    ['the order', [peer('b', 'B'), peer('a', 'A', { lastSeenAt: 1 })]],
    ['the length', [peer('a', 'A', { lastSeenAt: 1 })]],
  ])('is false when %s differs', (_what, other) => {
    expect(sameMachines(fleet, other)).toBe(false);
  });
});

describe('switcherLayout', () => {
  const machines = buildMachineList('L', [peer('t', 'Tower')]);
  const [localDot, towerDot] = machines as [MachineDot, MachineDot];

  it('with only this machine: no switcher, bare local list, no panel attributes, list classes as before', () => {
    expect(switcherLayout({ machines: [localDot], active: localDot, activeId: LOCAL_MACHINE_ID })).toEqual({
      banded: false, remote: null, framing: 'bare', panelProps: {}, listClass: 'flex-initial min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7',
    });
  });

  it('with a peer while this machine is shown: switcher, shown local list, panel labelled by the local dot, list padded for the pill', () => {
    expect(switcherLayout({ machines, active: localDot, activeId: LOCAL_MACHINE_ID })).toEqual({
      banded: true, remote: null, framing: 'shown',
      panelProps: { role: 'tabpanel', id: 'switcher-panel', 'aria-labelledby': 'switcher-tab-local' },
      listClass: 'flex-initial min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7 pb-11',
    });
  });

  it('with the peer shown: remote dot, hidden local list, panel labelled by the peer', () => {
    expect(switcherLayout({ machines, active: towerDot, activeId: 't' })).toEqual({
      banded: true, remote: towerDot, framing: 'hidden',
      panelProps: { role: 'tabpanel', id: 'switcher-panel', 'aria-labelledby': 'switcher-tab-t' },
      listClass: 'flex-initial min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7 pb-11',
    });
  });
});
