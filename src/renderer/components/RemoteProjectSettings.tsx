import type { ReactElement } from 'react';
import type { RemoteWorkspace } from '@renderer/p2p/remote-workspace';

export interface RemoteProjectSettingsProps {
  readonly remote: RemoteWorkspace;
  readonly projectId: number;
  readonly projectName: string;
}

/** Settings surface limited to remote default-agent selection. */
export function RemoteProjectSettings(_props: RemoteProjectSettingsProps): ReactElement | null {
  return null;
}
