import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const MARKERS = ['.git', '.metaproject.yaml', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

/**
 * Directory names to skip when treating a top-level folder as a "project"
 * even without markers. We include everything ELSE at depth-1 so folders
 * like "Client Onboarding" (no .git, no package.json) show up in search
 * without forcing users to add a marker file first.
 */
const IGNORE_TOPLEVEL = new Set([
  'node_modules', '.git', '.svn', '.hg', '.venv', 'venv', '__pycache__',
  '.next', '.cache', '.pnpm-store', 'dist', 'build', 'out', 'target',
  '.DS_Store', '.Trash', '.Trashes', '.Spotlight-V100', '.fseventsd',
]);

function matchedMarkers(dir: string): string[] {
  return MARKERS.filter(m => existsSync(join(dir, m)));
}

export interface DiscoveredProject {
  path: string;
  name: string;
  markers: string[];
}

export function discoverProjects(rootPath: string, scanDepth: number): DiscoveredProject[] {
  const results: DiscoveredProject[] = [];
  const topLevelWithoutMarkers: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > scanDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') && depth === 0) continue; // hidden top-level → skip
      if (depth === 0 && IGNORE_TOPLEVEL.has(entry)) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch { continue; }
      const markers = matchedMarkers(full);
      if (markers.length > 0) {
        results.push({
          path: full,
          name: basename(full),
          markers,
        });
      } else {
        if (depth === 0) topLevelWithoutMarkers.push(full);
        walk(full, depth + 1);
      }
    }
  }
  walk(rootPath, 0);
  // A folder that had NO recognised project anywhere inside it (across the
  // whole scanned subtree) is still a legitimate project for switch/search
  // purposes — think "Client Onboarding" folders with just docs. Include
  // those as raw-folder projects, but only if nothing under them already
  // qualified (otherwise we'd get both `monorepo` AND `monorepo/pkg/a`).
  const claimed = new Set(results.map(r => r.path));
  for (const dir of topLevelWithoutMarkers) {
    const hasInside = [...claimed].some(p => p.startsWith(dir + '/'));
    if (!hasInside) {
      results.push({
        path: dir,
        name: basename(dir),
        markers: [],
      });
    }
  }
  return results;
}
