/**
 * Boot-time rescan of every registered root, so folders added on disk since the last launch
 * (or after a discovery-rule change) surface without a manual Settings → Rescan. Cheap: just
 * directory reads and SQL upserts, and the file watcher is already running.
 */
import type { Services } from '../services';

/**
 * Discovers and upserts projects under each root, links any metaproject id, prunes projects
 * whose folder is gone (nothing is alive at boot), then watches the root. Any failure is
 * logged and swallowed, abandoning the remaining roots; startup carries on.
 */
export async function rescanRootsAtBoot(services: Pick<Services, 'settings' | 'roots' | 'projects' | 'watcher'>): Promise<void> {
  try {
    const { discoverProjects } = await import('../domain/discovery');
    const { pruneMissingProjects } = await import('../domain/prune-missing');
    const scanDepth = services.settings.get('scan_depth');
    for (const root of services.roots.list()) {
      for (const disc of discoverProjects(root.path, scanDepth)) {
        const p = services.projects.upsert(root.id, disc.path, disc.name);
        if (disc.metaprojectProjectId) {
          services.projects.updateConfig(p.id, { linkedMetaprojectProjectId: disc.metaprojectProjectId });
        }
      }
      pruneMissingProjects({ projects: services.projects, hasLiveShell: () => false }, root);
      services.watcher.watch(root.path);
    }
  } catch (e) {
    console.warn('[metaide] boot rescan failed', e);
  }
}
