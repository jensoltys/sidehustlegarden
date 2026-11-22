// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Archive-moves-the-money regression test — Side Hustle Garden.
// Run: node scripts/test-archive-moves-money.mjs
//
// Bug: watering put money on a bill that was later cancelled and archived,
// and the Growth watering log still showed that money on the archived bill. Root cause: archiveBill() only flipped the
// `archived` flag. The payment's targets kept pointing at the archived bill,
// so the money was stranded there instead of moving to the bills still owed.
// removeBill() already moved it; archive never did.
//
// This test runs the real functions out of public/app.js against a fake store
// and asserts that archiving a bill moves THIS month's money to the other
// bills, saves the change, and leaves past months exactly as they were.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.log(`FAIL  ${name}`); failures++; }
}

// Pull a whole function out of app.js by name (brace-matched) so the shipped
// code is what runs here, not a copy.
function extract(name) {
  const at = appJs.search(new RegExp(`(async\\s+)?function ${name}\\(`));
  if (at < 0) return null;
  let i = appJs.indexOf('{', appJs.indexOf(')', at)), depth = 0;
  for (; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}' && --depth === 0) return appJs.slice(at, i + 1);
  }
  return null;
}

const NAMES = ['billAmt', 'billActiveInMonth', 'activeBillsFor', 'billPaid', 'snowballOrder',
  'moveBillMoney', 'archiveBillFrom', 'archiveBillFromRun', 'removeBill', 'unarchiveBill', 'coveragePct',
  'getMonthRange', 'stopMonthChoices', 'ymLabel'];
const sources = NAMES.map(n => ({ n, src: extract(n) }));
for (const s of sources) {
  if (!s.src) { console.log(`FAIL  ${s.n}() not found in public/app.js`); process.exit(1); }
}

const KU = '11111111-1111-4111-8111-111111111111';
const NET = '22222222-2222-4222-8222-222222222222';
const RENT = '33333333-3333-4333-8333-333333333333';

function makeGarden() {
  const saved = [];
  const sb = {
    from: (table) => ({
      update: (payload) => ({ eq: async (_c, id) => { saved.push({ table, id, payload: JSON.parse(JSON.stringify(payload)) }); return { data: null, error: null }; } }),
      delete: () => ({ eq: async (_c, id) => { saved.push({ table, id, deleted: true }); return { data: null, error: null }; } }),
    }),
  };
  const ctx = vm.createContext({
    sb, saved, console,
    CM: () => '2026-10',
    confirm: () => true,
    MNAMES: ['January','February','March','April','May','June','July','August','September','October','November','December'],
    setSyncStatus() {}, renderBillList() {}, renderGarden() {}, showToast() {},
  });
  vm.runInContext(`
    var monthlyAmounts = {};
    var bills = [
      { id: '${KU}',   name: 'Music streaming', amount: 12,  repeats: true, archived: false, startMonth: null },
      { id: '${NET}',  name: 'Internet',         amount: 60,  repeats: true, archived: false, startMonth: null },
      { id: '${RENT}', name: 'Rent',             amount: 900, repeats: true, archived: false, startMonth: null },
    ];
    // October: $50 watered. Smallest bill first, so $12 went to music streaming
    // Unlimited and $38 to Internet. September: the same split, already past.
    var payments = [
      { id: 'pay-sep', source: 'Etsy', amount: 50, month: '2026-09', pay_date: '2026-09-10', created_at: '2026-09-10T12:00:00Z',
        targets: [{ billId: '${KU}', billName: 'Music streaming', applied: 12 }, { billId: '${NET}', billName: 'Internet', applied: 38 }] },
      { id: 'pay-oct', source: 'Etsy', amount: 50, month: '2026-10', pay_date: '2026-10-13', created_at: '2026-10-13T12:00:00Z',
        targets: [{ billId: '${KU}', billName: 'Music streaming', applied: 12 }, { billId: '${NET}', billName: 'Internet', applied: 38 }] },
    ];
    ${sources.map(s => s.src).join('\n')}
  `, ctx);
  return ctx;
}

const appliedTo = (pay, id) => (pay.targets.find(t => t.billId === id) || { applied: 0 }).applied;

// ── Archive ────────────────────────────────────────────────────────────────
{
  const g = makeGarden();
  await vm.runInContext(`archiveBillFrom('${KU}', '2026-10')`, g);
  const oct = vm.runInContext(`payments.find(p => p.id === 'pay-oct')`, g);
  const sep = vm.runInContext(`payments.find(p => p.id === 'pay-sep')`, g);

  check('archive: this month, no money left on the archived bill', appliedTo(oct, KU) === 0);
  check('archive: this month, the freed $12 moved to Internet (38 -> 50)', appliedTo(oct, NET) === 50);
  check('archive: this month, the watering still adds up to what was earned',
    oct.targets.reduce((s, t) => s + t.applied, 0) === 50);
  check('archive: last month is untouched (Music streaming still shows $12)',
    appliedTo(sep, KU) === 12 && appliedTo(sep, NET) === 38);

  const payWrites = g.saved.filter(w => w.table === 'payments');
  check('archive: the changed watering is saved, and only that one',
    payWrites.length === 1 && payWrites[0].id === 'pay-oct');
  check('archive: what is saved has no target for the archived bill',
    payWrites.length === 1 && !payWrites[0].payload.targets.some(t => t.billId === KU));
  check('archive: the bill is flagged archived on the server, stopped October',
    g.saved.some(w => w.table === 'bills' && w.id === KU && w.payload && w.payload.archived === true && w.payload.end_month === '2026-10'));
  const sepCov = vm.runInContext(`coveragePct('2026-09')`, g);
  check('archive: September still counts Music streaming as owed and paid (50 of 972)',
    sepCov.totP === 50 && sepCov.totB === 972);
}

