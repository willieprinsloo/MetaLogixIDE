/** Per-spawn OMP session state, independent of Claude hooks and screen text. */
import type { AgentState } from '@shared/agent-state';
import type { OmpReport } from '@shared/omp-report';

/** Enforces monotonic sequence, explicit session replacement, and blocker lifecycle. */
export class OmpSession {
  private session: string | null = null;
  private sequence = 0;
  private working = false;
  private approvals = 0;
  private questions = 0;

  /** Applies a valid authenticated report; null rejects it without changing state. */
  apply(report: OmpReport): AgentState | null {
    if (report.seq <= this.sequence) return null;
    if (
      report.event === 'heartbeat' &&
      (report.active === undefined ||
        report.approvals === undefined ||
        report.questions === undefined)
    )
      return null;
    if (this.session === null) {
      if (report.event !== 'session_start') return null;
      this.session = report.session;
    } else if (report.event === 'session_switch') {
      this.session = report.session;
      this.working = report.active === true;
      this.approvals = 0;
      this.questions = 0;
    } else if (report.session !== this.session || report.event === 'session_start') return null;
    this.sequence = report.seq;
    switch (report.event) {
      case 'agent_start':
        this.working = true;
        break;
      case 'agent_end':
        if (!report.willContinue) {
          this.working = false;
          this.approvals = 0;
          this.questions = 0;
        }
        break;
      case 'approval_requested':
        this.approvals++;
        break;
      case 'approval_resolved':
        this.approvals = Math.max(0, this.approvals - 1);
        break;
      case 'ask_start':
        this.questions++;
        break;
      case 'ask_end':
        this.questions = Math.max(0, this.questions - 1);
        break;
      case 'heartbeat':
        this.working = report.active === true;
        this.approvals = report.approvals ?? 0;
        this.questions = report.questions ?? 0;
        break;
      case 'session_start':
      case 'session_switch':
        this.working = report.active === true;
        break;
    }
    return this.approvals + this.questions > 0 ? 'blocked' : this.working ? 'busy' : 'idle';
  }
}
