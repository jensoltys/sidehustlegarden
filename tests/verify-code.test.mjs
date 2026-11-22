// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// verify-code hardening:
// F1: the code alone no longer finishes an account. The password set on the
//     row has to come with it, so someone who re-signed-up on an unverified
//     address can't ride the owner's code into an account with their password.
// F2: an already-verified address gets the same 400 as an unknown one (was a
//     409 that told anyone which emails have accounts).
// Also: the legacy GET verify-email link no longer verifies anything.
// Run: node --test --test-force-exit tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { hashPassword } from '../src/lib/pw.js';

const ORIGIN = 'https://copy.example.com';
const PW = 'correct-horse-1';
const CODE = '123456';
const UID = '11111111-2222-4333-8444-555555555555';
const INVALID = 'That code is invalid or expired.';

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('hex');
}

async function makeEnv({ verified = 0, lost = false } = {}) {
  const user = { id: UID, email: 'a@example.com', password_hash: await hashPassword(PW), email_verified: verified, token_version: 0 };
  const codeHash = await sha256Hex(UID + ':' + CODE);
  const writes = [];
  const DB = {
    prepare(sql) {
      let args = [];
      const stmt = {
        sql,
        bind(...a) { args = a; return stmt; },
        async first() {
          if (/COUNT\(\*\)/.test(sql)) return { n: 0, c: 0 };
          if (/FROM users WHERE (email|id)\s*=\s*\?/.test(sql)) return (args[0] === user.email || args[0] === user.id) ? user : null;
          if (/FROM email_verification_tokens WHERE user_id=\? AND token IN/.test(sql)) return (args[0] === UID && (args[1] === codeHash || args[2] === codeHash)) ? { token: codeHash } : null;
          if (/FROM email_verification_tokens WHERE token=\?/.test(sql)) return { user_id: UID, expires_at: 9e12 };
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          // lost: simulates the row changing between the reads and the batch
          // (password swapped by a re-signup, code used by a parallel request).
          if (/^\s*UPDATE users SET email_verified/.test(sql)) {
            if (lost) return { meta: { changes: 0 } };
            writes.push(sql); user.email_verified = 1;
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts) { return Promise.all(stmts.map(s => s.run())); },
  };
  return { GARDEN_SESSION_SECRET: 'test-secret-test-secret-test-secret-1234', DB, user, writes };
}

function post(body) {
  return new Request(ORIGIN + '/api/auth/verify-code', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.9', 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  });
}
async function call(r, env) {
  const resp = await worker.fetch(r, env, { waitUntil() {} });
  const text = await resp.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, setCookie: resp.headers.get('Set-Cookie') || '', body };
}

test('verify-code without a password is a 400 and verifies nothing', async () => {
  const env = await makeEnv();
  const r = await call(post({ email: 'a@example.com', code: CODE }), env);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Enter your password along with the code.');
  assert.equal(env.user.email_verified, 0);
  assert.equal(r.setCookie, '');
});

test('verify-code with the right code but the wrong password is a 400, no session', async () => {
  const env = await makeEnv();
  const r = await call(post({ email: 'a@example.com', code: CODE, password: 'attacker-pass-9' }), env);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^That password doesn't match this account\./);
  assert.equal(env.user.email_verified, 0);
  assert.equal(r.setCookie, '');
});

test('verify-code with the right code and password verifies and signs in', async () => {
  const env = await makeEnv();
  const r = await call(post({ email: 'a@example.com', code: CODE, password: PW }), env);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, 'a@example.com');
  assert.equal(env.user.email_verified, 1);
  assert.match(r.setCookie, /^garden_session=/);
});

test('a wrong code is the generic 400 even with the right password', async () => {
  const env = await makeEnv();
  const r = await call(post({ email: 'a@example.com', code: '654321', password: PW }), env);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, INVALID);
});

test('already-verified and unknown addresses get the identical 400', async () => {
  const env = await makeEnv({ verified: 1 });
  const known = await call(post({ email: 'a@example.com', code: CODE, password: PW }), env);
  const unknown = await call(post({ email: 'nobody@example.com', code: CODE, password: PW }), env);
  assert.equal(known.status, 400);
  assert.equal(unknown.status, 400);
  assert.deepEqual(known.body, unknown.body);
  assert.equal(known.body.error, INVALID);
  assert.equal(known.setCookie, '');
});

test('legacy GET verify-email link no longer verifies anything', async () => {
  const env = await makeEnv();
  const resp = await worker.fetch(new Request(ORIGIN + '/api/auth/verify-email?token=' + UID + ':' + CODE), env, { waitUntil() {} });
  assert.equal(resp.status, 200);
  assert.match(await resp.text(), /This link has expired/);
  assert.equal(env.user.email_verified, 0);
  assert.equal(env.writes.length, 0);
});

test('if the row changes between the checks and the write, no session is minted', async () => {
  const env = await makeEnv({ lost: true });
  const r = await call(post({ email: 'a@example.com', code: CODE, password: PW }), env);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, INVALID);
  assert.equal(r.setCookie, '');
  assert.equal(env.user.email_verified, 0);
});
