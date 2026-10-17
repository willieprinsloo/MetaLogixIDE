/** Project palette row: generic severity, highlighted contrast ring and existing project identity layout. */
import { homeRelativePath } from '@renderer/abbreviate-path';
import { PALETTE_COPY, PALETTE_TESTIDS } from '@renderer/command-palette-contract';
import { useProjectAgentState } from '@renderer/hooks/useAgentStates';
import { rootHueVar } from '@renderer/root-hue';
import type { AgentState } from '@shared/agent-state';
import type { Project, Root } from '@shared/types';
import { RootFolderGlyph } from '../RootFolderGlyph';
import { StatusDot } from '../StatusDot';

/**
 * Whether the highlighted row's dot keeps the white ring. Decided by `palette-dot-contrast.test.ts`:
 * busy / blocked fall below 3:1 on the soft highlight in default dark, Catppuccin light and Rosé Pine
 * light, so the ring stays (AC7).
 */
export const RING_NEEDED = true;

const STATUS_TONE: Record<AgentState, string> = {
  idle: 'text-[--modal-text-muted]',
  busy: 'text-[--agent-busy]',
  blocked: 'text-[--agent-blocked]',
};

interface ProjectRowProps {
  readonly project: Project;
  /** The project's root; absent until roots load, when the label falls back to the parent folder. */
  readonly root: Root | undefined;
  readonly current: boolean;
  readonly active: boolean;
  readonly alive: boolean;
}

/** Renders one palette project with a severity-only status and current-project hint. */
export function ProjectRow({ project, root, current, active, alive }: ProjectRowProps): React.JSX.Element {
  const agentState = useProjectAgentState(project.id);
  return (
    <>
      <span className="flex w-3.5 shrink-0 justify-center">
        {alive ? (
          <StatusDot state={agentState} ring={active && RING_NEEDED} className="!h-[7px] !w-[7px]" />
        ) : (
          <span data-lead="hollow" aria-hidden="true" className="inline-block h-2 w-2 rounded-full border-[1.5px] border-[--modal-text-muted] opacity-70" />
        )}
      </span>
      <span className="shrink-0 truncate font-medium max-w-[45%]">{project.name}</span>
      <ProjectRootLabel project={project} root={root} />
      {current && <span className="sr-only">, {PALETTE_COPY.currentLabel}</span>}
      {current && !active && (
        <span data-testid={PALETTE_TESTIDS.current} aria-hidden="true" className="shrink-0 text-[12px] text-[--modal-text-muted]">
          {PALETTE_COPY.current}
        </span>
      )}
      {alive && (
        <span data-testid={PALETTE_TESTIDS.projectStatus} aria-hidden="true" className={`shrink-0 text-[12.5px] ${STATUS_TONE[agentState]}`}>
          {PALETTE_COPY.projectStatus[agentState]}
        </span>
      )}
      {(alive || active) && (
        <span className="flex w-[68px] shrink-0 justify-end">
          {active && (
            <span aria-hidden="true" className="palette-open-hint flex items-center gap-1.5 rounded-md px-2 py-[3px] text-[12.5px]">
              {PALETTE_COPY.openHint}
              <kbd>↩</kbd>
            </span>
          )}
        </span>
      )}
    </>
  );
}

/** The root folder a project lives in: hue-tinted folder glyph (as in the sidebar) and the root's home-relative path. */
function ProjectRootLabel({ project, root }: { readonly project: Project; readonly root: Root | undefined }): React.JSX.Element {
  const folder = root?.path ?? project.path.replace(/[\\/]+[^\\/]*[\\/]*$/u, '');
  return (
    <span
      data-testid={PALETTE_TESTIDS.projectRoot}
      title={project.path}
      className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-normal text-[--modal-text-muted]"
    >
      <RootFolderGlyph color={rootHueVar(folder)} testId={null} />
      <span className="truncate">{homeRelativePath(folder)}</span>
    </span>
  );
}
