import type { ReactElement } from 'react';
import { ACTIVITY_LOG_TESTIDS } from '@renderer/activity-log-contract';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import type { MainTab } from '@renderer/main-tab';
import { ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '@renderer/project-settings-contract';
import { WorkspaceTabButton } from './WorkspaceTabButton';

interface Props {
  readonly active: MainTab | null;
  readonly activityEnabled: boolean;
  readonly onSelect: (tab: MainTab) => void;
  readonly diffCount?: number | null;
  readonly envDirty?: boolean;
}

/** Shared tab order, icons, accessible names, and active styling for both workspace sources. */
export function WorkspaceDestinations({ active, activityEnabled, onSelect, diffCount = null, envDirty = false }: Props): ReactElement {
  return (
    <div className="workspace-destinations flex min-w-0 flex-wrap items-center gap-1.5">
      <WorkspaceTabButton tab="shell" label="Shell" active={active === 'shell'} onClick={() => onSelect('shell')} />
      <WorkspaceTabButton tab="files" label="Files" active={active === 'files'} onClick={() => onSelect('files')} />
      <WorkspaceTabButton tab="diff" label={DIFF_COPY.tabLabel} active={active === 'diff'} onClick={() => onSelect('diff')}
        testId={DIFF_TESTIDS.tab} ariaLabel={diffCount === null ? undefined : DIFF_COPY.tabCountLabel(diffCount)}>
        {diffCount !== null && <span aria-hidden className="ml-1.5 font-mono text-[10px] text-[--hue-orange-text]"
          data-testid={DIFF_TESTIDS.tabCount}>{diffCount}</span>}
      </WorkspaceTabButton>
      <WorkspaceTabButton tab="settings" label={PROJECT_SETTINGS_COPY.tab} active={active === 'settings'}
        onClick={() => onSelect('settings')} testId={PROJECT_SETTINGS_TESTIDS.tab}
        ariaLabel={envDirty ? ENV_COPY.tabUnsavedLabel : undefined}>
        {envDirty && <span aria-hidden className="ml-1 text-[--accent]" data-testid={ENV_TESTIDS.unsaved}>{ENV_COPY.tabUnsavedMarker}</span>}
      </WorkspaceTabButton>
      {activityEnabled && <WorkspaceTabButton tab="activity" label="Activity" active={active === 'activity'}
        onClick={() => onSelect('activity')} testId={ACTIVITY_LOG_TESTIDS.tabButton} />}
    </div>
  );
}
