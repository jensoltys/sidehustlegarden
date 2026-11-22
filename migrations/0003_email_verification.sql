-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
-- Email verification: require new signups to click a link before login.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verified_at TEXT;

CREATE TABLE email_verification_tokens (
  token TEXT PRIMARY KEY,                -- SHA-256 hash of raw token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,           -- epoch seconds
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL            -- epoch seconds
);
CREATE INDEX idx_evt_user ON email_verification_tokens(user_id);

-- Grandfather all existing users so the new enforcement doesn't lock them out.
UPDATE users SET email_verified=1, verified_at=datetime('now') WHERE email_verified=0;
