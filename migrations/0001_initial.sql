CREATE TABLE roots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  added_at   DATETIME NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id                     INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  path                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  metaproject_project_id      TEXT,
  linked_chat_channel_id      TEXT,
  last_opened_at              DATETIME,
  pinned                      INTEGER NOT NULL DEFAULT 0,
  hidden                      INTEGER NOT NULL DEFAULT 0,
  first_launched_at           DATETIME,
  config_json                 TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_projects_root ON projects(root_id);

CREATE TABLE recent_projects (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  opened_at   DATETIME NOT NULL
);

CREATE TABLE shells (
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shell_index      INTEGER NOT NULL DEFAULT 0,
  model            TEXT,
  launch_argv_json TEXT NOT NULL,
  started_at       DATETIME NOT NULL,
  last_active_at   DATETIME NOT NULL,
  pinned           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, shell_index)
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
