import { existsSync } from 'node:fs';
import type { Root } from '@shared/types';
import type { ProjectsRepo } from '@main/repos/projects-repo';

interface Deps {
  projects: Pick<ProjectsRepo, 'listByRoot' | 'remove'>;
  hasLiveShell: (projectId: number) => boolean;
}

/**
 * Drops projects under `root` whose folder no longer exists on disk, so a
 * rescan reflects deletions as well as additions. Returns how many were removed.
 *
 * Skipped entirely when the root folder itself is missing — an unmounted drive
 * or offline network share must not wipe every project (and, via the schema's
 * cascades, their saved shells and prompts). Projects with a live shell are
 * kept too; the user still has a terminal attached to them.
 */
export function pruneMissingProjects(deps: Deps, root: Root): number {
  if (!existsSync(root.path)) return 0;
  let removed = 0;
  for (const project of deps.projects.listByRoot(root.id)) {
    if (existsSync(project.path) || deps.hasLiveShell(project.id)) continue;
    deps.projects.remove(project.id);
    removed++;
  }
  return removed;
}
