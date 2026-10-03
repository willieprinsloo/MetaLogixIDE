import { describe, it, expect } from 'vitest';
import {
  keyFor,
  worstClaudeState,
  shellStateOf,
  projectStateOf,
  overallStateOf,
  applySnapshot,
  applyDelta,
  shellSnapshotGetter,
  projectSnapshotGetter,
  overallSnapshotGetter,
} from '@renderer/claude-state';
import type { ClaudeShellState, ClaudeShellStateEntry } from '@shared/claude-state';

describe('worstClaudeState', () => {
  it('is idle for an empty set', () => {
    expect(worstClaudeState([])).toBe('idle');
  });
  it('is busy when the worst present state is busy', () => {
    expect(worstClaudeState(['idle', 'busy'])).toBe('busy');
  });
  it('is blocked when any shell is blocked', () => {
    expect(worstClaudeState(['idle', 'busy', 'blocked'])).toBe('blocked');
  });
  it('does not let ordering change the result', () => {
    expect(worstClaudeState(['blocked', 'idle'])).toBe('blocked');
  });
});

describe('shellStateOf', () => {
  it('reads idle for a shell absent from the map', () => {
    expect(shellStateOf(new Map(), 1, 0)).toBe('idle');
  });
  it('reads the stored state for a tracked shell', () => {
    const map = new Map([[keyFor(1, 0), 'busy' as const]]);
    expect(shellStateOf(map, 1, 0)).toBe('busy');
  });
  it('does not confuse two shells of the same project', () => {
    const map = new Map([[keyFor(1, 0), 'blocked' as const]]);
    expect(shellStateOf(map, 1, 1)).toBe('idle');
  });
});

describe('projectStateOf', () => {
  it('ignores other projects', () => {
    const map = new Map([
      [keyFor(1, 0), 'blocked' as const],
      [keyFor(2, 0), 'busy' as const],
    ]);
    expect(projectStateOf(map, 2)).toBe('busy');
  });
  it('is idle for a project with no tracked shells', () => {
    const map = new Map([[keyFor(1, 0), 'blocked' as const]]);
    expect(projectStateOf(map, 9)).toBe('idle');
  });
  it('is the worst among the project\'s own shells', () => {
    const map = new Map([
      [keyFor(1, 0), 'idle' as const],
      [keyFor(1, 1), 'busy' as const],
      [keyFor(1, 2), 'blocked' as const],
    ]);
    expect(projectStateOf(map, 1)).toBe('blocked');
  });
  it('does not let project 1 match project 11 (the key delimiter must be pinned)', () => {
    const map = new Map([
      [keyFor(1, 0), 'idle' as const],
      [keyFor(11, 0), 'blocked' as const],
    ]);
    expect(projectStateOf(map, 1)).toBe('idle');
  });
});

describe('overallStateOf', () => {
  it('is idle for an empty map', () => {
    expect(overallStateOf(new Map())).toBe('idle');
  });
  it('covers every project (D4)', () => {
    const map = new Map([
      [keyFor(1, 0), 'idle' as const],
      [keyFor(2, 0), 'busy' as const],
      [keyFor(3, 0), 'blocked' as const],
    ]);
    expect(overallStateOf(map)).toBe('blocked');
  });
});

describe('applySnapshot', () => {
  it('builds a map from the entries', () => {
    const entries: ClaudeShellStateEntry[] = [
      { projectId: 1, shellIndex: 0, state: 'busy' },
      { projectId: 2, shellIndex: 0, state: 'blocked' },
    ];
    const map = applySnapshot(entries);
    expect(shellStateOf(map, 1, 0)).toBe('busy');
    expect(shellStateOf(map, 2, 0)).toBe('blocked');
  });
  it('replaces everything a prior snapshot or delta had set', () => {
    const stale = applySnapshot([{ projectId: 1, shellIndex: 0, state: 'blocked' }]);
    const fresh = applySnapshot([{ projectId: 2, shellIndex: 0, state: 'busy' }]);
    expect(shellStateOf(fresh, 1, 0)).toBe('idle');
    expect(shellStateOf(fresh, 2, 0)).toBe('busy');
    expect(stale).not.toBe(fresh);
  });
  it('drops any idle entry defensively rather than storing it', () => {
    const map = applySnapshot([{ projectId: 1, shellIndex: 0, state: 'idle' }]);
    expect(map.size).toBe(0);
  });
});

