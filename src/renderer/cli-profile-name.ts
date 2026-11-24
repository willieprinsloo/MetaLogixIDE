/**
 * Derives a CLI profile name from a custom command when the user left the
 * Name field blank but asked to save. Root-cause fix for the silent save
 * drop: the save checkbox alone decides saving; a blank name no longer
 * cancels it.
 */

/** Longest auto-derived name we'll produce before the dedupe suffix. */
const MAX_NAME_LEN = 24;

/**
 * First whitespace token of `cmdLine` → its last `/` (or `\`) segment →
 * lowercased, clamped to 24 chars. Empty input falls back to `'cmd'`.
 * When the result collides with a name in `existing`, `-2`, `-3`, … are
 * appended until unique — so an auto-name never overwrites a saved profile
 * (the main process saves by replacing the same-named profile).
 */
export function deriveProfileName(cmdLine: string, existing: readonly string[]): string {
  const first = cmdLine.trim().split(/\s+/)[0] ?? '';
  let base = first.split('/').pop()?.split('\\').pop() ?? '';
  base = base.toLowerCase().slice(0, MAX_NAME_LEN);
  if (!base) base = 'cmd';
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