// ── Archive from a past month: that month and later move, earlier stays ─────
{
  const g = makeGarden();
  vm.runInContext(`payments.unshift({ id: 'pay-aug', source: 'Etsy', amount: 50, month: '2026-08', pay_date: '2026-08-10', created_at: '2026-08-10T12:00:00Z',
    targets: [{ billId: '${KU}', billName: 'Music streaming', applied: 12 }, { billId: '${NET}', billName: 'Internet', applied: 38 }] });`, g);
  await vm.runInContext(`archiveBillFrom('${KU}', '2026-09')`, g);
  const pay = (id) => vm.runInContext(`payments.find(p => p.id === '${id}')`, g);
  check('stopped Sept: September money moved (Internet 38 -> 50)', appliedTo(pay('pay-sep'), KU) === 0 && appliedTo(pay('pay-sep'), NET) === 50);
  check('stopped Sept: October money moved (Internet 38 -> 50)', appliedTo(pay('pay-oct'), KU) === 0 && appliedTo(pay('pay-oct'), NET) === 50);
  check('stopped Sept: August untouched (Music streaming still $12)', appliedTo(pay('pay-aug'), KU) === 12);
  const aug = vm.runInContext(`coveragePct('2026-08')`, g);
  const sep = vm.runInContext(`coveragePct('2026-09')`, g);
  check('stopped Sept: August counts Music streaming on both sides (50 of 972)', aug.totP === 50 && aug.totB === 972);
  check('stopped Sept: September leaves it out on both sides (50 of 960)', sep.totP === 50 && sep.totB === 960);
  check('stopped Sept: only the two moved waterings are saved',
    g.saved.filter(w => w.table === 'payments').map(w => w.id).sort().join() === 'pay-oct,pay-sep');
}

// ── A month later than this month is clamped to this month ─────────────────
{
  const g = makeGarden();
  await vm.runInContext(`archiveBillFrom('${KU}', '2027-01')`, g);
  check('future stop month is saved as this month',
    vm.runInContext(`bills.find(b => b.id === '${KU}').endMonth`, g) === '2026-10');
}

// ── Old archive with no stop month: % covered no longer inflated ───────────
{
  const g = makeGarden();
  vm.runInContext(`bills.find(b => b.id === '${KU}').archived = true;`, g);
  const sep = vm.runInContext(`coveragePct('2026-09')`, g);
  check('legacy archive: September counts only money on bills that are owed (38 of 960)',
    sep.totP === 38 && sep.totB === 960);
}

// ── Restore clears the stop month ──────────────────────────────────────────
{
  const g = makeGarden();
  await vm.runInContext(`archiveBillFrom('${KU}', '2026-09')`, g);
  await vm.runInContext(`unarchiveBill('${KU}')`, g);
  const b = vm.runInContext(`bills.find(b => b.id === '${KU}')`, g);
  check('restore: bill is active again with no stop month', !b.archived && b.endMonth === null);
}

// ── Stop-month picker offers this month back to the bill's start ───────────
{
  const g = makeGarden();
  vm.runInContext(`bills.find(b => b.id === '${KU}').startMonth = '2026-07';`, g);
  const c = vm.runInContext(`stopMonthChoices(bills.find(b => b.id === '${KU}'))`, g);
  check('picker: Oct back to Jul, newest first', c.join() === '2026-10,2026-09,2026-08,2026-07');
  const c2 = vm.runInContext(`stopMonthChoices(bills.find(b => b.id === '${NET}'))`, g);
  check('picker: no start month falls back to the first logged month', c2.join() === '2026-10,2026-09');
}

// ── Archive when every other bill is already paid: money becomes surplus ────
{
  const g = makeGarden();
  vm.runInContext(`bills = bills.filter(b => b.id !== '${RENT}');
    payments.find(p => p.id === 'pay-oct').targets = [
      { billId: '${KU}', billName: 'Music streaming', applied: 12 },
      { billId: '${NET}', billName: 'Internet', applied: 60 }];
    payments.find(p => p.id === 'pay-oct').amount = 72;`, g);
  await vm.runInContext(`archiveBillFrom('${KU}', '2026-10')`, g);
  const oct = vm.runInContext(`payments.find(p => p.id === 'pay-oct')`, g);
  check('archive: nothing left to water, archived bill drops off and no bill goes over its amount',
    appliedTo(oct, KU) === 0 && appliedTo(oct, NET) === 60);
}

// ── Delete still moves money in every month (unchanged behavior) ───────────
{
  const g = makeGarden();
  await vm.runInContext(`removeBill('${KU}')`, g);
  const oct = vm.runInContext(`payments.find(p => p.id === 'pay-oct')`, g);
  const sep = vm.runInContext(`payments.find(p => p.id === 'pay-sep')`, g);
  check('delete: this month moved (Internet 38 -> 50)', appliedTo(oct, KU) === 0 && appliedTo(oct, NET) === 50);
  check('delete: past month moved too (Internet 38 -> 50)', appliedTo(sep, KU) === 0 && appliedTo(sep, NET) === 50);
  check('delete: the bill is deleted on the server', g.saved.some(w => w.table === 'bills' && w.deleted));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
