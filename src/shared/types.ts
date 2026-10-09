import type { ClaudePermissionMode } from './claude-permission-mode';

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
  /**
   * Name of the CLI profile that auto-launches on project open. Resolved
   * against project cliProfiles first, then the global default_cli_profiles
   * — so "OpenAI Codex" set here will pick up the global entry if the
   * project hasn't overridden it. Null / unset → falls back to
   * `default_launch_cmd.first/subsequent` (the classic Claude default).
   * Lets each folder pick its own agent without editing raw argv.
   */
  defaultCliName?: string | null;
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
  /** Host-installed family used by ordinary application UI; null keeps the built-in stack. */
  'ui_font_family':                string | null;
  /** Host-installed family used by integrated terminals; null keeps the built-in stack. */
  'terminal_font_family':          string | null;
  /** Integrated-terminal font size in px (9..28); null = never saved (effective 14, legacy migration pending). Write via settings:set-terminal-font-size only. */
  'terminal_font_size':            number | null;
  /** Integrated-terminal normal-text weight (100..900, step 100). null = never saved (effective 400). Write via settings:set-terminal-font-weight only, which also sets terminal_bold_weight. */
  'terminal_font_weight':          number | null;
  /** Integrated-terminal bold weight (100..900, step 100), heavier than terminal_font_weight (or 900 at 900). null = never saved (effective 700). Write via settings:set-terminal-bold-weight only. */
  'terminal_bold_weight':          number | null;
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
  /** Chosen Claude permission mode; `null` = not chosen yet (first-run modal). */
  'claude_permission_mode':        ClaudePermissionMode | null;
  /** Show an OS notification when a Claude shell needs the user's input (permission prompt, question, dialog). */
  'notify_claude_needs_input':     boolean;
  /** Show an OS notification when a Claude shell finishes its turn and waits for the next prompt. */
  'notify_claude_finished':        boolean;
  /** App-wide env variables applied to every spawn; project variables override. Write via settings:set-app-env only. */
  'app_env':                       Record<string, string>;
};
