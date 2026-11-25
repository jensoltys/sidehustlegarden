// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// A copy stands on its own: no outside sign-in, no Pro it can't deliver, no setup traps.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';
import { signSessionJWT } from '../src/lib/jwt.js';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const ORIGIN = 'https://copy.example.com';
// The Workers runtime has HTMLRewriter; Node doesn't. A pass-through stand-in is enough here.
if (!globalThis.HTMLRewriter) globalThis.HTMLRewriter = class { on() { return this; } transform(r) { return r; } };
const DB = { prepare() { const st = { bind() { return st; }, async first() { return null; }, async run() { return { meta: {} }; }, async all() { return { results: [] }; } }; return st; }, async batch(s) { return s.map(() => ({ results: [] })); } };
// A database that knows one signed-in user (token_version 0, a password set, nothing revoked).
const userDB = { ...DB, prepare(sql) { const st = { bind() { return st; }, async first() { return /FROM revoked_sessions/.test(sql) ? null : /FROM users/.test(sql) ? { id: 'u1', email: 'a@example.com', token_version: 0, password_hash: 'x' } : null; }, async run() { return { meta: { changes: 1 } }; }, async all() { return { results: [] }; } }; return st; } };
const call = (path, env, init = {}) => worker.fetch(new Request(ORIGIN + path, init), { GARDEN_SESSION_SECRET: SECRET, DB, ...env }, { waitUntil() {} });
const cookieFor = async () => 'garden_session=' + await signSessionJWT({ sub: 'u1', email: 'a@example.com', tv: 0 }, SECRET);

// Names the hosted site uses for its own sign-in hand-off, spelled in pieces so a
// search of this repo for them finds nothing at all.
const HUB = 'hub';
const OLD_ROUTES = [
  ['POST', `/api/auth/${HUB}-sso`], ['GET', `/api/auth/${HUB}/start`], ['GET', `/api/auth/${HUB}/callback?code=abc&state=abc`],
  ['POST', `/api/auth/${HUB}/finish`], ['POST', '/api/pro-refresh'], ['POST', '/api/pro-verify'], ['GET', '/api/pro-lookup'], ['GET', '/api/pro-config'],
  ['GET', '/api/service/recap?email=a@example.com&month=2026-01'],
];
const OLD_NAMES = new RegExp([`${HUB}pro`, `${HUB}_pro`, `${HUB}-sso`, `${HUB}-handoff`, `x-${HUB}`, `app-${HUB}`, `${HUB}_jwt`, `${HUB}_lookup`, `app ${HUB}`, `pro ${HUB}`, 'entitlement token'].join('|'), 'i');

test('site-config: feedback_available follows FEEDBACK_WEBHOOK_URL, and nothing about Pro is offered', async () => {
  assert.deepEqual(await call('/api/site-config', {}).then(r => r.json()), { feedback_available: false });
  assert.deepEqual(await call('/api/site-config', { FEEDBACK_WEBHOOK_URL: 'https://hooks.example.com/fb' }).then(r => r.json()), { feedback_available: true });
});

test('the hosted site sign-in hand-off, Pro check, refresh and recap routes are gone, and call nobody', async () => {
  const cookie = await cookieFor();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response(JSON.stringify({ valid: true, email: 'victim@example.com', pro_until: '2099-01-01T00:00:00Z' })); };
  try {
    for (const [method, path] of OLD_ROUTES) {
      const init = (headers) => ({ method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify({ [`${HUB}_pro_jwt`]: 'a.b.c', token: 'a.b.c' }) : undefined });
      // Signed out: nobody is signed in, redirected or handed a cookie.
      const out = await call(path, { DB: userDB }, init({ 'X-Internal-Secret': SECRET }));
      assert.equal(out.status, 401, `${method} ${path} signed out`);
      assert.equal(out.headers.get('Set-Cookie'), null, path);
      assert.equal(out.headers.get('Location'), null, path);
      // Signed in: the route does not exist.
      const inn = await call(path, { DB: userDB }, init({ Cookie: cookie }));
      assert.equal(inn.status, 404, `${method} ${path} signed in`);
      assert.equal(inn.headers.get('Set-Cookie'), null, path);
    }
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent, []);
});

