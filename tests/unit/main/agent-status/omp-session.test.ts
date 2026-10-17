import { describe, expect, it } from 'vitest';
import { OmpSession } from '@main/agent-status/omp-session';
import type { OmpReport } from '@shared/omp-report';

const report = (session: string, seq: number, event: OmpReport['event'], extra: Partial<OmpReport> = {}): OmpReport => ({ version: 1, session, seq, event, ...extra });

describe('OMP current-session lifecycle', () => {
  it('starts idle, works, blocks, resumes and settles', () => {
    const state = new OmpSession();
    expect(state.apply(report('a', 1, 'session_start'))).toBe('idle');
    expect(state.apply(report('a', 2, 'agent_start'))).toBe('busy');
    expect(state.apply(report('a', 3, 'approval_requested'))).toBe('blocked');
    expect(state.apply(report('a', 4, 'approval_resolved'))).toBe('busy');
    expect(state.apply(report('a', 5, 'ask_start'))).toBe('blocked');
    expect(state.apply(report('a', 6, 'ask_end'))).toBe('busy');
    expect(state.apply(report('a', 7, 'agent_end', { willContinue: true }))).toBe('busy');
    expect(state.apply(report('a', 8, 'agent_end'))).toBe('idle');
  });

  it('switches session only through an explicit switch; rejects replay and nested takeover', () => {
    const state = new OmpSession();
    state.apply(report('a', 1, 'session_start'));
    state.apply(report('a', 2, 'agent_start'));
    expect(state.apply(report('nested', 3, 'agent_start'))).toBeNull();
    expect(state.apply(report('a', 2, 'agent_end'))).toBeNull();
    expect(state.apply(report('b', 3, 'session_start'))).toBeNull();
    expect(state.apply(report('b', 4, 'session_switch', { active: true }))).toBe('busy');
    expect(state.apply(report('a', 5, 'agent_start'))).toBeNull();
  });
  it('rejects an incomplete heartbeat without advancing the authenticated sequence', () => {
    const state = new OmpSession();
    expect(state.apply(report('a', 1, 'session_start', { active: true }))).toBe('busy');
    expect(state.apply(report('a', 2, 'heartbeat', { active: false, approvals: 0 }))).toBeNull();
    expect(state.apply(report('a', 2, 'heartbeat', { active: false, approvals: 0, questions: 0 }))).toBe('idle');
  });
  it('repairs missed completion and blocker resolution from an authoritative heartbeat', () => {
    const state = new OmpSession();
    expect(state.apply(report('a', 1, 'session_start', { active: true }))).toBe('busy');
    expect(state.apply(report('a', 2, 'approval_requested'))).toBe('blocked');
    expect(state.apply(report('a', 4, 'heartbeat', { active: false, approvals: 0, questions: 0 }))).toBe('idle');
    expect(state.apply(report('a', 3, 'approval_resolved'))).toBeNull();
    expect(state.apply(report('a', 5, 'heartbeat', { active: true, approvals: 0, questions: 1 }))).toBe('blocked');
    expect(state.apply(report('a', 6, 'heartbeat', { active: true, approvals: 0, questions: 0 }))).toBe('busy');
    expect(state.apply(report('other', 7, 'heartbeat', { active: false, approvals: 0, questions: 0 }))).toBeNull();
  });
});
