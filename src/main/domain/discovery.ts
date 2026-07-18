import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const MARKERS = ['.git', '.metaproject.yaml', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

function matchedMarkers(dir: string): string[] {
  return MARKERS.filter(m => existsSync(join(dir, m)));
}

export interface DiscoveredProject { path: string; name: string; markers: string[]; }

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
        results.push({ path: full, name: basename(full), markers });
      } else {
        walk(full, depth + 1);
      }
    }
  }
  walk(rootPath, 0);
  return results;
}
