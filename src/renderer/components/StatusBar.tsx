import type { Project } from '@shared/types';

export function StatusBar({ project, aliveCount }: { project: Project | null; aliveCount: number }) {
  return (
    <div className="h-6 border-t border-neutral-800 px-3 text-xs text-neutral-400 flex items-center gap-4">
      <span>{project ? `● ${project.name}` : 'no project'}</span>
      <span>alive shells: {aliveCount}</span>
    </div>
  );
}
