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
  /** 30..100 — percentage. 100 = fully opaque, applied to every window. */
  'window_opacity':                number;
};
