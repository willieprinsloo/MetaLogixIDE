import { describe, it, expect, vi } from 'vitest';
import { addRootFromPicker, buildAddMenuItems, rescanRoots } from '@renderer/sidebar-add-menu';
import { SIDEBAR_COPY, SIDEBAR_TESTIDS } from '@renderer/sidebar-copy';

function build(rescanning: boolean) {
  const cbs = { onNewProject: vi.fn(), onAddRoot: vi.fn(), onRescan: vi.fn() };
  return { cbs, items: buildAddMenuItems({ rescanning, ...cbs }) };
}

describe('buildAddMenuItems', () => {
  it('returns the three items in order with copy, hint and test ids', () => {
    const { items } = build(false);
    expect(items.map((i) => [i.label, i.hint, i.testId])).toEqual([
      [SIDEBAR_COPY.menuNewProject, SIDEBAR_COPY.menuNewProjectHint, SIDEBAR_TESTIDS.menuNewProject],
      [SIDEBAR_COPY.menuAddRoot, undefined, SIDEBAR_TESTIDS.menuAddRoot],
      [SIDEBAR_COPY.menuRescan, undefined, SIDEBAR_TESTIDS.menuRescan],
    ]);
  });

  it('wires each item to its own callback only', () => {
    const { cbs, items } = build(false);
    const order = [cbs.onNewProject, cbs.onAddRoot, cbs.onRescan];
    expect(items).toHaveLength(order.length);
    items.forEach((item, i) => {
      item.onClick();
      order.forEach((cb, j) => expect(cb).toHaveBeenCalledTimes(j <= i ? 1 : 0));
    });
  });

  it('enables every item while idle', () => {
    expect(build(false).items.map((i) => !!i.disabled)).toEqual([false, false, false]);
  });

  it('labels the rescan item "Rescanning…" and disables only it while running', () => {
    const { items } = build(true);
    expect(items[2]?.label).toBe(SIDEBAR_COPY.menuRescanning);
    expect(items.map((i) => !!i.disabled)).toEqual([false, false, true]);
  });
});

describe('addRootFromPicker', () => {
  function deps(path: string | null) {
    const calls: string[] = [];
    return {
      calls,
      d: {
        pickDirectory: vi.fn(async () => { calls.push('pick'); return path; }),
        addRoot: vi.fn(async (p: string) => { calls.push(`add:${p}`); }),
        refreshRoots: vi.fn(async () => { calls.push('roots'); }),
        refreshProjects: vi.fn(async () => { calls.push('projects'); }),
      },
    };
  }

  it('adds the picked path, then refreshes roots and projects in order', async () => {
    const { calls, d } = deps('/code');
    await addRootFromPicker(d);
    expect(calls).toEqual(['pick', 'add:/code', 'roots', 'projects']);
  });

  it('does nothing after the picker when it is cancelled', async () => {
    const { calls, d } = deps(null);
    await addRootFromPicker(d);
    expect(calls).toEqual(['pick']);
  });
});

describe('rescanRoots', () => {
  function deps(rescan: (id: number) => Promise<number>) {
    const states: boolean[] = [];
    const d = {
      rootIds: [1, 2],
      rescanRoot: vi.fn(rescan),
      refreshProjects: vi.fn(async () => undefined),
      notify: vi.fn(),
      setRescanning: vi.fn((v: boolean) => { states.push(v); }),
    };
    return { d, states };
  }

  it('rescans every root, refreshes, and reports the totals', async () => {
    const { d, states } = deps(async (id) => id * 3);
    await rescanRoots(d);
    expect(d.rescanRoot.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(d.refreshProjects).toHaveBeenCalledTimes(1);
    expect(d.notify).toHaveBeenCalledWith('Rescanned 2 roots', { kind: 'success', detail: '9 project folders on disk' });
    expect(states).toEqual([true, false]);
  });

  it('uses singular wording for one root and one folder', async () => {
    const { d } = deps(async () => 1);
    d.rootIds = [7];
    await rescanRoots(d);
    expect(d.notify).toHaveBeenCalledWith('Rescanned 1 root', { kind: 'success', detail: '1 project folder on disk' });
  });

  it('reports a failure and still clears the running state', async () => {
    const { d, states } = deps(async () => { throw new Error('disk gone'); });
    await rescanRoots(d);
    expect(d.notify).toHaveBeenCalledWith('Rescan failed', { kind: 'error', detail: 'disk gone' });
    expect(d.refreshProjects).not.toHaveBeenCalled();
    expect(states).toEqual([true, false]);
  });
});

describe('buildAddMenuItems on Linux (AC6)', () => {
  it('hints New project… as Ctrl+Shift+N with no Mac glyph', () => {
    const items = buildAddMenuItems({ rescanning: false, onNewProject: vi.fn(), onAddRoot: vi.fn(), onRescan: vi.fn(), platform: 'linux' });
    expect(items[0]?.hint).toBe('Ctrl+Shift+N');
  });

  it('keeps ⌘⇧N when told mac explicitly (AC7)', () => {
    const items = buildAddMenuItems({ rescanning: false, onNewProject: vi.fn(), onAddRoot: vi.fn(), onRescan: vi.fn(), platform: 'mac' });
    expect(items[0]?.hint).toBe('⌘⇧N');
  });
});
