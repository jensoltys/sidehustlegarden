// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Session cookie: the login JWT moved from localStorage
// garden_token (sent as Authorization: Bearer) to the HttpOnly garden_session
// cookie. Covers: cookie set on login, cookie auth, the old Bearer is refused
// (401, no Set-Cookie) now the transition is over, logout clears it (and still revokes the jti),
// cross-origin writes refused (403), garbage cookies get a 401 (never a 500,
// every 500 fires the alert webhook).
// Run: node --test --test-force-exit tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { hashPassword } from '../src/lib/pw.js';
import { signSessionJWT } from '../src/lib/jwt.js';

const ORIGIN = 'https://copy.example.com';
const SECRET = 'test-secret-test-secret-test-secret-1234';
const PW = 'correct-horse-1';
const COOKIE = 'garden_session';
const UID = '11111111-2222-4333-8444-555555555555';

function b64(s) { return Buffer.from(s).toString('base64url'); }
async function hs256(payload, secret = SECRET) {
  const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

// One verified user, token_version 0. Tracks revoked jtis.
async function makeEnv() {
  const user = { id: UID, email: 'a@example.com', password_hash: await hashPassword(PW), email_verified: 1, token_version: 0 };
  const revoked = new Set();
  const DB = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() {
          if (/COUNT\(\*\)/.test(sql)) return { n: 0, c: 0 };
          if (/FROM revoked_sessions WHERE jti/.test(sql)) return revoked.has(args[0]) ? { 1: 1 } : null;
          if (/FROM users WHERE (email|id)\s*=\s*\?/.test(sql)) return (args[0] === user.email || args[0] === user.id) ? user : null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (/INSERT OR REPLACE INTO revoked_sessions/.test(sql)) revoked.add(args[0]);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts) { return Promise.all(stmts.map(s => s.run())); },
  };
  return { GARDEN_SESSION_SECRET: SECRET, DB, user, revoked };
}

function req(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(r, env) {
  const resp = await worker.fetch(r, env, { waitUntil() {} });
  return { status: resp.status, setCookie: resp.headers.get('Set-Cookie') || '', body: await resp.json().catch(() => null) };
}
const validJwt = (tv = 0) => signSessionJWT({ sub: UID, email: 'a@example.com', tv }, SECRET);
const jtiOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).jti;

