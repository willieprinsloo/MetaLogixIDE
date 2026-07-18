import type { Database } from 'better-sqlite3';
import { openDb } from './db/connection';
import { runMigrations } from './db/migrator';
import { RootsRepo } from './repos/roots-repo';
import { ProjectsRepo } from './repos/projects-repo';
import { ShellsRepo } from './repos/shells-repo';
import { SettingsRepo } from './repos/settings-repo';
import { PtyManager } from './pty/manager';
import { RootWatcher } from './domain/watcher';
import { MetaprojectClient } from './metaproject/client';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Services {
  db: Database;
  roots: RootsRepo;
  projects: ProjectsRepo;
  shells: ShellsRepo;
  settings: SettingsRepo;
  ptyManager: PtyManager;
  watcher: RootWatcher;
  metaproject: MetaprojectClient;
  homeDir: string;
  migrationsDir: string;
}

export function buildServices(opts: { dbPath?: string; migrationsDir?: string } = {}): Services {
  const home = homedir();
  const dbPath = opts.dbPath ?? join(home, '.metaide', 'metaide.db');
  const migrationsDir = opts.migrationsDir ?? resolve(process.cwd(), 'migrations');
  const db = openDb(dbPath);
  runMigrations(db, migrationsDir);
  const settings = new SettingsRepo(db);
  settings.seedDefaults();
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const shells = new ShellsRepo(db);
  const ptyManager = new PtyManager();
  const watcher = new RootWatcher({ cap: settings.get('max_watched_paths') });
  const metaproject = new MetaprojectClient();
  return { db, roots, projects, shells, settings, ptyManager, watcher, metaproject, homeDir: home, migrationsDir };
}
