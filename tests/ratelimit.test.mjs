// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Rate limits and the auth limits built on them, against a real SQLite database
// built from migrations/, wrapped in a small D1-shaped adapter.
// Run: node --test --test-force-exit tests/ratelimit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { overLimit, hitCount, ipKey } from '../src/lib/ratelimit.js';
import { hashPassword } from '../src/lib/pw.js';
import worker from '../src/worker.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const SCHEMA = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(new URL(f, MIGRATIONS), 'utf8')).join('\n');

function d1(db) {
  const exec = (q, args) => (/^\s*select/i.test(q)
    ? { results: db.prepare(q).all(...args) }
    : { results: [], meta: { changes: Number(db.prepare(q).run(...args).changes) } });
  return {
    prepare(q) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(q).get(...args) ?? null; },
        async all() { return { results: db.prepare(q).all(...args) }; },
        async run() { return exec(q, args); },
        _exec() { return exec(q, args); },
      };
      return stmt;
    },
    // Like D1: the whole batch runs as one unit, with no other request in between.
    async batch(stmts) { return stmts.map(st => st._exec()); },
  };
}

function freshEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return { env: { DB: d1(db), GARDEN_SESSION_SECRET: 'test-secret-test-secret-test-secret-1234' }, db };
}

const ORIGIN = 'https://garden.example.com';
const UID = '11111111-2222-4333-8444-555555555555';
const EMAIL = 'a@example.com';
const PW = 'correct-horse-1';
const post = (env, path, body, ip = '203.0.113.7') => worker.fetch(new Request(ORIGIN + path, {
  method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body),
}), env, { waitUntil() {} });
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('hex');
}
async function addUser(db, { verified = 1 } = {}) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, email, password_hash, created_at, last_sign_in_at, email_verified) VALUES (?, ?, ?, ?, ?, ?)')
    .run(UID, EMAIL, await hashPassword(PW), now, now, verified);
}
async function addCode(db, code) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(await sha256Hex(UID + ':' + code), UID, now + 1800, now);
}
const quiet = async (fn) => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };

test('allows up to max hits in the window, then blocks', async () => {
  const { env } = freshEnv();
  for (let i = 0; i < 3; i++) assert.equal(await overLimit(env, 'reset-email:a@b.co', 3, 900), false);
  assert.equal(await overLimit(env, 'reset-email:a@b.co', 3, 900), true);
  assert.equal(await overLimit(env, 'reset-email:a@b.co', 3, 900), true);
});

test('keys are independent', async () => {
  const { env } = freshEnv();
  assert.equal(await overLimit(env, 'vr:a@b.co', 1, 60), false);
  assert.equal(await overLimit(env, 'vr:a@b.co', 1, 60), true);
  assert.equal(await overLimit(env, 'vr:c@d.co', 1, 60), false);
});

test('hits older than the window fall off and get cleaned up', async () => {
  const { env, db } = freshEnv();
  const old = Math.floor(Date.now() / 1000) - 1000;
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO rate_limits (key, created_at) VALUES (?, ?)').run('k:u1', old);
  assert.equal(await overLimit(env, 'k:u1', 3, 900), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?').get('k:u1').n, 1);
});

test('a refused hit is not kept, so hammering a capped key cannot keep it capped', async () => {
  const { env, db } = freshEnv();
  for (let i = 0; i < 3; i++) await overLimit(env, 'reset-email:a@b.co', 3, 900);
  for (let i = 0; i < 10; i++) assert.equal(await overLimit(env, 'reset-email:a@b.co', 3, 900), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?').get('reset-email:a@b.co').n, 3);
});

test('fails open when D1 throws', async () => {
  const env = { DB: { prepare() { throw new Error('D1 down'); } } };
  await quiet(async () => assert.equal(await overLimit(env, 'signup-ip:1.2.3.4', 1, 60), false));
});

test('a burst of parallel requests cannot slip past the cap', async () => {
  const { env } = freshEnv();
  const results = await Promise.all(Array.from({ length: 20 }, () => overLimit(env, 'vc:burst@b.co', 3, 60)));
  assert.equal(results.filter(over => !over).length, 3, 'exactly 3 of 20 parallel attempts should get through');
});

test('hitCount returns the count including this hit', async () => {
  const { env } = freshEnv();
  assert.equal(await hitCount(env, 'k', 60), 1);
  assert.equal(await hitCount(env, 'k', 60), 2);
});

test('ipKey: IPv4 as is, IPv6 cut to its /64', () => {
  const r = (ip) => new Request('https://x.example', { headers: { 'CF-Connecting-IP': ip } });
  assert.equal(ipKey(r('203.0.113.7')), '203.0.113.7');
  assert.equal(ipKey(r('2001:db8:1:2:aaaa:bbbb:cccc:dddd')), ipKey(r('2001:db8:1:2::1')));
  assert.notEqual(ipKey(r('2001:db8:1:2::1')), ipKey(r('2001:db8:1:3::1')));
});

test('login: 20 parallel wrong passwords, exactly 5 reach the password check', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  const codes = await quiet(() => Promise.all(Array.from({ length: 20 }, () => post(env, '/api/auth/login', { email: EMAIL, password: 'wrong-password-1' }).then(r => r.status))));
  // 10 per network per 5 minutes is the outer cap, 5 per account + network the inner one.
  assert.equal(codes.filter(c => c === 401).length, 5);
  assert.equal(codes.filter(c => c === 429).length, 15);
  assert.equal(codes.filter(c => c >= 500).length, 0);
});

test('login: the right password works over and over, and after 2 wrong ones', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    for (let i = 0; i < 7; i++) assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '198.51.100.' + i)).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'nope-nope-nope' }, '192.0.2.1')).status, 401);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '192.0.2.1')).status, 200);
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'failed-login-all:a@example.com'").get().n, 2);
});

