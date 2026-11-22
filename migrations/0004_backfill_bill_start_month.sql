-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
-- 0004_backfill_bill_start_month.sql
--
-- Bug: bills added through the migrated public/app.js UI were
-- saved with start_month = NULL because the new addBill() dropped the field.
-- A NULL start_month makes a bill count toward EVERY month, so a bill added
-- this month appeared in past months that already closed.
--
-- The frontend fix stamps start_month on new bills and filters month views on
-- it. This backfills the bills that were already saved NULL: a bill can never
-- predate when it was created, so created_at's month is the correct lower
-- bound. Bills that already have a start_month (pre-migration data) are left
-- untouched.

UPDATE bills
SET start_month = substr(created_at, 1, 7)
WHERE start_month IS NULL;
