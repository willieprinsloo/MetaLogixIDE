/**
 * The workspace header row a remote project pane fills. App renders the same `workspace-header-row`
 * the local workspace uses, above the main sheet, and provides it here; the remote pane portals its
 * destinations, shell strip and project actions into it so both sources share one header layout.
 * Outside the provider (tests, or a host without the row) the slot is `null` and the pane renders
 * its header inline.
 */
import { createContext, useContext } from 'react';

export const WorkspaceHeaderSlotContext = createContext<HTMLElement | null>(null);

/** The header row element to portal into, or `null` to render inline. */
export function useWorkspaceHeaderSlot(): HTMLElement | null {
  return useContext(WorkspaceHeaderSlotContext);
}
