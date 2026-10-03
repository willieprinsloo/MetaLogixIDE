/**
 * Which shells the user is looking at, for notification suppression
 * (AC15–AC17). Holds the main window's reported view; the window facts
 * (focused window, main window, popouts) are passed in per query so the
 * rule stays pure and unit-testable.
 */
import type { ShellKey } from '@main/claude-hooks/session-registry';

/** Live window facts; windows are compared by identity and a destroyed window must be reported as null. */
export interface WindowView {
  focused(): object | null;
  main(): object | null;
  popout(shell: ShellKey): object | null;
}

const MAX_REPORTED = 8;

const sameShell = (a: ShellKey, b: ShellKey): boolean => a.projectId === b.projectId && a.shellIndex === b.shellIndex;

/** The main window's last reported view plus the "is the user viewing this shell" rule. */
export class ViewedShells {
  private reported: ShellKey[] = [];

  /** Replaces the main window's reported view. */
  setReported(shells: readonly ShellKey[]): void {
    this.reported = shells.map(({ projectId, shellIndex }) => ({ projectId, shellIndex }));
  }

  /** True when the shell's popout is focused, or main is focused, reports the shell and the shell is not popped out. */
  isViewing(shell: ShellKey, windows: WindowView): boolean {
    const focused = windows.focused();
    if (focused === null) return false;
    const popout = windows.popout(shell);
    if (popout !== null) return popout === focused;
    return focused === windows.main() && this.reported.some((s) => sameShell(s, shell));
  }
}

function isShellKey(value: unknown): value is ShellKey {
  if (typeof value !== 'object' || value === null) return false;
  const { projectId, shellIndex } = value as Record<string, unknown>;
  return Number.isInteger(projectId) && (projectId as number) >= 1
    && Number.isInteger(shellIndex) && (shellIndex as number) >= 0;
}

/** Validates a `notifications:viewed-shells` request: at most 8 `{projectId ≥ 1, shellIndex ≥ 0}` integers. Throws otherwise. */
export function parseViewedShells(req: unknown): ShellKey[] {
  const shells = (req as { shells?: unknown } | null)?.shells;
  if (!Array.isArray(shells) || shells.length > MAX_REPORTED || !shells.every(isShellKey)) {
    throw new Error('invalid viewed shells: expected up to 8 { projectId >= 1, shellIndex >= 0 } integers');
  }
  return shells.map(({ projectId, shellIndex }) => ({ projectId, shellIndex }));
}