test('none of the hosted site hand-off code or links are in the app', () => {
  const files = ['../src/worker.js', ...readdirSync(new URL('../src/lib/', import.meta.url)).map(f => '../src/lib/' + f),
    ...readdirSync(new URL('../public/', import.meta.url)).filter(f => /\.(js|html|css)$/.test(f)).map(f => '../public/' + f),
    ...readdirSync(new URL('../public/legal/', import.meta.url)).map(f => '../public/legal/' + f),
    '../README.md', '../wrangler.toml', '../.dev.vars.example'];
  assert.ok(files.length > 8);
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(text, OLD_NAMES, f);
    assert.doesNotMatch(text, /location\.search[^\n]{0,80}pro/i, f);
  }
});

test('everyone is on the free plan, whatever a visitor sends', async () => {
  const cookie = await cookieFor();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response(JSON.stringify({ valid: true, email: 'a@example.com', pro_until: '2099-01-01T00:00:00Z' })); };
  try {
    const headers = { Cookie: cookie, [`X-${HUB}-Pro`]: 'a.b.c' };
    assert.deepEqual(await call('/api/pro-status', { DB: userDB }, { headers }).then(r => r.json()), { is_pro: false });
    for (const [path, feature] of [['/api/forecast', 'cash-flow-forecast'], ['/api/export/csv', 'csv-export']]) {
      const r = await call(path, { DB: userDB }, { headers });
      assert.equal(r.status, 402, path);
      assert.deepEqual(await r.json(), { error: 'Pro required', feature });
    }
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent, []);
});

test('the page sells nothing: every Go Pro points at the hosted version and says so', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<a id="sb-unlock-pro-btn" class="btn tb-pro" href="https:\/\/sidehustlegarden\.com"/);
  assert.doesNotMatch(html, /\$7\/mo|all five/);
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /Pro isn't available on this copy of Side Hustle Garden/);
  assert.match(js, /cta\.textContent = 'Open sidehustlegarden\.com'/);
  assert.doesNotMatch(js, /\$7\/mo|all five/);
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /upgrade_url|checkout|jenbuiltit\.com/i);
});

test('account delete asks for the password, nothing else works', async () => {
  const cookie = await cookieFor();
  const r = await call('/api/me', { DB: userDB }, { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ [`${HUB}_pro_jwt`]: 'a.b.c' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /password/i);
});

test('no session secret: sign up, verify and log in answer with a setup message and write nothing', async () => {
  const realError = console.error; console.error = () => {};
  const wrote = [];
  const spyDB = { prepare(sql) { const st = { bind() { return st; }, async first() { return null; }, async run() { wrote.push(sql); return { meta: {} }; }, async all() { return { results: [] }; } }; return st; }, async batch(s) { wrote.push('batch'); return s.map(() => ({ results: [] })); } };
  try {
    for (const secret of [undefined, '', 'too-short']) {
      for (const [path, body] of [['signup', { email: 'a@example.com', password: 'correct horse 99' }], ['login', { email: 'a@example.com', password: 'correct horse 99' }], ['verify-code', { email: 'a@example.com', code: '123456', password: 'correct horse 99' }]]) {
        const r = await worker.fetch(new Request('https://copy.example.com/api/auth/' + path, { method: 'POST', headers: { Origin: 'https://copy.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { GARDEN_SESSION_SECRET: secret, DB: spyDB }, { waitUntil() {} });
        assert.equal(r.status, 503, path);
        const j = await r.json();
        assert.equal(j.code, 'setup_required');
        assert.match(j.error, /GARDEN_SESSION_SECRET/);
      }
    }
    assert.deepEqual(wrote, []);
  } finally { console.error = realError; }
});

test('a request from another site is refused, and CORS names only this site', async () => {
  const r = await call('/api/auth/login', {}, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://copy.example.com');
});

test('pages get this site address in og:url, og:image and the canonical link', async () => {
  const page = '<html><head><meta property="og:url" content="/guide"><meta property="og:image" content="/og.png"><meta name="twitter:image" content="/og.png"/></head><body></body></html>';
  const ASSETS = { async fetch() { return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); } };
  const html = await call('/guide', { APP_URL: 'https://copy.example.com/', ASSETS }).then(r => r.text());
  assert.match(html, /<meta property="og:url" content="https:\/\/copy\.example\.com\/guide">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/copy\.example\.com\/og\.png">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/copy\.example\.com\/og\.png"\/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/copy\.example\.com\/guide"\/>/);
  const real = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(real, /sidehustlegarden\.com\/og\.png/);
});