test('login: a stranger who burns 5 tries locks out their own network only', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'guess-guess-' + i }, '192.0.2.9')).status, 401);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '192.0.2.9')).status, 429);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '203.0.113.50')).status, 200);
  });
});

test('verify-code: 5 wrong codes burn the code, so the right one no longer works', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  await quiet(async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '00000' + i, password: PW })).status, 400);
    assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '123456', password: PW })).status, 400);
  });
  assert.equal(db.prepare('SELECT email_verified AS v FROM users WHERE id = ?').get(UID).v, 0);
});

test('verify-code: the right code still works after a few misses', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  await quiet(async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '00000' + i, password: PW })).status, 400);
    assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '123456', password: PW })).status, 200);
  });
});

test('verify-code: 20 misses in a day close the account to guessing, even with a fresh code', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 });
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 20; i++) db.prepare('INSERT INTO rate_limits (key, created_at) VALUES (?, ?)').run('verify-miss-day:' + UID, now - 7200);
  await addCode(db, '654321');
  await quiet(async () => assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '654321', password: PW })).status, 400));
});

test('verify-code: 30 parallel wrong codes, exactly 8 are checked and none is a 500', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  const codes = await quiet(() => Promise.all(Array.from({ length: 30 }, (_, i) => post(env, '/api/auth/verify-code', { email: EMAIL, code: String(100000 + i), password: PW }).then(r => r.status))));
  assert.equal(codes.filter(c => c === 400).length, 8);
  assert.equal(codes.filter(c => c === 429).length, 22);
});

test('password reset: using one link kills every other link, and a link works once', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  const later = new Date(Date.now() + 3600000).toISOString();
  for (const raw of ['a'.repeat(64), 'b'.repeat(64)]) db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(await sha256Hex(raw), UID, later);
  await quiet(async () => {
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'a'.repeat(64), password: 'brand-new-pass-1' })).status, 200);
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'a'.repeat(64), password: 'brand-new-pass-2' })).status, 400);
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'b'.repeat(64), password: 'brand-new-pass-3' })).status, 400);
  });
});

test('password reset clears the wrong-password counters', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(await sha256Hex('c'.repeat(64)), UID, new Date(Date.now() + 3600000).toISOString());
  await quiet(async () => {
    for (let i = 0; i < 5; i++) await post(env, '/api/auth/login', { email: EMAIL, password: 'guess-guess-' + i }, '192.0.2.9');
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'c'.repeat(64), password: 'brand-new-pass-1' })).status, 200);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'brand-new-pass-1' }, '192.0.2.9')).status, 200);
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'failed-login%'").get().n, 0);
});

test('verify-code: a right code hands its daily try back', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  await quiet(async () => assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '123456', password: PW })).status, 200));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'verify-miss-day:%'").get().n, 0);
});

test('delete account: an account with a password needs it, a hub token is not enough', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  const realFetch = globalThis.fetch;
  // A hub that would vouch for this email, to prove the password is still required.
  globalThis.fetch = async () => new Response(JSON.stringify({ valid: true, email: EMAIL, pro_until: null }), { status: 200 });
  try {
    await quiet(async () => {
      const login = await post(env, '/api/auth/login', { email: EMAIL, password: PW });
      const cookie = login.headers.get('Set-Cookie').split(';')[0];
      const del = (body) => worker.fetch(new Request(ORIGIN + '/api/me', { method: 'DELETE', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }), { ...env, PRO_VERIFY_URL: 'https://hub.example.com/verify' }, { waitUntil() {} });
      assert.equal((await del({ hub_pro_jwt: 'a.b.c' })).status, 400);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
      assert.equal((await del({ current_password: PW })).status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    });
  } finally { globalThis.fetch = realFetch; }
});

