import { describe, expect, it } from 'vitest';
import { submitReport, DEFAULT_FEEDBACK_ORIGIN } from '@main/feedback/reporter';
import { createRateLimiter } from '@main/feedback/rate-limit';
import type { FeedbackReport } from '@shared/feedback';

function report(partial: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    type: 'bug',
    title: 'ctrl+v does nothing',
    description: '',
    source: { kind: 'user' },
    context: {
      appVersion: '0.3.6',
      osPlatform: 'win32',
      osRelease: '10.0.22631',
      terminalEngine: 'xterm',
      composedAt: '2026-11-27T12:00:00.000Z',
    },
    ...partial,
  };
}

describe('submitReport', () => {
  it('returns the composed markdown and a board URL built from the default origin', () => {
    const r = submitReport(report(), {});
    expect(r.ok).toBe(true);
    expect(r.submitted?.markdown).toContain('[bug]');
    expect(r.submitted?.boardUrl).toBe(`${DEFAULT_FEEDBACK_ORIGIN}/projects/129/kanban`);
    expect(r.ticketUrl).toBe(`${DEFAULT_FEEDBACK_ORIGIN}/projects/129/kanban`);
  });

  it('builds a board URL from an explicit origin when one is supplied (for self-hosted deployments)', () => {
    const r = submitReport(report(), { origin: 'https://projects.example.com' });
    expect(r.submitted?.boardUrl).toBe('https://projects.example.com/projects/129/kanban');
  });

  it('returns boardUrl null when origin is explicitly cleared — e.g. signed-out user', () => {
    const r = submitReport(report(), { origin: null });
    expect(r.submitted?.boardUrl).toBeNull();
    expect(r.message).toContain('Sign in');
  });

  it('rate-limits a single user after 5 reports in the window and tells them when to retry', () => {
    let clock = 0;
    const limiter = createRateLimiter(() => clock);
    for (let i = 0; i < 5; i++) {
      expect(submitReport(report({ title: `report ${i}` }), { limiter }).ok).toBe(true);
    }
    const sixth = submitReport(report({ title: 'overflow' }), { limiter });
    expect(sixth.ok).toBe(false);
    expect(sixth.message).toMatch(/Too many/i);
  });

  it('rate-limits agents separately per agent name so one noisy agent cannot drown out another', () => {
    let clock = 0;
    const limiter = createRateLimiter(() => clock);
    for (let i = 0; i < 3; i++) {
      submitReport(report({ title: `claude-${i}`, source: { kind: 'agent', agent: 'claude', shellIndex: 0 } }), { limiter });
    }
    // Fourth claude report is rate-limited.
    const claude4 = submitReport(report({ title: 'claude-4', source: { kind: 'agent', agent: 'claude', shellIndex: 0 } }), { limiter });
    expect(claude4.ok).toBe(false);
    // But codex is on its own budget.
    const codex1 = submitReport(report({ title: 'codex-1', source: { kind: 'agent', agent: 'codex', shellIndex: 0 } }), { limiter });
    expect(codex1.ok).toBe(true);
  });
});
