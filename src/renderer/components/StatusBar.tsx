import type { Project } from '@shared/types';
import { useGitStatus } from '@renderer/hooks/useGitStatus';

export function StatusBar({ project, aliveCount }: { project: Project | null; aliveCount: number }) {
  const { status: git } = useGitStatus(project?.id ?? null);
  return (
    <div className="h-7 shrink-0 border-t border-[--border] bg-[--panel]/70 backdrop-blur-xl px-3 text-[11px] text-[--text-muted] flex items-center gap-4 font-mono">
      <span className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${project ? 'bg-[--accent]' : 'bg-[--text-muted]/50'}`} />
        {project ? project.name : 'no project'}
      </span>
      {git.isRepo && (
        <span className="flex items-center gap-1" title={
          `${git.branch ?? 'detached'}${git.ahead ? ` · ahead ${git.ahead}` : ''}${git.behind ? ` · behind ${git.behind}` : ''}${git.dirty ? ` · ${Object.keys(git.files).length} changed` : ''}`
        }>
          <BranchIcon />
          <span className="text-[--text]">{git.branch ?? 'HEAD'}</span>
          {git.dirty && <span className="text-amber-400">●</span>}
          {git.ahead > 0 && <span className="text-emerald-400">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="text-rose-400">↓{git.behind}</span>}
        </span>
      )}
      <span>alive shells: {aliveCount}</span>
      <span className="ml-auto flex items-center gap-3 opacity-70">
        <span className="flex items-center gap-1"><kbd>⌘K</kbd> project</span>
        <span className="flex items-center gap-1"><kbd>⌘P</kbd> file</span>
        <span className="flex items-center gap-1"><kbd>⌘⇧F</kbd> search</span>
        <span className="flex items-center gap-1"><kbd>⌘B</kbd> sidebar</span>
        <span className="flex items-center gap-1"><kbd>⌘,</kbd> settings</span>
      </span>
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v4a4 4 0 0 0 4 4h5.5" />
    </svg>
  );
}