test('a session is refused when its version cannot be read', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    const login = await post(env, '/api/auth/login', { email: EMAIL, password: PW });
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const broken = { ...env, DB: { ...env.DB, prepare(q) { if (/SELECT token_version FROM users/.test(q)) throw new Error('D1 down'); return env.DB.prepare(q); } } };
    const r = await worker.fetch(new Request(ORIGIN + '/api/me', { headers: { Cookie: cookie } }), broken, { waitUntil() {} });
    assert.equal(r.status, 401);
  });
});

test('a junk session cookie is a 401, never a 500', async () => {
  const { env } = freshEnv();
  for (const payload of ['bnVsbA', 'NQ', 'InMi', 'W10']) { // null, 5, "s", []
    for (const [method, path] of [['GET', '/api/me'], ['POST', '/api/auth/logout'], ['GET', '/api/bills']]) {
      const r = await worker.fetch(new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN, Cookie: `garden_session=x.${payload}.x` } }), env, { waitUntil() {} });
      assert.ok(r.status < 500, `${method} ${path} with payload ${payload} gave ${r.status}`);
    }
  }
});

test('a body that is not a JSON object is a 400, never a 500', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    const login = await post(env, '/api/auth/login', { email: EMAIL, password: PW });
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    for (const raw of ['5', 'true', '"s"', 'null', '[1]']) {
      const r = await worker.fetch(new Request(ORIGIN + '/api/bills/11111111-2222-4333-8444-555555555555', { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie }, body: raw }), env, { waitUntil() {} });
      assert.equal(r.status, 400, raw);
    }
  });
});

test('signup caps count a whole IPv6 /64 as one network', async () => {
  const { env } = freshEnv();
  const codes = await quiet(async () => { const out = []; for (let i = 0; i < 12; i++) out.push((await post(env, '/api/auth/signup', { email: `n${i}@example.com`, password: 'long-enough-pass-1' }, `2001:db8:1:2::${i + 1}`)).status); return out; });
  assert.equal(codes.filter(c => c === 200).length, 10);
  assert.equal(codes.filter(c => c === 429).length, 2);
});

test('verification mail: 3 per address per 15 minutes, then nothing goes out', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 });
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response('{}', { status: 200 }); };
  try {
    const mailEnv = { ...env, RESEND_API_KEY: 'test-key' };
    await quiet(async () => { for (let i = 0; i < 5; i++) await post(mailEnv, '/api/auth/signup', { email: EMAIL, password: PW }, '198.51.100.' + i); });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.filter(u => u.includes('api.resend.com')).length, 3);
  // The capped asks left the last emailed code in place: exactly one live code remains.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_verification_tokens WHERE user_id = ? AND used = 0').get(UID).n, 1);
});

test('verification mail: a capped ask leaves the code already in the inbox working', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 3; i++) db.prepare('INSERT INTO rate_limits (key, created_at) VALUES (?, ?)').run('verify-email:' + EMAIL, now - 30);
  const realFetch = globalThis.fetch; globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    await quiet(async () => {
      await post({ ...env, RESEND_API_KEY: 'test-key' }, '/api/auth/resend-verification', { email: EMAIL }, '198.51.100.77');
      assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '123456', password: PW })).status, 200);
    });
  } finally { globalThis.fetch = realFetch; }
});

test('reset mail: the daily ceiling stops sends without changing the answer', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 150; i++) db.prepare('INSERT INTO rate_limits (key, created_at) VALUES (?, ?)').run('mail-day:reset', now - 60);
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response('{}', { status: 200 }); };
  let status;
  try { status = await quiet(async () => (await post({ ...env, RESEND_API_KEY: 'test-key' }, '/api/auth/reset-request', { email: EMAIL })).status); } finally { globalThis.fetch = realFetch; }
  assert.equal(status, 200);
  assert.deepEqual(sent, []);
});

test('password reset on an unverified account verifies it, so the next login works', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 });
  db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(await sha256Hex('d'.repeat(64)), UID, new Date(Date.now() + 3600000).toISOString());
  await quiet(async () => {
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'd'.repeat(64), password: 'brand-new-pass-1' })).status, 200);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'brand-new-pass-1' })).status, 200);
  });
});

test('pro-refresh relay: 30 a minute per network, then 429', async () => {
  const { env } = freshEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ valid: false }), { status: 200 });
  try {
    const codes = [];
    for (let i = 0; i < 32; i++) codes.push((await post(env, '/api/pro-refresh', { token: 'a.b.c' })).status);
    assert.equal(codes.filter(c => c === 429).length, 2);
  } finally { globalThis.fetch = realFetch; }
});
