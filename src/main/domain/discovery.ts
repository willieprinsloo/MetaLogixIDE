import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseMetaproject } from '@shared/parse-metaproject';

const MARKERS = ['.git', '.metaproject.yaml', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

function matchedMarkers(dir: string): string[] {
  return MARKERS.filter(m => existsSync(join(dir, m)));
}

function readMetaproject(dir: string): { projectId: string | null; boardUrl: string | null } {
  const p = join(dir, '.metaproject.yaml');
  if (!existsSync(p)) return { projectId: null, boardUrl: null };
  try {
    return parseMetaproject(readFileSync(p, 'utf8'));
  } catch {
    return { projectId: null, boardUrl: null };
  }
}

export interface DiscoveredProject {
  path: string;
  name: string;
  markers: string[];
  metaprojectProjectId: string | null;
  metaprojectBoardUrl: string | null;
}

export function discoverProjects(rootPath: string, scanDepth: number): DiscoveredProject[] {
  const results: DiscoveredProject[] = [];
  function walk(dir: string, depth: number) {
    if (depth > scanDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch { continue; }
      const markers = matchedMarkers(full);
      if (markers.length > 0) {
        const mp = readMetaproject(full);
        results.push({
          path: full,
          name: basename(full),
          markers,
          metaprojectProjectId: mp.projectId,
          metaprojectBoardUrl: mp.boardUrl,
        });
      } else {
        walk(full, depth + 1);
      }
    }
  }
  walk(rootPath, 0);
  return results;
}
