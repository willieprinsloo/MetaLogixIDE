import type { Project } from '@shared/types';

export function StatusBar({ project, aliveCount }: { project: Project | null; aliveCount: number }) {
  return (
    <div className="h-6 border-t border-[--border] px-3 text-xs text-[--text-muted] flex items-center gap-4 font-mono">
      <span>{project ? `● ${project.name}` : 'no project'}</span>
      <span>alive shells: {aliveCount}</span>
    </div>
  );
}
