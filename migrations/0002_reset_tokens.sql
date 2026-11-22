-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
-- Password reset tokens. SHA-256 hash of the raw token is stored so a
-- read-only DB leak can't be replayed.
CREATE TABLE reset_tokens (
  token TEXT PRIMARY KEY,                -- SHA-256 hash of raw token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,              -- ISO timestamp
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reset_tokens_user ON reset_tokens(user_id);
