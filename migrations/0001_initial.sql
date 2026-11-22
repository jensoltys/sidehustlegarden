-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (
  id TEXT PRIMARY KEY,                  -- random UUID
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,             -- ISO timestamp
  last_sign_in_at TEXT,                 -- ISO timestamp, nullable
  user_metadata TEXT                    -- JSON blob, nullable
, password_hash TEXT);
CREATE TABLE bills (
  id TEXT PRIMARY KEY,                  -- UUID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT,
  is_final INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  repeats INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  start_month TEXT,                     -- YYYY-MM, nullable
  created_at TEXT NOT NULL
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY,                  -- UUID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  amount REAL NOT NULL,
  month TEXT NOT NULL,                  -- YYYY-MM
  targets TEXT,                         -- JSON array, nullable
  pay_date TEXT NOT NULL,               -- YYYY-MM-DD
  created_at TEXT NOT NULL
);
CREATE TABLE monthly_amounts (
  id TEXT PRIMARY KEY,                  -- UUID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                  -- YYYY-MM
  amount REAL NOT NULL,
  UNIQUE(bill_id, month)
);
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_goal INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE revoked_sessions (
  jti TEXT PRIMARY KEY,                 -- JWT ID
  user_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL
);
CREATE TABLE rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,                  -- e.g. 'failed-login:<lowercase-email>'
  created_at INTEGER NOT NULL         -- epoch seconds
);
DELETE FROM sqlite_sequence;
CREATE INDEX idx_bills_user ON bills(user_id);
CREATE INDEX idx_bills_user_archived ON bills(user_id, archived);
CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_payments_user_month ON payments(user_id, month);
CREATE INDEX idx_monthly_user ON monthly_amounts(user_id);
CREATE INDEX idx_rate_limits_key_created ON rate_limits(key, created_at);
