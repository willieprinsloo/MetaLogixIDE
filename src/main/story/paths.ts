import { join } from 'node:path';
import { STORY_DIR } from '@shared/story';

export function storyDir(projectPath: string): string {
  return join(projectPath, STORY_DIR);
}

export function storyFile(projectPath: string, filename: string): string {
  return join(storyDir(projectPath), filename);
}

/** `2026-11-24T14:30:00.123Z` → `2026-11-24T14-30-00`. Filesystem-safe, sorts by time. */
export function filenameTimestamp(iso: string): string {
  return iso.slice(0, 19).replace(/:/g, '-');
}
