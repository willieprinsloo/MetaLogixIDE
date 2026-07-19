export interface Root {
  id: number;
  path: string;
  addedAt: string; // ISO
  sortOrder: number;
}

export type LaunchVariant = 'first' | 'subsequent';

export interface LaunchCmd {
  argv: string[];
  env: Record<string, string>;
}

/**
 * Named CLI a user can spawn from the "+ new shell" menu. `argv[0]` is the
 * binary (resolved via PATH); the rest are its arguments. `env` overrides
 * are merged onto the inherited environment. Persisted per-project in
 * `ProjectConfig.cliProfiles`; global defaults live in the settings map
 * under `default_cli_profiles`, folded in when a project has none of its
 * own.
 */
export interface CliProfile {
  /** Human name shown in the menu (also the dedupe key). */
  name: string;
  argv: string[];
  env?: Record<string, string>;
  /** Optional emoji / short label — purely cosmetic. */
  icon?: string;
}

export interface LaunchCmdTemplate {
  first: LaunchCmd;
  subsequent: LaunchCmd;
}

export interface ProjectConfig {
  launchCmd?: Partial<LaunchCmdTemplate> | null;
  cwdOverride?: string | null;
  env?: Record<string, string>;
  model?: string | null;
  linkedMetaprojectProjectId?: string | null;
  notes?: string;
  /**
   * Named CLIs the "+ new shell" menu offers for this project. When empty
   * or absent, the global `default_cli_profiles` are shown instead. Adding
   * an entry here is how a project "remembers" a CLI the user spawned as a
   * one-off (Custom Command… → Save to project).
   */
  cliProfiles?: CliProfile[];
}

export interface Project {
  id: number;
  rootId: number;
  path: string;
  name: string;
  metaprojectProjectId: string | null;
  linkedChatChannelId: string | null;
  lastOpenedAt: string | null;
  pinned: boolean;
  hidden: boolean;
  firstLaunchedAt: string | null;
  config: ProjectConfig;
}

export interface ShellRow {
  projectId: number;
  shellIndex: number;
  model: string | null;
  launchArgv: string[];
  startedAt: string;
  lastActiveAt: string;
  pinned: boolean;
}

export interface AliveShellSummary extends ShellRow {
  projectName: string;
  projectPath: string;
}

export type SettingsMap = {
  'default_launch_cmd.first':      LaunchCmd;
  'default_launch_cmd.subsequent': LaunchCmd;
  'keep_alive_cap':                number;
  'scan_depth':                    number;
  'scrollback_lines':              number;
  'max_watched_paths':             number;
  'theme':                         'dark' | 'light' | 'system';
  'metaproject_base_url':          string;
  /** Last-used metaproject username. Password is NEVER persisted. */
  'metaproject_last_username':     string;
  /** 30..100 — percentage. 100 = fully opaque, applied to every window. */
  'window_opacity':                number;
  /**
   * Global fallback CLI profiles. Used when a project doesn't set its own
   * `cliProfiles`. The first entry is treated as the "primary" one that
   * shellIndex 0 launches on project open.
   */
  'default_cli_profiles':          CliProfile[];
};
