// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Recurring-bill start_month regression test — Side Hustle Garden.
// Run: node scripts/test-start-month.mjs
//
// Bug: adding a new "same every month" bill made it appear in
// PAST months too — a bill that started this month was being computed into
// months that already passed. Root cause: the frontend never set, read, or
// filtered on the `start_month` column the backend already supported.
//
// This test extracts the real `billActiveInMonth` predicate from public/app.js
// and asserts a bill never appears in a month before it started, and also
// checks that addBill stamps start_month and the loader reads it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.log(`FAIL  ${name}`); failures++; }
}

// ── Extract the real predicate source from app.js and evaluate it ───────────
// Marker-delimited so we test the shipped code, not a copy.
const m = appJs.match(/function billActiveInMonth\([\s\S]*?\n\}/);
if (!m) {
  console.log('FAIL  billActiveInMonth() not found in public/app.js');
  process.exit(1);
}
// CM() is referenced for the "no month arg" default; provide a stub.
const CM = () => '2026-06';
// eslint-disable-next-line no-eval
const billActiveInMonth = eval('(' + m[0].replace('function billActiveInMonth', 'function') + ')');

// A bill created THIS month (June) with start_month stamped.
const newBill = { id: 'a', name: 'Gym', amount: 30, repeats: true, archived: false, startMonth: '2026-06' };
// A legacy bill with no start_month (null) — must stay visible everywhere.
const legacyBill = { id: 'b', name: 'Rent', amount: 900, repeats: true, archived: false, startMonth: null };
const archivedBill = { id: 'c', name: 'Old', amount: 10, repeats: true, archived: true, startMonth: '2026-01' };

check('new bill hidden from a past month (May)', billActiveInMonth(newBill, '2026-05') === false);
check('new bill hidden from an older month (Jan)', billActiveInMonth(newBill, '2026-01') === false);
check('new bill visible in its start month (June)', billActiveInMonth(newBill, '2026-06') === true);
check('new bill visible in a future month (July)', billActiveInMonth(newBill, '2026-07') === true);
check('legacy null-start bill visible in past month', billActiveInMonth(legacyBill, '2026-05') === true);
check('legacy null-start bill visible in current month', billActiveInMonth(legacyBill, '2026-06') === true);
check('archived bill never active', billActiveInMonth(archivedBill, '2026-06') === false);

// ── Wiring checks ───────────────────────────────────────────────────────────
check('addBill stamps start_month on insert',
  /\.insert\(\{[^}]*start_month\s*:/.test(appJs));
check('loader maps start_month into bill objects (startMonth)',
  /startMonth\s*:\s*r\.start_month/.test(appJs));
check('month-scoped funcs use activeBills helper (coverage/surplus/snowball/garden/growth)',
  // coveragePct/getSurplus/snowballOrder/renderGarden/renderGrowth/showWateringPopup
  // all route month-scoped bill sets through the helper.
  (appJs.match(/activeBillsFor\(/g) || []).length >= 8);

// renderGrowth builds the "growth garden" scene — must filter by view month too,
// or a new bill shows in the growth garden for past months.
const growth = appJs.match(/function renderGrowth\(\)\{[\s\S]*?\n\}\n/);
check('renderGrowth exists', !!growth);
check('growth garden scene has no raw unfiltered !b.archived bill set',
  !!growth && !/bills\.filter\(b=>!b\.archived\)/.test(growth[0]));

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll start_month checks passed.');
