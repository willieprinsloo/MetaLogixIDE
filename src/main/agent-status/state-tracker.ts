/** Live per-PTY agent identity and dot state, never changed by Claude hooks. */
import type { AgentKind, AgentShellStateEntry, AgentState } from '@shared/agent-state';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import { classifyClaudeScreen } from './claude-screen';

/** Immutable identity emitted after each PTY spawn, before its first status observation. */
export interface SpawnIdentity extends ShellKey {
  readonly pid: number;
  readonly generation: string;
  readonly agent: AgentKind | null;
}

/** Minimal PTY observation port; no transcript or PTY data enters renderer state. */
export interface StatusPtyPort {
  liveShell(
    projectId: number,
    shellIndex: number,
  ): { pid: number; generation: string; agent: AgentKind | null } | null;
  liveStatus(projectId: number, shellIndex: number): Promise<{ rows: string[]; title: string }>;
}

interface Entry {
  identity: SpawnIdentity;
  agent: AgentKind | null;
  state: AgentState;
  lastOmpReportAt: number | null;
}
const OMP_LEASE_MS = 1500;
const key = (shell: ShellKey): string => `${shell.projectId}:${shell.shellIndex}`;

/** Publishes only changes and includes recognized idle shells in initial snapshots. */
export class AgentStatusTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(entry: AgentShellStateEntry) => void>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly pty: StatusPtyPort,
    private readonly observeForeground: (pid: number) => Promise<boolean>,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Replaces one shell's identity; a respawn starts idle even when PID is reused. */
  spawn(identity: SpawnIdentity): void {
    const existing = this.entries.get(key(identity));
    if (existing) this.publish(identity, null, 'idle');
    this.entries.set(key(identity), {
      identity,
      agent: identity.agent,
      state: 'idle',
      lastOmpReportAt: null,
    });
    if (identity.agent) this.publish(identity, identity.agent, 'idle');
  }

  /** Removes only the exiting generation and clears the former renderer identity. */
  exit(identity: SpawnIdentity): void {
    const existing = this.entries.get(key(identity));
    if (!existing || existing.identity.generation !== identity.generation) return;
    this.entries.delete(key(identity));
    this.publish(identity, null, 'idle');
  }

  /** Accepts an authenticated OMP session state only while its PTY generation is current. */
  ompReport(shell: ShellKey, generation: string, state: AgentState): void {
    const current = this.entries.get(key(shell));
    if (
      !current ||
      current.identity.generation !== generation ||
      current.identity.agent !== 'omp' ||
      !this.current(current)
    )
      return;
    current.lastOmpReportAt = Date.now();
    this.set(current, 'omp', state);
  }

  /** Reads a current snapshot including recognized idle shells. */
  list(): AgentShellStateEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.agent !== null && this.current(entry))
      .map(({ identity, agent, state }) => ({
        projectId: identity.projectId,
        shellIndex: identity.shellIndex,
        agent,
        state,
      }));
  }

  /** Subscribes to changed identity/state and returns an unsubscribe function. */
  onChange(listener: (entry: AgentShellStateEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Coalesces concurrent samples and discards results from replaced or exited PTYs. */
  async refresh(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        const k = key(entry.identity);
        if (this.pending.has(k)) return;
        if (entry.identity.agent === 'omp') {
          if (
            this.current(entry) &&
            entry.lastOmpReportAt !== null &&
            Date.now() - entry.lastOmpReportAt >= OMP_LEASE_MS
          ) {
            entry.lastOmpReportAt = null;
            this.set(entry, 'omp', 'idle');
          }
          return;
        }
        this.pending.add(k);
        try {
          await this.refreshOne(entry);
        } finally {
          this.pending.delete(k);
        }
      }),
    );
  }

  private async refreshOne(entry: Entry): Promise<void> {
    if (!this.current(entry)) return;
    let recognized = entry.identity.agent === 'claude';
    try {
      if (!recognized && this.platform !== 'win32')
        recognized = await this.observeForeground(entry.identity.pid);
    } catch {
      console.warn('[agent-status] foreground sample unavailable');
      recognized = false;
    }
    if (!this.current(entry)) return;
    let state: AgentState = 'idle';
    if (recognized) {
      try {
        const { rows, title } = await this.pty.liveStatus(
          entry.identity.projectId,
          entry.identity.shellIndex,
        );
        state = classifyClaudeScreen(rows, title);
      } catch {
        console.warn('[agent-status] screen sample unavailable');
      }
    }
    if (!this.current(entry)) return;
    this.set(entry, recognized ? 'claude' : null, state);
  }

  private current(entry: Entry): boolean {
    const live = this.pty.liveShell(entry.identity.projectId, entry.identity.shellIndex);
    return (
      this.entries.get(key(entry.identity)) === entry &&
      live?.generation === entry.identity.generation
    );
  }

  private set(entry: Entry, agent: AgentKind | null, state: AgentState): void {
    if (entry.agent === agent && entry.state === state) return;
    entry.agent = agent;
    entry.state = state;
    this.publish(entry.identity, agent, state);
  }

  private publish(shell: ShellKey, agent: AgentKind | null, state: AgentState): void {
    const entry = { projectId: shell.projectId, shellIndex: shell.shellIndex, agent, state };
    for (const listener of this.listeners) listener(entry);
  }
}
