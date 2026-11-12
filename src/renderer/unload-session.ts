import type { PrimarySessionInspection } from '@shared/unload-session-contract';
import { viewedShellsFor, type ViewedShellsInput } from '@renderer/viewed-shells';

/** Risks shown to the user for the inspected generation, never a project-wide aggregate. */
export interface SessionRisk {
  readonly work: boolean;
  readonly input: boolean;
  readonly visible: boolean;
}

/** Matches only a shell actually displayed in the selected project's Shell main tab. */
export function isPrimaryVisible(projectId: number, view: ViewedShellsInput): boolean {
  return viewedShellsFor(view).some((shell) => shell.projectId === projectId && shell.shellIndex === 0);
}

/** Classifies one inspected local shell without treating an unidentified shell as an idle agent. */
export function consentRisk(inspection: PrimarySessionInspection, visible: boolean): SessionRisk {
  return {
    work: inspection.kind === 'live' && (inspection.state === 'busy' || inspection.state === 'blocked'),
    input: inspection.kind === 'live' && inspection.state === 'blocked',
    visible: inspection.kind === 'live' && visible,
  };
}

/** Combines fresh shell-specific inspection with a reported in-flight agent warning. */
export function currentSessionRisk(
  inspection: PrimarySessionInspection,
  visible: boolean,
  signal: 'idle' | 'busy' | 'blocked',
): SessionRisk {
  if (inspection.kind === 'gone') return consentRisk(inspection, visible);
  const reported = inspection.agent !== null && (signal === 'busy' || signal === 'blocked')
    ? signal : inspection.state;
  return consentRisk({ ...inspection, state: reported }, visible);
}

/** Neutral consent cannot authorize an agent that started work or a terminal that became visible. */
export function needsFreshConsent(before: SessionRisk, after: SessionRisk): boolean {
  return (!before.work && after.work) || (!before.visible && after.visible);
}
