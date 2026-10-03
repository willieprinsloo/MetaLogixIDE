import type { Database } from 'better-sqlite3';
import { openDb } from './db/connection';
import { runMigrations } from './db/migrator';
import { RootsRepo } from './repos/roots-repo';
import { ProjectsRepo } from './repos/projects-repo';
import { ShellsRepo } from './repos/shells-repo';
import { SettingsRepo } from './repos/settings-repo';
import { PromptsRepo } from './repos/prompts-repo';
import { PtyManager } from './pty/manager';
import { RootWatcher } from './domain/watcher';
import { MetaprojectClient } from './metaproject/client';
import { applyClaudePermissionMode } from './domain/claude-permission-mode';
import { CLAUDE_PERMISSION_MODE_ENV, isClaudePermissionMode } from '@shared/claude-permission-mode';
import { SessionRegistry, type ShellKey } from './claude-hooks/session-registry';
import { ClaudeHookReceiver } from './claude-hooks/receiver';
import { ClaudeHookRuntime } from './claude-hooks/runtime';
import { createLaunchDecorator } from './claude-hooks/launch-decorator';
import { ViewedShells } from './notifications/viewed-shells';
import { ClaudeStateTracker } from './claude-status/state-tracker';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Services {
  db: Database;
  roots: RootsRepo;
  projects: ProjectsRepo;
  shells: ShellsRepo;
  settings: SettingsRepo;
  prompts: PromptsRepo;
  ptyManager: PtyManager;
  watcher: RootWatcher;
  metaproject: MetaprojectClient;
  /** Per-spawn Claude hook sessions (auth + hook-confirmed state). */
  hookSessions: SessionRegistry;
  /** Loopback receiver for Claude hook POSTs; not listening until `hookRuntime.start()`. */
  hookReceiver: ClaudeHookReceiver;
  /** Starts/stops the receiver and owns the settings file injected into Claude spawns. */
  hookRuntime: ClaudeHookRuntime;
  /** Shells the main window reports as visible, for notification suppression. */
  viewedShells: ViewedShells;
  /** Per-shell Claude state (idle / busy / blocked) behind the status dots; fed by `installClaudeStatus`. */
  claudeState: ClaudeStateTracker;
  homeDir: string;
  migrationsDir: string;
}

/**
 * Test/CI hook: `METAIDE_CLAUDE_PERMISSION_MODE` ('auto' | 'bypass') lets an
 * E2E spec or dev run skip the first-launch permission-mode modal. An
 * invalid value fails startup loudly rather than silently picking a mode.
 * Runs once, after `seedDefaults()` (so `METAIDE_DEFAULT_LAUNCH_*` overrides
 * are already the effective launch commands it would rewrite), and only
 * takes effect when no mode has been chosen yet — an install that already
 * has a stored choice is never overridden.
 */
function applyPermissionModeEnvOverride(settings: SettingsRepo): void {
  const raw = process.env[CLAUDE_PERMISSION_MODE_ENV];
  if (raw === undefined) return;
  if (!isClaudePermissionMode(raw)) {
    throw new Error(`${CLAUDE_PERMISSION_MODE_ENV} must be 'auto' or 'bypass', got: ${JSON.stringify(raw)}`);
  }
  if (settings.get('claude_permission_mode') !== null) return;
  applyClaudePermissionMode(settings, raw);
}

/** Ms epoch of the live shell's last PTY output, or null when it is not alive. */
function lastOutputAt(ptyManager: PtyManager, shell: ShellKey): number | null {
  const live = ptyManager.liveShells().find((s) => s.projectId === shell.projectId && s.shellIndex === shell.shellIndex);
  return live?.lastDataAt ?? null;
}

/**
 * Composition root for main-process services. Opens and migrates the DB and
 * constructs every repo and adapter; the Claude hook receiver is built but
 * not started (no socket is opened here). `homeDir` defaults to the OS home.
 */
export function buildServices(opts: { dbPath?: string; migrationsDir?: string; homeDir?: string } = {}): Services {
  const home = opts.homeDir ?? homedir();
  const dbPath = opts.dbPath ?? join(home, '.metaide', 'metaide.db');
  const migrationsDir = opts.migrationsDir ?? resolve(process.cwd(), 'migrations');
  const db = openDb(dbPath);
  runMigrations(db, migrationsDir);
  const settings = new SettingsRepo(db);
  settings.seedDefaults();
  applyPermissionModeEnvOverride(settings);
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const shells = new ShellsRepo(db);
  const prompts = new PromptsRepo(db);
  const hookSessions = new SessionRegistry();
  const hookReceiver = new ClaudeHookReceiver(hookSessions);
  const hookRuntime = new ClaudeHookRuntime({ receiver: hookReceiver, homeDir: home });
  const ptyManager = new PtyManager({
    spawnDecorator: createLaunchDecorator({ sessions: hookSessions, settingsPath: () => hookRuntime.settingsPath() }),
  });
  const watcher = new RootWatcher({ cap: settings.get('max_watched_paths') });
  const metaproject = new MetaprojectClient();
  const claudeState = new ClaudeStateTracker({
    sessions: hookSessions,
    lastOutputAt: (shell) => lastOutputAt(ptyManager, shell),
    now: () => Date.now(),
  });
  return {
    db, roots, projects, shells, settings, prompts, ptyManager, watcher, metaproject,
    hookSessions, hookReceiver, hookRuntime, viewedShells: new ViewedShells(), claudeState,
    homeDir: home, migrationsDir,
  };
}
