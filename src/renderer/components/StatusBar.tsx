import type { Project } from '@shared/types';

export function StatusBar({ project, aliveCount }: { project: Project | null; aliveCount: number }) {
  return (
    <div className="h-7 shrink-0 border-t border-[--border] bg-[--panel]/70 backdrop-blur-xl px-3 text-[11px] text-[--text-muted] flex items-center gap-4 font-mono">
      <span className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${project ? 'bg-[--accent]' : 'bg-[--text-muted]/50'}`} />
        {project ? project.name : 'no project'}
      </span>
      <span>alive shells: {aliveCount}</span>
    </div>
  );
}
