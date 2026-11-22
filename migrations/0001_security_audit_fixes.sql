-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
-- Security audit fixes
-- Adds:
--   1) rate_limits — per-account/IP failure counter for login lockout
--   2) (Note) revoked_sessions FK to users(id) is documented in schema.sql;
--      cannot be added to an existing SQLite table without a full rebuild.
--      Manual cascade in worker.deleteAccount() handles the cleanup instead.

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,                  -- e.g. 'failed-login:<lowercase-email>'
  created_at INTEGER NOT NULL         -- epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key_created ON rate_limits(key, created_at);

-- Housekeeping: drop any orphan revoked_sessions whose user no longer exists
-- (MED-9 — schema lacks FK so these would otherwise linger).
DELETE FROM revoked_sessions
WHERE user_id NOT IN (SELECT id FROM users);