test('login sets the HttpOnly session cookie and no longer returns the token', async () => {
  const env = await makeEnv();
  const r = await call(req('/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: PW }, headers: { Origin: ORIGIN } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.body.token, undefined);
  assert.equal(r.body.user.email, 'a@example.com');
  assert.match(r.setCookie, /^garden_session=[\w-]+\.[\w-]+\.[\w-]+; /);
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000']) assert.ok(r.setCookie.includes(attr), attr);
});

test('the cookie alone authenticates, and GET /api/me answers who it is', async () => {
  const env = await makeEnv();
  const r = await call(req('/api/me', { headers: { Cookie: `other=1; ${COOKIE}=${await validJwt()}` } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'a@example.com');
  assert.equal(r.setCookie, '', 'a cookie session is not re-set on every request');
});

test('a valid Bearer token alone is refused: 401 and no Set-Cookie', async () => {
  const env = await makeEnv();
  const jwt = await validJwt();
  const r = await call(req('/api/me', { headers: { Authorization: `Bearer ${jwt}` } }), env);
  assert.equal(r.status, 401);
  assert.equal(r.setCookie, '', 'a Bearer is never turned into a cookie');
  for (const [method, path, body] of [['PUT', '/api/settings', { monthly_goal: 500 }], ['POST', '/api/bills', { name: 'Rent', amount: 10 }]]) {
    const w = await call(req(path, { method, body, headers: { Origin: ORIGIN, Authorization: `Bearer ${jwt}` } }), env);
    assert.equal(w.status, 401, `${method} ${path} with Bearer only`);
    assert.equal(w.setCookie, '');
  }
});

test('a garbage cookie with a valid Bearer is refused, not upgraded', async () => {
  const env = await makeEnv();
  const jwt = await validJwt();
  const r = await call(req('/api/me', { headers: { Cookie: `${COOKIE}=garbage`, Authorization: `Bearer ${jwt}` } }), env);
  assert.equal(r.status, 401);
  assert.equal(r.setCookie, '');
});

test('logout clears the cookie and still revokes the session server-side', async () => {
  const env = await makeEnv();
  const jwt = await validJwt();
  const r = await call(req('/api/auth/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: `${COOKIE}=${jwt}` } }), env);
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /^garden_session=; /);
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0']) assert.ok(r.setCookie.includes(attr), attr);
  assert.ok(env.revoked.has(jtiOf(jwt)), 'jti went into revoked_sessions');
  const after = await call(req('/api/me', { headers: { Cookie: `${COOKIE}=${jwt}` } }), env);
  assert.equal(after.status, 401, 'the logged-out token is dead even if replayed');
});

test('logout with a revoked or garbage cookie still clears it', async () => {
  const env = await makeEnv();
  const r = await call(req('/api/auth/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: `${COOKIE}=nope` } }), env);
  assert.equal(r.status, 200);
  assert.ok(r.setCookie.includes('Max-Age=0'));
});

test('cross-origin POST/PUT/PATCH/DELETE carrying the cookie is refused with 403', async () => {
  const env = await makeEnv();
  const Cookie = `${COOKIE}=${await validJwt()}`;
  const id = '99999999-2222-4333-8444-555555555555';
  const body = { name: 'Rent', amount: 10 };
  for (const [method, path] of [['POST', '/api/bills'], ['PUT', '/api/settings'], ['DELETE', `/api/bills/${id}`], ['PATCH', `/api/bills/${id}/archive`], ['POST', '/api/payments'], ['DELETE', '/api/me'], ['POST', '/api/auth/logout'], ['POST', '/api/feedback']]) {
    const evil = await call(req(path, { method, body, headers: { Cookie, Origin: 'https://evil.example' } }), env);
    assert.equal(evil.status, 403, `${method} ${path} from another origin`);
    const none = await call(req(path, { method, body, headers: { Cookie } }), env);
    assert.equal(none.status, 403, `${method} ${path} with no Origin or Referer`);
    const badRef = await call(req(path, { method, body, headers: { Cookie, Referer: 'https://copy.example.com.evil.example/' } }), env);
    assert.equal(badRef.status, 403, `${method} ${path} with a look-alike Referer`);
  }
});

test('same-origin write with the cookie goes through (Origin or Referer)', async () => {
  const env = await makeEnv();
  const Cookie = `${COOKIE}=${await validJwt()}`;
  const body = { monthly_goal: 500 };
  const a = await call(req('/api/settings', { method: 'PUT', body, headers: { Cookie, Origin: ORIGIN } }), env);
  assert.equal(a.status, 200);
  const b = await call(req('/api/settings', { method: 'PUT', body, headers: { Cookie, Referer: ORIGIN + '/' } }), env);
  assert.equal(b.status, 200);
});

test('garbage, tampered, expired and revoked cookies get 401, never 500', async () => {
  const env = await makeEnv();
  const now = Math.floor(Date.now() / 1000);
  const expired = await hs256({ sub: UID, email: 'a@example.com', tv: 0, iat: now - 100, exp: now - 10, iss: 'garden', jti: 'x' });
  const revoked = await validJwt(7);
  const forged = await hs256({ sub: UID, email: 'a@example.com', tv: 0, iat: now, exp: now + 3600, iss: 'garden', jti: 'y' }, 'wrong-secret');
  const noJti = await hs256({ sub: UID, tv: 0, iat: now, exp: now + 3600, iss: 'garden' });
  const values = ['garbage', 'a.b.c', '...', '%%%', 'eyJ.eyJ.sig', '!!.@@.##', 'x'.repeat(5000), expired, revoked, forged, noJti, ''];
  for (const v of values) {
    const r = await call(req('/api/me', { headers: { Cookie: `${COOKIE}=${v}` } }), env);
    assert.equal(r.status, 401, `cookie ${String(v).slice(0, 20)} -> ${r.status}`);
  }
  const bearer = await call(req('/api/me', { headers: { Authorization: 'Bearer %%%.@@.!!' } }), env);
  assert.equal(bearer.status, 401);
  assert.equal(bearer.setCookie, '', 'a refused Bearer never sets a cookie');
});
