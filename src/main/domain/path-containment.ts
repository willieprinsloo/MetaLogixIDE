/**
 * The single containment rule for project-root file access. A path is inside
 * a root when `path.relative(root, path)` neither climbs (`..` or a `../`
 * prefix) nor jumps to another drive (an absolute result); a string-prefix
 * test is wrong because it lets a sibling such as `/proj-evil` pass for
 * `/proj`. The check is lexical only: a symlink inside the root that points
 * outside it is not detected.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * True when `candidate` is `root` itself or lies below it. `relative()`
 * resolves both arguments, so unnormalised inputs compare correctly; the
 * absolute-result case only arises across Windows drives.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Resolves `relPath` against `root` and returns the absolute path, accepting
 * an absolute `relPath` only when it already lies inside `root`.
 *
 * @throws Error `path escapes project root` when the result is outside `root`.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  if (!isInsideRoot(root, abs)) throw new Error('path escapes project root');
  return abs;
}
