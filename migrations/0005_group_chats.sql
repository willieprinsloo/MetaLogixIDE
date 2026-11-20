-- Group chats between agents (docs/superpowers/specs/2026-11-19-group-chats-design.md).
-- One row per group: the round state machine's group plus its member records, as JSON,
-- since src/main/group-chat/groups.ts owns that shape.
CREATE TABLE group_chats (
  id          TEXT PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state_json  TEXT NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_group_chats_project ON group_chats(project_id);
