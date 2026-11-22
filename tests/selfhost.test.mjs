// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// A copy with no Pro hub must say so, so the page never sells Pro that can't unlock here.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';

const SECRET = 'test-secret-test-secret-test-secret-1234';
// The Workers runtime has HTMLRewriter; Node doesn't. A pass-through stand-in is enough here.
if (!globalThis.HTMLRewriter) globalThis.HTMLRewriter = class { on() { return this; } transform(r) { return r; } };
const DB = { prepare() { const st = { bind() { return st; }, async first() { return null; }, async run() { return { meta: {} }; }, async all() { return { results: [] }; } }; return st; }, async batch(s) { return s.map(() => ({ results: [] })); } };
const call = (path, env, init = {}) => worker.fetch(new Request('https://copy.example.com' + path, init), { GARDEN_SESSION_SECRET: SECRET, DB, ...env }, { waitUntil() {} });
const config = (env) => call('/api/pro-config', env).then(r => r.json());

test('pro-config: no hub connected = pro_available false', async () => {
  const d = await config({});
  assert.equal(d.pro_available, false);
  assert.equal(d.upgrade_url, null);
  assert.equal(d.pro_price_text, null);
});

test('pro-config: no hub = no upgrade link or price, even if UPGRADE_URL is set', async () => {
  const d = await config({ UPGRADE_URL: 'https://pay.example.com/pro', PRO_PRICE_TEXT: '$5/mo' });
  assert.equal(d.pro_available, false);
  assert.equal(d.upgrade_url, null);
  assert.equal(d.pro_price_text, null);
});

test('pro-config: hub + UPGRADE_URL + PRO_PRICE_TEXT come back as set', async () => {
  const d = await config({ PRO_VERIFY_URL: 'https://hub.example.com/verify', UPGRADE_URL: 'https://pay.example.com/pro', PRO_PRICE_TEXT: '$5 a month' });
  assert.equal(d.pro_available, true);
  assert.equal(d.upgrade_url, 'https://pay.example.com/pro');
  assert.equal(d.pro_price_text, '$5 a month');
});

test('pro-config: a non-https PRO_VERIFY_URL or a non-http UPGRADE_URL is ignored', async () => {
  assert.equal((await config({ PRO_VERIFY_URL: 'http://hub.example.com/verify' })).pro_available, false);
  assert.equal((await config({ PRO_VERIFY_URL: 'https://hub.example.com/verify', UPGRADE_URL: 'javascript:alert(1)' })).upgrade_url, null);
});

test('pro-config: feedback_available follows FEEDBACK_WEBHOOK_URL', async () => {
  assert.equal((await config({})).feedback_available, false);
  assert.equal((await config({ FEEDBACK_WEBHOOK_URL: 'https://hooks.example.com/fb' })).feedback_available, true);
});

test('no hub: pro-verify, pro-refresh and hub sign-in are off and call nobody', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response('{}'); };
  try {
    const post = (path, body) => call(path, {}, { method: 'POST', headers: { Origin: 'https://copy.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/pro-verify', { token: 'a.b.c' })).status, 404);
    assert.equal((await post('/api/pro-refresh', { token: 'a.b.c' })).status, 404);
    assert.equal((await post('/api/auth/hub-sso', { hub_pro_jwt: 'a.b.c' })).status, 404);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent, []);
});

test('402 upgrade_url follows UPGRADE_URL, and is left out with no hub', () => {
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /jenbuiltit\.com/);
  assert.equal((src.match(/upgrade_url: upgradeUrl\(/g) || []).length, 2);
});

test('static page fails closed: no paid upgrade link until the server says Pro is available', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /jenbuiltit\.com\/app-hub\/upgrade/);
  assert.doesNotMatch(html, /\$7\/mo|all five/);
  assert.match(html, /id="pro-required-price" hidden><\/p>/);
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /let proAvailable=false;/);
  assert.doesNotMatch(js, /jenbuiltit\.com\/app-hub\/(?:upgrade|api)/);
  assert.doesNotMatch(js, /\$7\/mo/);
});

test('session secrets shorter than 32 characters count as not set', async () => {
  const realError = console.error; console.error = () => {};
  try {
    const recap = await call('/api/service/recap?email=a@example.com&month=2026-01', { RECAP_SERVICE_SECRET: 'short' }, { headers: { 'X-Internal-Secret': 'short' } });
    assert.equal(recap.status, 401);
  } finally { console.error = realError; }
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

test('delete dialog: the Pro billing note stays hidden unless a hub is connected', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<p data-pro-on hidden[^>]*>Paying for Pro\?/);
});
