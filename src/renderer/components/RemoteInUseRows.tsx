/**
 * The paired machines' rows of the sidebar's shared In use section (docs/specs/machine-switcher-dots.md
 * AC36–AC38, AC42). The section frame (heading, status dot, collapse) and this machine's rows stay in
 * `Sidebar`, so they are the same `Section` and `ProjectRow` markup as with no paired machine.
 */
import type { OpenPaneRequest } from '@renderer/machine-switcher-contract';
import type { RemoteInUseRow } from '@renderer/fleet-in-use';
import { MACHINE_COPY, MACHINE_TESTIDS } from '@renderer/sidebar-copy';
import { StatusDot } from './StatusDot';

interface Props {
  rows: readonly RemoteInUseRow[];
  onOpenPane?: (req: OpenPaneRequest) => void;
}

/**
 * One button per paired machine's live project: its agent status dot, the project name, and the
 * machine name as a muted tag that keeps its width while the project name truncates first (the tag
 * truncates only past its cap; the row title carries both full names). A click asks App to open the
 * remote project pane with the AC18 request; it never switches the selected dot.
 */
export function RemoteInUseRows({ rows, onOpenPane }: Props) {
  return (
    <>
      {rows.map((row) => (
        <button
          key={`${row.deviceId}:${row.projectId}`}
          type="button"
          onClick={() => onOpenPane?.({
            source: { kind: 'remote', deviceId: row.deviceId },
            deviceName: row.deviceName, projectId: row.projectId, projectName: row.name,
          })}
          title={MACHINE_COPY.inUseRowTitle(row.name, row.deviceName)}
          data-testid={MACHINE_TESTIDS.inUseRemoteRow}
          className="w-full h-7 flex items-center gap-2.5 px-2 text-sm text-[--text] rounded-lg hover:bg-[--surface-hover] transition-colors"
        >
          <StatusDot state={row.state} className="shrink-0" />
          <span data-testid={MACHINE_TESTIDS.inUseRowName} className="truncate min-w-0 flex-1 text-left">{row.name}</span>
          <span data-testid={MACHINE_TESTIDS.inUseMachineTag} className="truncate shrink-0 max-w-[45%] text-[11px] text-[--text-muted]">
            {row.deviceName}
          </span>
        </button>
      ))}
    </>
  );
}
