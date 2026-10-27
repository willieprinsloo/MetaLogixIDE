-- P2P remote access: paired-device registry (UI/fleet cache) and singleton settings row.
-- Trust itself lives in ~/.metaide/known_devices.json; `devices` mirrors it for fleet listing.
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  last_seen_at INTEGER,
  is_self      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE p2p_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  relay_url     TEXT,
  relay_port    INTEGER,
  device_name   TEXT,
  serve_enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO p2p_settings (id, relay_url, relay_port, serve_enabled)
  VALUES (1, 'signal.metalogix.solutions', 7000, 1);
