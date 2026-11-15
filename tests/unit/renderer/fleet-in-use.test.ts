/**
 * Shared In use rules (docs/specs/machine-switcher-dots.md AC36, AC39, AC40): which paired
 * machines' live projects show, in what order, under the filter, and the heading's agent state.
 */
import { describe, expect, it } from 'vitest';
import { inUseHeadingState, remoteInUseRows } from '@renderer/fleet-in-use';
import { LOCAL_MACHINE_ID, type MachineDot } from '@renderer/machine-switcher-contract';
import type { PeerShells } from '@renderer/machine-dots';
import type { AgentState } from '@shared/agent-state';

const LOCAL: MachineDot = { deviceId: LOCAL_MACHINE_ID, name: 'Laptop', online: true, lastSeenAt: null, self: true };
const dot = (deviceId: string, name: string, online = true): MachineDot => ({ deviceId, name, online, lastSeenAt: null, self: false });

function shells(states: Record<number, AgentState>): PeerShells {
  const ids = Object.keys(states).map(Number);
  return { aliveProjectIds: new Set(ids), agentState: null, projectStates: new Map(ids.map((id) => [id, states[id]!])) };
}
const names = (entries: Record<number, string>) => new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));
const view = (rows: ReturnType<typeof remoteInUseRows>) => rows.map((r) => `${r.deviceName}:${r.name}`);

describe('remoteInUseRows', () => {
  const machines = [LOCAL, dot('a', 'Atlas'), dot('t', 'Tower')];
  const fleet = new Map([['t', shells({ 1: 'idle', 2: 'busy' })], ['a', shells({ 5: 'blocked' })]]);
  const known = new Map([['t', names({ 1: 'zeta', 2: 'alpha' })], ['a', names({ 5: 'mid' })]]);

  it('lists online peers in dot order, projects by name within a machine', () => {
    expect(view(remoteInUseRows(machines, fleet, known, ''))).toEqual(['Atlas:mid', 'Tower:alpha', 'Tower:zeta']);
  });

  it('carries the device, project id, name and the project\'s agent state', () => {
    const rows = remoteInUseRows(machines, fleet, known, '');
    expect(rows[1]).toEqual({ deviceId: 't', deviceName: 'Tower', projectId: 2, name: 'alpha', state: 'busy' });
    expect(rows[0]!.state).toBe('blocked');
  });

  it('breaks a name tie by project id', () => {
    const tie = new Map([['t', shells({ 9: 'idle', 3: 'idle' })]]);
    const rows = remoteInUseRows([LOCAL, dot('t', 'Tower')], tie, new Map([['t', names({ 9: 'same', 3: 'same' })]]), '');
    expect(rows.map((r) => r.projectId)).toEqual([3, 9]);
  });

  it('applies the filter by project name, case-insensitively', () => {
    expect(view(remoteInUseRows(machines, fleet, known, 'AL'))).toEqual(['Tower:alpha']);
    expect(remoteInUseRows(machines, fleet, known, 'nothing')).toEqual([]);
  });

  it('leaves out an offline peer even if it still has an entry', () => {
    const off = [LOCAL, dot('a', 'Atlas', false), dot('t', 'Tower')];
    expect(view(remoteInUseRows(off, fleet, known, ''))).toEqual(['Tower:alpha', 'Tower:zeta']);
  });

  it('leaves out ids with no known name, and a peer whose names are not loaded', () => {
    const partial = new Map([['t', names({ 2: 'alpha' })]]);
    expect(view(remoteInUseRows(machines, fleet, partial, ''))).toEqual(['Tower:alpha']);
  });

  it('never lists this machine, and is empty with no shells', () => {
    const self = new Map([[LOCAL_MACHINE_ID, shells({ 1: 'busy' })]]);
    expect(remoteInUseRows([LOCAL], self, new Map([[LOCAL_MACHINE_ID, names({ 1: 'x' })]]), '')).toEqual([]);
    expect(remoteInUseRows(machines, new Map(), known, '')).toEqual([]);
  });

  it('reads a live id with no state entry as idle', () => {
    const bare: PeerShells = { aliveProjectIds: new Set([1]), agentState: null, projectStates: new Map() };
    expect(remoteInUseRows([LOCAL, dot('t', 'Tower')], new Map([['t', bare]]), new Map([['t', names({ 1: 'x' })]]), '')[0]!.state).toBe('idle');
  });
});

describe('inUseHeadingState', () => {
  const row = (state: AgentState) => ({ deviceId: 't', deviceName: 'T', projectId: 1, name: 'p', state });

  it('is the worst state across this machine and the remote rows: blocked, then busy, then idle', () => {
    expect(inUseHeadingState('idle', [row('busy'), row('idle')])).toBe('busy');
    expect(inUseHeadingState('busy', [row('blocked')])).toBe('blocked');
    expect(inUseHeadingState('blocked', [row('idle')])).toBe('blocked');
  });

  it('ignores this machine when it has no rows (null) and is idle with nothing at all', () => {
    expect(inUseHeadingState(null, [row('busy')])).toBe('busy');
    expect(inUseHeadingState(null, [])).toBe('idle');
    expect(inUseHeadingState('busy', [])).toBe('busy');
  });
});
