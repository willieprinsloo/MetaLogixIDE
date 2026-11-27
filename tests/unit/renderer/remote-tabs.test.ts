/** Remote tab list rules: optimistic opens and closes reconciled with the host's polled list, and the shown-tab fallback (AC14, AC15, AC17). */
import { describe, expect, it } from 'vitest';
import {
  mergeRemoteTabs, reconcileClosing, reconcileOpening, rpcIndex, shownAfterClose, shownShell,
} from '@renderer/p2p/remote-tabs';
import type { RemoteProjectShell } from '@renderer/p2p/useRemoteProjectShells';

const shell = (shellIndex: number, launchName = `S${shellIndex}`): RemoteProjectShell =>
  ({ shellIndex, launchName, agent: null, agentState: null });
const ids = (shells: readonly RemoteProjectShell[]): number[] => shells.map((s) => s.shellIndex);
const set = (...n: number[]): ReadonlySet<number> => new Set(n);

describe('rpcIndex', () => {
  it.each([
    [{ shellIndex: 4 }, 4],
    [{ shellIndex: 0 }, 0],
    [{ shellIndex: '4' }, null],
    [{}, null],
    [null, null],
    [undefined, null],
    [7, null],
  ])('reads the shell index from %j as %s', (result, expected) => {
    expect(rpcIndex(result)).toBe(expected);
  });
});

describe('mergeRemoteTabs', () => {
  it('shows a pending tab labelled "Terminal" until the host lists it, in shell order', () => {
    const merged = mergeRemoteTabs([shell(2), shell(5)], [3], set());
    expect(ids(merged)).toEqual([2, 3, 5]);
    expect(merged[1]).toEqual({ shellIndex: 3, launchName: 'Terminal', agent: null, agentState: null });
  });

  it('a polled entry wins over a pending one for the same index: exactly one chip, with the host label', () => {
    const merged = mergeRemoteTabs([shell(6, 'Claude')], [6], set());
    expect(merged).toEqual([shell(6, 'Claude')]);
  });

  it('hides a closing tab even while the host still lists it, and a closing pending tab', () => {
    expect(ids(mergeRemoteTabs([shell(2), shell(3)], [7], set(3, 7)))).toEqual([2]);
  });

  it('two pending launches give two distinct chips', () => {
    expect(ids(mergeRemoteTabs([shell(2)], [6, 7], set()))).toEqual([2, 6, 7]);
  });
});

describe('reconcileOpening', () => {
  it('drops a pending entry once polled and keeps the others', () => {
    expect(reconcileOpening([6, 7], set(2, 6))).toEqual([7]);
  });

  it('returns the same list when nothing changed, so state does not churn', () => {
    const opening = [6];
    expect(reconcileOpening(opening, set(2))).toBe(opening);
  });
});

describe('reconcileClosing', () => {
  it('keeps a closed tab hidden while the host still lists it', () => {
    const closing = set(3);
    expect(reconcileClosing(closing, set(2, 3), set())).toBe(closing);
  });

  it('drops a closed tab once the host stops listing it', () => {
    expect([...reconcileClosing(set(3, 4), set(2, 4), set())]).toEqual([4]);
  });

  it('keeps a tab whose kill is still in flight even when a poll omits it', () => {
    const closing = set(3);
    expect(reconcileClosing(closing, set(2), set(3))).toBe(closing);
  });
});

describe('shownShell', () => {
  const shells = [shell(2), shell(3), shell(4)];

  it('shows the picked tab first', () => {
    expect(shownShell({ shells, picked: 4, launched: 2, awaitingList: false })).toBe(4);
  });

  it('falls back to the first-launched tab when the picked one is gone', () => {
    expect(shownShell({ shells, picked: 9, launched: 3, awaitingList: false })).toBe(3);
  });

  it('falls back to the first live tab when picked and launched are gone', () => {
    expect(shownShell({ shells, picked: 9, launched: 8, awaitingList: false })).toBe(2);
    expect(shownShell({ shells, picked: null, launched: null, awaitingList: false })).toBe(2);
  });

  it('trusts the launch result before the host has listed anything', () => {
    expect(shownShell({ shells: [], picked: null, launched: 2, awaitingList: true })).toBe(2);
  });

  it('shows nothing once the list is empty for real (AC15)', () => {
    expect(shownShell({ shells: [], picked: null, launched: 2, awaitingList: false })).toBeNull();
    expect(shownShell({ shells: [], picked: null, launched: null, awaitingList: true })).toBeNull();
  });
});

describe('shownAfterClose', () => {
  const shells = [shell(2), shell(3), shell(4)];

  it('closing the shown picked tab falls back to the first-launched tab', () => {
    expect(shownAfterClose({ shells, picked: 4, launched: 3 }, 4)).toBe(3);
  });

  it('closing the shown launched tab falls back to the first live tab', () => {
    expect(shownAfterClose({ shells, picked: null, launched: 3 }, 3)).toBe(2);
  });

  it('closing a tab that is not shown leaves the shown tab unchanged', () => {
    expect(shownAfterClose({ shells, picked: 3, launched: 2 }, 4)).toBe(3);
    expect(shownAfterClose({ shells, picked: null, launched: null }, 3)).toBe(2);
  });

  it('closing the last tab leaves nothing shown', () => {
    expect(shownAfterClose({ shells: [shell(2)], picked: 2, launched: 2 }, 2)).toBeNull();
  });
});
