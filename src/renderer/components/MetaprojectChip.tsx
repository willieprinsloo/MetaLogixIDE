/**
 * Metaproject binding chip — a tiny status-bar affordance that tells
 * the owner, at a glance, which remote project the folder in front of
 * them is bound to.
 *
 * Linked:    `📌 #129` with a title of "Linked to project #129 at
 *            https://projects.metalogix.solutions · click to open board".
 *            Click opens the kanban URL in the system browser.
 *
 * Unlinked / invalid / mismatch:
 *            Dim "🔗 Bind" chip — click opens the project's settings
 *            tab, where AssignmentPanel already handles the flow. Also
 *            shows a subtle red dot when the binding exists but is
 *            broken (origin-mismatch / invalid file).
 *
 * Loading / signed-out / no project: renders nothing, so the chip
 * never flickers through placeholder text.
 */

import { api } from '@renderer/api';
import { useAssignment } from '@renderer/metaproject/useAssignment';
import { useOptionalMetaprojectSession } from '@renderer/metaproject/session';
import { Tooltip } from './Tooltip';
import { ICON_SIZE, ICON_STROKE } from './icon-size';

interface Props {
  projectId: number | null;
  /** Called when the chip is clicked while the project isn't linked —
   *  typically opens the Project Settings tab where AssignmentPanel
   *  lives. Omitting it hides the unlinked chip entirely (the chip is
   *  no help if you can't act on it). */
  onOpenAssignment?: (() => void) | null;
}

export function MetaprojectChip({ projectId, onOpenAssignment }: Props): React.JSX.Element | null {
  // Rendering outside the session provider (isolated status-bar tests, pop-out
  // windows that don't need the chip) must not crash the whole tree. Reading
  // via the optional accessor keeps `useAssignment` hidden behind the gate so
  // its own `useMetaprojectSession` call never fires without a provider.
  const session = useOptionalMetaprojectSession();
  if (session === null || projectId === null) return null;
  return <MountedChip projectId={projectId} onOpenAssignment={onOpenAssignment ?? null} />;
}

function MountedChip({ projectId, onOpenAssignment }: { projectId: number; onOpenAssignment: (() => void) | null }): React.JSX.Element | null {
  const { state } = useAssignment(projectId);
  if (state.kind !== 'loaded') return null;
  const assignment = state.value;

  if (assignment.kind === 'linked') {
    const url = `${assignment.origin}/projects/${assignment.remoteId}/kanban`;
    const label = `#${assignment.remoteId}`;
    return (
      <Tooltip label={`Linked to project #${assignment.remoteId} at ${assignment.origin} — click to open the board`}>
        <button
          type="button"
          onClick={() => { void api.invoke('app:open-external', { url }); }}
          className="flex items-center gap-1 px-1.5 py-0 rounded-md hover:bg-[--surface-hover] text-[--text]"
          data-testid="metaproject-chip-linked"
          data-remote-id={assignment.remoteId}
        >
          <PinIcon />
          <span className="tabular-nums">{label}</span>
        </button>
      </Tooltip>
    );
  }

  // Anything else that isn't "unlinked" reads as broken — origin mismatch
  // from an account switch, a malformed yaml, or an unreachable project.
  // The chip stays clickable so the fix path is one hop away, but we
  // mark it with a warning dot so the state is visible, not just the
  // outcome.
  const broken = assignment.kind === 'origin-mismatch'
    || assignment.kind === 'invalid'
    || assignment.kind === 'unavailable'
    || assignment.kind === 'unconfirmed';
  const tooltip = assignment.kind === 'unlinked'
    ? 'No metaproject binding for this folder. Click to link.'
    : assignment.kind === 'origin-mismatch'
    ? `Linked to a different metaproject origin (${assignment.origin}). Click to re-link.`
    : 'Metaproject binding needs attention. Click to review.';

  if (!onOpenAssignment) return null;

  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        onClick={onOpenAssignment}
        className="flex items-center gap-1 px-1.5 py-0 rounded-md hover:bg-[--surface-hover] text-[--text-muted] hover:text-[--text]"
        data-testid="metaproject-chip-unlinked"
        data-kind={assignment.kind}
      >
        <LinkIcon />
        <span>Bind</span>
        {broken && <span className="w-1 h-1 rounded-full bg-[--hue-orange-soft-text]" aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}

function PinIcon(): React.JSX.Element {
  return (
    <svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M10.5 1.5 14.5 5.5l-3 .5L8 9.5l-.5 4-2-2-3 3L2 14l3-3-2-2 4-.5L10 4l.5-2.5Z" />
    </svg>
  );
}

function LinkIcon(): React.JSX.Element {
  return (
    <svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.xs} aria-hidden="true">
      <path d="M6 10 10 6" />
      <path d="M8.5 3.5a2 2 0 0 1 2.8 2.8L9 8.5" strokeLinecap="round" />
      <path d="M7.5 12.5a2 2 0 0 1-2.8-2.8L7 7.5" strokeLinecap="round" />
    </svg>
  );
}
