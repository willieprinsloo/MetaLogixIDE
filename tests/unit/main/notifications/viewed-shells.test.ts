import { describe, it, expect } from 'vitest';
import { parseViewedShells, ViewedShells } from '@main/notifications/viewed-shells';
import type { ShellKey } from '@main/claude-hooks/session-registry';

const K = { projectId: 1, shellIndex: 0 };
const OTHER_TAB = { projectId: 1, shellIndex: 1 };
const OTHER_PROJECT = { projectId: 2, shellIndex: 0 };

const main = { name: 'main' };
const popK = { name: 'popout-K' };
const popOther = { name: 'popout-other' };

function windows(opts: { focused: object | null; popped?: Array<[ShellKey, object]> }) {
  const popped = opts.popped ?? [];
  return {
    focused: () => opts.focused,
    main: () => main,
    popout: (s: ShellKey) => popped.find(([k]) => k.projectId === s.projectId && k.shellIndex === s.shellIndex)?.[1] ?? null,
  };
}

function viewing(reported: ShellKey[]) {
  const v = new ViewedShells();
  v.setReported(reported);
  return v;
}

describe('ViewedShells.isViewing — suppression matrix (AC15–AC17)', () => {
  it('main focused and the shell in the reported view → viewing (AC15)', () => {
    expect(viewing([K]).isViewing(K, windows({ focused: main }))).toBe(true);
  });

  it('main focused and a split view reporting both panes → both viewed', () => {
    const v = viewing([OTHER_TAB, K]);
    expect(v.isViewing(K, windows({ focused: main }))).toBe(true);
    expect(v.isViewing(OTHER_TAB, windows({ focused: main }))).toBe(true);
  });

  it('main focused on another tab of the same project → not viewing (AC16)', () => {
    expect(viewing([OTHER_TAB]).isViewing(K, windows({ focused: main }))).toBe(false);
  });

  it('main focused on another project → not viewing (AC16)', () => {
    expect(viewing([OTHER_PROJECT]).isViewing(K, windows({ focused: main }))).toBe(false);
  });

  it('main focused with nothing reported (Files tab / no project) → not viewing', () => {
    expect(viewing([]).isViewing(K, windows({ focused: main }))).toBe(false);
  });

  it('no focused window → not viewing even when reported (AC17)', () => {
    expect(viewing([K]).isViewing(K, windows({ focused: null }))).toBe(false);
  });

  it('main window gone (null) and nothing focused → not viewing', () => {
    const w = { ...windows({ focused: null }), main: () => null };
    expect(viewing([K]).isViewing(K, w)).toBe(false);
  });

  it("the shell's popout focused → viewing (AC15)", () => {
    expect(viewing([]).isViewing(K, windows({ focused: popK, popped: [[K, popK]] }))).toBe(true);
  });

  it('a different popout focused → not viewing', () => {
    expect(viewing([K]).isViewing(K, windows({ focused: popOther, popped: [[OTHER_TAB, popOther]] }))).toBe(false);
  });

  it('shell popped out while main is focused → not viewing, even if the main view still reports it', () => {
    expect(viewing([K]).isViewing(K, windows({ focused: main, popped: [[K, popK]] }))).toBe(false);
  });

  it('a later report replaces the earlier one', () => {
    const v = viewing([K]);
    v.setReported([OTHER_PROJECT]);
    expect(v.isViewing(K, windows({ focused: main }))).toBe(false);
  });

  it('keeps its own copy of the reported list', () => {
    const list = [{ ...K }];
    const v = viewing(list);
    list[0]!.projectId = 99;
    expect(v.isViewing(K, windows({ focused: main }))).toBe(true);
  });
});

describe('parseViewedShells', () => {
  it('accepts up to 8 valid shells and strips extra fields', () => {
    const shells = Array.from({ length: 8 }, (_, i) => ({ projectId: i + 1, shellIndex: i, extra: 'x' }));
    expect(parseViewedShells({ shells })).toEqual(shells.map(({ projectId, shellIndex }) => ({ projectId, shellIndex })));
  });

  it('accepts an empty list', () => {
    expect(parseViewedShells({ shells: [] })).toEqual([]);
  });

  it.each([
    ['9 items', { shells: Array.from({ length: 9 }, (_, i) => ({ projectId: 1, shellIndex: i })) }],
    ['projectId 0', { shells: [{ projectId: 0, shellIndex: 0 }] }],
    ['negative shellIndex', { shells: [{ projectId: 1, shellIndex: -1 }] }],
    ['non-integer projectId', { shells: [{ projectId: 1.5, shellIndex: 0 }] }],
    ['non-integer shellIndex', { shells: [{ projectId: 1, shellIndex: 0.5 }] }],
    ['string ids', { shells: [{ projectId: '1', shellIndex: '0' }] }],
    ['NaN', { shells: [{ projectId: Number.NaN, shellIndex: 0 }] }],
    ['a null item', { shells: [null] }],
    ['shells not an array', { shells: { projectId: 1, shellIndex: 0 } }],
    ['missing shells', {}],
    ['a null request', null],
  ])('rejects %s', (_label, req) => {
    expect(() => parseViewedShells(req)).toThrow(/viewed shells/);
  });
});
