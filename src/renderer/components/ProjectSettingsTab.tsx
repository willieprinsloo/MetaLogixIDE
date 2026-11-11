/** Project-scoped settings content using the existing immediate-save session and field presentation. */
import type { ReactElement, ReactNode } from 'react';
import type { Project } from '@shared/types';
import { useProjectDefaultAgent } from '@renderer/hooks/useProjectDefaultAgent';
import { PROJECT_SETTINGS_COPY as COPY, PROJECT_SETTINGS_TESTIDS as TESTIDS, type ProjectSettingsTarget } from '@renderer/project-settings-contract';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';

interface Props {
  readonly target: ProjectSettingsTarget;
  readonly onSaved: (project: Project) => void;
  /** Further sections below the agent settings (the project's environment variables). */
  readonly children?: ReactNode;
}

/** Loads one immutable target per keyed mount; leaving the tab disconnects its asynchronous session. */
export function ProjectSettingsTab({ target, onSaved, children }: Props): ReactElement {
  const { snapshot, choose, replaceCustomCommands, retry } = useProjectDefaultAgent(target, onSaved);
  return <section aria-label={COPY.title} data-testid={TESTIDS.view}
    className="flex-1 min-h-0 min-w-0 overflow-auto text-[--text]">
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h2 className="text-lg font-semibold">{COPY.title}</h2>
      <ProjectSettingsPanel snapshot={snapshot} onChoose={choose}
        onReplaceCustomCommands={replaceCustomCommands} onRetry={retry} />
      {children && <div className="border-t border-[--border] pt-6">{children}</div>}
    </div>
  </section>;
}