describe('applyDelta', () => {
  it('sets a new non-idle state', () => {
    const map = applyDelta(new Map(), { projectId: 1, shellIndex: 0, state: 'busy' });
    expect(shellStateOf(map, 1, 0)).toBe('busy');
  });
  it('deletes the entry on an idle delta', () => {
    const busy = new Map([[keyFor(1, 0), 'busy' as const]]);
    const idled = applyDelta(busy, { projectId: 1, shellIndex: 0, state: 'idle' });
    expect(shellStateOf(idled, 1, 0)).toBe('idle');
    expect(idled.has(keyFor(1, 0))).toBe(false);
  });
  it('returns the same map instance when the state does not change', () => {
    const map = new Map([[keyFor(1, 0), 'busy' as const]]);
    const next = applyDelta(map, { projectId: 1, shellIndex: 0, state: 'busy' });
    expect(next).toBe(map);
  });
  it('returns the same map instance for a redundant idle delta on an untracked shell', () => {
    const map = new Map<string, 'busy' | 'blocked' | 'idle'>();
    const next = applyDelta(map, { projectId: 1, shellIndex: 0, state: 'idle' });
    expect(next).toBe(map);
  });
  it('does not change any other shell\'s entry', () => {
    const map = new Map([[keyFor(1, 0), 'blocked' as const], [keyFor(1, 1), 'busy' as const]]);
    const next = applyDelta(map, { projectId: 1, shellIndex: 0, state: 'busy' });
    expect(shellStateOf(next, 1, 1)).toBe('busy');
  });
  it('applies deltas received after a snapshot on top of it (AC17 ordering)', () => {
    let map = applySnapshot([{ projectId: 1, shellIndex: 0, state: 'busy' }]);
    map = applyDelta(map, { projectId: 1, shellIndex: 0, state: 'blocked' });
    expect(shellStateOf(map, 1, 0)).toBe('blocked');
  });
  it('lets a later snapshot overwrite an earlier delta (a delta that raced ahead of its snapshot is superseded)', () => {
    let map = applyDelta(new Map(), { projectId: 1, shellIndex: 0, state: 'blocked' });
    map = applySnapshot([{ projectId: 1, shellIndex: 0, state: 'busy' }]);
    expect(shellStateOf(map, 1, 0)).toBe('busy');
  });
});

// M1 fix: useSyncExternalStore must compare a derived primitive, not the
// backing map, so a delta to an unrelated shell/project doesn't re-render
// every selector user. These factories are what useClaudeStates.ts wires
// into useSyncExternalStore as its snapshot getter.
describe('shellSnapshotGetter', () => {
  it('returns an Object.is-equal value across a delta to a different shell', () => {
    let map: ReadonlyMap<string, ClaudeShellState> = new Map([[keyFor(1, 0), 'busy']]);
    const getSnapshot = shellSnapshotGetter(() => map, 1, 0);
    const before = getSnapshot();
    map = applyDelta(map, { projectId: 2, shellIndex: 0, state: 'blocked' });
    const after = getSnapshot();
    expect(Object.is(before, after)).toBe(true);
  });
  it('returns a different value when its own shell transitions', () => {
    let map: ReadonlyMap<string, ClaudeShellState> = new Map([[keyFor(1, 0), 'busy']]);
    const getSnapshot = shellSnapshotGetter(() => map, 1, 0);
    const before = getSnapshot();
    map = applyDelta(map, { projectId: 1, shellIndex: 0, state: 'blocked' });
    const after = getSnapshot();
    expect(Object.is(before, after)).toBe(false);
  });
});

describe('projectSnapshotGetter', () => {
  it('returns an Object.is-equal value across a delta to a different project', () => {
    let map: ReadonlyMap<string, ClaudeShellState> = new Map([[keyFor(1, 0), 'idle']]);
    const getSnapshot = projectSnapshotGetter(() => map, 1);
    const before = getSnapshot();
    map = applyDelta(map, { projectId: 2, shellIndex: 0, state: 'blocked' });
    const after = getSnapshot();
    expect(Object.is(before, after)).toBe(true);
  });
  it('returns a different value when one of its own project\'s shells transitions', () => {
    let map: ReadonlyMap<string, ClaudeShellState> = new Map([[keyFor(1, 0), 'idle']]);
    const getSnapshot = projectSnapshotGetter(() => map, 1);
    const before = getSnapshot();
    map = applyDelta(map, { projectId: 1, shellIndex: 0, state: 'busy' });
    const after = getSnapshot();
    expect(Object.is(before, after)).toBe(false);
  });
});

describe('overallSnapshotGetter', () => {
  it('returns a different value when any project transitions', () => {
    let map: ReadonlyMap<string, ClaudeShellState> = new Map([[keyFor(1, 0), 'idle']]);
    const getSnapshot = overallSnapshotGetter(() => map);
    const before = getSnapshot();
    map = applyDelta(map, { projectId: 7, shellIndex: 0, state: 'blocked' });
    const after = getSnapshot();
    expect(Object.is(before, after)).toBe(false);
  });
  it('returns an Object.is-equal value across a no-op delta (redundant same-state event)', () => {
    let map: ReadonlyMap<string, ClaudeShellState> = new Map([[keyFor(1, 0), 'busy']]);
    const getSnapshot = overallSnapshotGetter(() => map);
    const before = getSnapshot();
    map = applyDelta(map, { projectId: 1, shellIndex: 0, state: 'busy' });
    const after = getSnapshot();
    expect(Object.is(before, after)).toBe(true);
  });
});
