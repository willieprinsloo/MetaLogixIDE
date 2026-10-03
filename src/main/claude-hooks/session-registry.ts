/**
 * Per-spawn hook identities. Each Claude spawn gets a non-secret id and a
 * 32-byte secret token; the receiver authenticates POSTs against them and
 * the entry dies with the PTY (AC24, AC26).
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Identifies one app shell. */
export interface ShellKey {
  projectId: number;
  shellIndex: number;
}

/** Values handed to one spawned Claude via its environment. */
export interface HookSession {
  id: string;
  token: string;
}

interface Entry {
  shell: ShellKey;
  token: Buffer;
  confirmed: boolean;
}

const TOKEN_BYTES = 32;
const shellKeyString = (shell: ShellKey): string => `${shell.projectId}:${shell.shellIndex}`;

/** Tracks live hook sessions and whether each has delivered an event. */
export class SessionRegistry {
  private readonly byId = new Map<string, Entry>();
  private readonly idByShell = new Map<string, string>();

  /** Issues a fresh id and token for `shell`, replacing any previous session for it. */
  issue(shell: ShellKey): HookSession {
    this.release(shell);
    const id = randomUUID();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.byId.set(id, { shell: { ...shell }, token: Buffer.from(token, 'utf8'), confirmed: false });
    this.idByShell.set(shellKeyString(shell), id);
    return { id, token };
  }

  /** Returns the shell the session belongs to when `token` matches, else null. */
  verify(id: string, token: string): ShellKey | null {
    const entry = this.byId.get(id);
    if (!entry) return null;
    const presented = Buffer.from(token, 'utf8');
    if (presented.length !== entry.token.length || !timingSafeEqual(presented, entry.token)) return null;
    return { ...entry.shell };
  }

  /** Marks the session's shell hook-confirmed; false when the session is unknown or released. */
  confirm(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    entry.confirmed = true;
    return true;
  }

  /** True once the shell's current session has delivered any event. */
  isConfirmed(shell: ShellKey): boolean {
    const id = this.idByShell.get(shellKeyString(shell));
    return id !== undefined && this.byId.get(id)?.confirmed === true;
  }

  /** Id of the shell's current session, or null when it has none (never issued, or released). */
  currentId(shell: ShellKey): string | null {
    return this.idByShell.get(shellKeyString(shell)) ?? null;
  }

  /** Forgets the shell's session so its id and token stop authenticating. */
  release(shell: ShellKey): void {
    const k = shellKeyString(shell);
    const id = this.idByShell.get(k);
    if (id === undefined) return;
    this.byId.delete(id);
    this.idByShell.delete(k);
  }
}
