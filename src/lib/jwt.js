// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Garden session JWT (HS256, Web Crypto).
// Signed with GARDEN_SESSION_SECRET, which must be a random string of 32+
// characters. Not shared with any other app or Pro hub.

const enc = new TextEncoder();

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlStr(s) {
  return b64url(enc.encode(s));
}
function b64urlDecodeStr(s) {
  const pad = s + '='.repeat((4 - s.length % 4) % 4);
  return atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(msg));
}

// Constant-time comparison via subtle.verify on the HMAC signature
async function hmacVerify(secret, msg, sigB64) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const pad = sigB64 + '='.repeat((4 - sigB64.length % 4) % 4);
  const raw = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
  const sig = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) sig[i] = raw.charCodeAt(i);
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(msg));
}

// 30-day expiry. JTI included for revocation list lookup.
const EXP_SECONDS = 30 * 24 * 60 * 60;

// tv = users.token_version at mint time. A password reset bumps the column,
// which ends every session minted before it (getUser compares the two).
function requireSecret(secret) {
  // Refuse to sign or check logins without a real secret. A missing one would turn
  // into the word 'undefined', and anyone could forge a session.
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('GARDEN_SESSION_SECRET must be set to a random string of 32+ characters.');
}

export async function signSessionJWT({ sub, email, tv = 0 }, secret) {
  requireSecret(secret);
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const header = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlStr(JSON.stringify({
    sub, email, tv, iat: now, exp: now + EXP_SECONDS, iss: 'garden', jti,
  }));
  const sig = b64url(await hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${sig}`;
}

export async function verifySessionJWT(token, secret) {
  requireSecret(secret);
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let payload;
  try { payload = JSON.parse(b64urlDecodeStr(p)); } catch { return null; }
  // A payload that isn't an object (null, a number) is an invalid token: 401, never a 500.
  if (!payload || typeof payload !== 'object') return null;
  if (payload.iss !== 'garden') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  // A malformed signature (bad base64) is an invalid token: 401, never a 500
  // that fires the alert webhook.
  let ok = false;
  try { ok = await hmacVerify(secret, `${h}.${p}`, s); } catch { return null; }
  if (!ok) return null;
  return payload;
}
