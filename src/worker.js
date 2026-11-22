// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Side Hustle Garden: Cloudflare Worker + D1.
// Security:
//   - All D1 queries use prepared statements with .bind()
//   - All endpoints validate input shape + length caps before any DB call
//   - user_id is read from JWT, never from request body
//   - Every CRUD query is scoped with WHERE user_id = ?
//   - Generic error messages (no user-existence enumeration)
//   - JWT signed with GARDEN_SESSION_SECRET (32+ characters, or sign-in stays off)
//   - Login lockout: 5 wrong passwords / 15 min per account + network, 20 per
//     account across all networks, each try recorded before the password check
//   - Request body size cap (64 KB) on all POST/PUT/PATCH/DELETE
//   - Session: HS256 JWT in the HttpOnly garden_session cookie
//   - CSRF: mutating requests must come from this site's own origin
//   - CORS: this site's own origin only
//   - HSTS + X-Frame-Options + X-Content-Type-Options + Referrer-Policy
//     + Permissions-Policy on every response
//   - GDPR Right-to-Access via authed GET /api/account/export
//   - Account delete requires password re-prompt (or hub token re-verify for hub-sso users)
//   - Signup on an existing UNVERIFIED row replaces its password (no pre-hijack);
//     hub-sso auto-verify drops any unproven password the same way
//   - Enum inputs (bill type) are allowlisted; aggregations use null-prototype maps

import { signSessionJWT, verifySessionJWT } from './lib/jwt.js';
import { hashPassword, verifyPassword } from './lib/pw.js';
import { reportServerError, alertPayloadFor, stripAlertHeader, markNoAlert } from './lib/alert.js';
import { emailLayout, emailPara, emailSmall, emailCode, emailButton } from './lib/email-look.js';
import { overLimit, hitCount, dropNewest, ipKey } from './lib/ratelimit.js';

// ── Settings read from wrangler.toml on every request ────────────────────────
// This site's own address (APP_URL). Links in emails use it.
let APP_BASE = '';
// Optional Pro hub (see README): PRO_VERIFY_URL checks a hub's Pro token. Blank =
// no Pro hub, so everyone is on the free plan and Go Pro explains where Pro lives.
let PRO_VERIFY = '';
// With a hub connected: where Go Pro sends people (UPGRADE_URL). Blank hides Go Pro.
let UPGRADE_BASE = '';
function setSiteSettings(env) {
  APP_BASE = String(env.APP_URL || '').replace(/\/+$/, '');
  const pv = String(env.PRO_VERIFY_URL || '').trim();
  PRO_VERIFY = /^https:\/\//i.test(pv) ? pv : '';
  const up = String(env.UPGRADE_URL || '').trim();
  UPGRADE_BASE = PRO_VERIFY && /^https?:\/\//i.test(up) ? up : '';
}
function upgradeUrl(feature) {
  if (!UPGRADE_BASE) return undefined;
  return UPGRADE_BASE + (UPGRADE_BASE.includes('?') ? '&' : '?') + 'feature=' + encodeURIComponent(feature);
}

// Secrets that sign or check logins. A short one is as bad as none, so any of these
// set to fewer than 32 characters is treated as not set, and logged once.
const SECRET_NAMES = ['GARDEN_SESSION_SECRET', 'HUB_LOOKUP_SECRET', 'RECAP_SERVICE_SECRET'];
const MIN_SECRET_LENGTH = 32;
let warnedShortSecret = false;
function usableEnv(env) {
  const short = SECRET_NAMES.filter(n => env[n] && String(env[n]).length < MIN_SECRET_LENGTH);
  if (!short.length) return env;
  if (!warnedShortSecret) {
    warnedShortSecret = true;
    console.error(`Ignoring ${short.join(', ')}: set to fewer than ${MIN_SECRET_LENGTH} characters, so treated as not set. Make one with: openssl rand -hex 32`);
  }
  const out = Object.create(env);
  for (const n of short) Object.defineProperty(out, n, { value: '', enumerable: true });
  return out;
}

// Link previews and search engines need full addresses. The pages ship with
// site-relative ones, so this fills in the site's own address (APP_URL) and adds
// the canonical link on the way out.
function escapeAttr(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function absoluteMeta(html, base) {
  const b = escapeAttr(base);
  let canonical = '';
  html = html.replace(/(<meta (?:property|name)="(og:url|og:image|twitter:image)" content=")(\/[^"]*)"/g, (m, head, name, path) => {
    if (name === 'og:url') canonical = b + path;
    return head + b + path + '"';
  });
  if (canonical && !html.includes('<link rel="canonical"')) {
    html = html.replace('</head>', () => `<link rel="canonical" href="${canonical}"/>\n</head>`);
  }
  return html;
}

// Email theme ("Night Bloom" + the lantern gnome). Layout: lib/email-look.js.
const EMAIL_THEME = {
  name: 'Side Hustle Garden', get mascotUrl() { return APP_BASE + '/email-mascot.png'; }, mascotAlt: 'The garden gnome', mascotW: 78,
  bg: '#1A0F1E', card: '#2C1C31', line: '#46304C', pri: '#FFD24A', pri2: '#F0B92E', on: '#2A1E00', a2: '#FF9F6E', text: '#FFF4E8', muted: '#C9B3BE',
};

// Optional: check a Pro hub's token with the hub's public verify endpoint
// (PRO_VERIFY_URL). The hub's signing secret never lives here. Trade-off: one extra HTTPS call
// on hub-sso (once per session, fine) and per /api/pro-status fetch (cached
// 1h on frontend so server hits are rare).
async function verifyHubToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;
  if (!PRO_VERIFY) return null;
  try {
    const r = await fetch(PRO_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.valid) return null;
    return { email: d.email, pro_until: d.pro_until };
  } catch {
    return null;
  }
}

// Pro entitlement check: free-user SSO tokens carry pro_until=null. A verified
// hubPro payload alone is NOT proof of Pro — must also have a future pro_until.
function hasProAccess(hubPro) {
  return !!(hubPro?.email && hubPro?.pro_until && new Date(hubPro.pro_until) > new Date());
}


// =============================== UTILITIES ================================

// Security headers applied to every response (HSTS, anti-clickjacking, etc.)
function securityHeaders() {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(self)',
  };
}

function res(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...securityHeaders(), ...extraHeaders },
  });
}

// A request is trusted only from this site's own origin, so a self-hosted copy
// works on any domain with nothing to configure. `self` is the origin this
// request was sent to (passed in, never kept between requests).
function corsHeaders(origin, path, self) {
  const allow = self;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hub-Pro',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function badReq(msg = 'Invalid request') { return res({ error: msg }, 400); }
function unauth() { return res({ error: 'Unauthorized' }, 401); }
function notFound() { return res({ error: 'Not found' }, 404); }

// Input validators
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPosNum = v => isNum(v) && v >= 0 && v < 1_000_000_000; // 1B cap
const isInt = v => Number.isInteger(v);
const isBool = v => typeof v === 'boolean';
const isMonth = v => isStr(v, 7) && /^\d{4}-\d{2}$/.test(v);
const isDate = v => isStr(v, 10) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isUuid = v => isStr(v, 36) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
// RFC-ish email: total length ≤254 (RFC 5321), must contain @, no whitespace.
const isEmail = v => typeof v === 'string' && v.length > 3 && v.length <= 254
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// One structured log line per auth event, kept by Workers Logs ([observability]
// in wrangler.toml). Never a raw email, password, token or IP: hashes only.
async function logAuth(type, request, { uid, email } = {}) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const evt = { evt: 'auth', type };
    if (uid) evt.uid = uid;
    else if (email) evt.email_hash = (await sha256Hex('email:' + String(email).toLowerCase())).slice(0, 16);
    evt.ip_hash = (await sha256Hex('ip:' + ip)).slice(0, 16);
    console.log(JSON.stringify(evt));
  } catch { /* logging never breaks a request */ }
}

// users.token_version for a new session's tv claim. 0 if the column is
// not there yet (migration 0005 not applied), which matches every old token.
async function currentTv(env, userId) {
  try {
    const r = await env.DB.prepare('SELECT token_version FROM users WHERE id = ?').bind(userId).first();
    return (r && r.token_version) || 0;
  } catch { return 0; }
}
// Ends every session minted before now for this user. Separate statement so a
// missing column (pre-migration) logs instead of failing the password change.
async function bumpTokenVersion(env, userId) {
  try {
    await env.DB.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').bind(userId).run();
  } catch (e) { console.error('token_version bump skipped:', e && e.message || e); }
}

// Footer copyright year, filled in per request (never at module load, where a
// Worker's clock reads 1970). Every page marks the spot with <span data-year>.
function withFooterYear(response) {
  if (!(response.headers.get('Content-Type') || '').includes('text/html')) return response;
  const year = String(new Date().getUTCFullYear());
  return new HTMLRewriter().on('[data-year]', { element(el) { el.setInnerContent(year); } }).transform(response);
}

// Body size cap — auth payloads are small, payments with targets arrays cap at ~32 KB.
// 64 KB is a generous ceiling; anything over is rejected before JSON.parse.
const MAX_BODY_BYTES = 64 * 1024;

async function readJson(request) {
  // Reject oversized bodies before reading into memory. Content-Length may be
  // absent for chunked uploads — also enforce length on the read text.
  const cl = request.headers.get('Content-Length');
  if (cl && Number(cl) > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    if (!text) return null;
    // Every route takes a JSON object. A bare number, string, null or array is
    // refused here, so no handler has to guard against one.
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── Session cookie ──────────────────────────────────────────────────────────
// The login session is the Garden JWT held in an HttpOnly cookie, so page
// scripts can never read it. Same 30-day life as the JWT inside it.
const SESSION_COOKIE = 'garden_session';
const SESSION_TTL = 30 * 86400;
const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

function sessionCookie(jwt, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${jwt}; ${COOKIE_ATTRS}; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
}
function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
// A JSON response that also starts (or replaces) the session cookie.
function resWithSession(body, jwt) {
  const r = res(body);
  r.headers.append('Set-Cookie', sessionCookie(jwt));
  return r;
}

async function sessionFrom(token, env) {
  if (!token) return null;
  // No usable session secret = nobody is logged in (never a thrown error).
  if (typeof env.GARDEN_SESSION_SECRET !== 'string' || env.GARDEN_SESSION_SECRET.length < 32) return null;
  const payload = await verifySessionJWT(token, env.GARDEN_SESSION_SECRET);
  if (!payload || typeof payload.sub !== 'string' || !payload.jti) return null;
  return payload;
}

// Auth: the user from the garden_session cookie, and only the cookie. The
// older localStorage Bearer token is no longer accepted.
async function getUser(request, env) {
  const cookieJwt = readCookie(request, SESSION_COOKIE);
  const payload = await sessionFrom(cookieJwt, env);
  if (!payload) return null;
  // Check revocation
  const revoked = await env.DB.prepare('SELECT 1 FROM revoked_sessions WHERE jti = ?')
    .bind(payload.jti).first();
  if (revoked) return null;
  // A password reset bumps users.token_version, which ends every session
  // minted before it. Tokens from before the tv claim read as 0.
  try {
    const row = await env.DB.prepare('SELECT token_version FROM users WHERE id = ?').bind(payload.sub).first();
    if (!row || (row.token_version ?? 0) !== (payload.tv ?? 0)) return null;
  } catch (e) {
    // Fail closed: if the version can't be read, the session can't be trusted.
    console.error('token_version check failed, session refused:', e && e.message || e);
    return null;
  }
  return { id: payload.sub, email: payload.email, jti: payload.jti };
}

// Hub Pro: read X-Hub-Pro header → remote verify → return {email, pro_until} or null
// A hub Pro token names its buyer. It counts only for the account it was bought
// for; presented by any other account it is treated as absent.
async function getHubPro(request, user) {
  const token = request.headers.get('X-Hub-Pro') || '';
  if (!token) return null;
  const hubPro = await verifyHubToken(token);
  if (hubPro?.email && user?.email && String(hubPro.email).toLowerCase() !== String(user.email).toLowerCase()) return null;
  return hubPro;
}

// Same-origin enforcement on every mutating request (CSRF). The session is
// an HttpOnly cookie the browser attaches no matter which site started the
// request, so every POST/PUT/PATCH/DELETE has to prove it came from our own
// pages: the origin the request was sent to.
// Origin is preferred. Referer is the fallback when a browser omits Origin.
function checkOrigin(request) {
  const method = request.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (CSRF_EXEMPT.has(new URL(request.url).pathname)) return true;
  const own = [new URL(request.url).origin];
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  if (origin) return own.includes(origin);
  if (referer && own.some(o => referer.startsWith(o + '/'))) return true;
  return false;
}

// State-changing routes that skip the Origin check, each with its reason.
// A route belongs here only if no browser ever calls it with our cookie.
// Side Hustle Garden has none: its only secret-header route
// (/api/service/recap) is a GET, the purge cron runs as scheduled() not
// fetch(), and there is no Stripe webhook in this app.
const CSRF_EXEMPT = new Set([]);

// ============================ RATE LIMITS =================================
// overLimit / hitCount live in ./lib/ratelimit.js (record-then-count in one D1
// batch, so parallel requests can't slip past a cap).
//
// Wrong-password lockout, keyed by account AND network: someone guessing at an
// address locks out their own network only, so the real owner (on another
// network) still gets in with the right password. Each try is recorded BEFORE
// the password check, and a correct password takes its own try back.
const LOGIN_LOCKOUT_MAX = 5;          // tries per account + network per window
const LOGIN_LOCKOUT_WINDOW_S = 900;   // 15 min
// Ceiling on wrong-password tries against ONE account from every network added
// together, so guessing spread across many networks stays slow. Above one
// network's 5 so a single guesser can't lock the owner out, and a password
// reset always gets the owner back in.
const LOGIN_ALL_MAX = 20;
const lockKeyFor = (email, request) => `failed-login:${email}|${ipKey(request)}`;
const tooMany = (msg, retryS) => res({ error: msg }, 429, { 'Retry-After': String(retryS) });
const lockedOut = () => res({ error: 'Too many failed attempts. Try again in 15 minutes, or use Forgot password to get back in now.' }, 429, { 'Retry-After': String(LOGIN_LOCKOUT_WINDOW_S) });

// ================================ ROUTES ==================================

export default {
  // Daily purge (wrangler.toml [triggers] crons): rate-limit rows older than a
  // day (the longest window is an hour), reset / verification token hashes 7
  // days after they expire, and logout revocations once the 30-day session they
  // name has expired anyway.
  async scheduled(event, env, ctx) {
    env = usableEnv(env);
    setSiteSettings(env);
    ctx.waitUntil(purgeExpired(env));
  },

  // Any 5xx that leaves this worker fires an email beacon (alert.js) so a
  // real visitor hitting a server error is a same-minute email, not a
  // someday discovery in the logs.
  async fetch(request, env, ctx) {
    env = usableEnv(env);
    setSiteSettings(env);
    // A THROW out of handle() has to become a Response before the 5xx branch
    // below can see it. Without this catch the exception escaped the worker,
    // the runtime returned its own 500, and NO alert email was sent — silent on
    // exactly the crash class the beacon exists for.
    let response;
    let errDetail = '';
    try {
      response = await this.handle(request, env, ctx);
    } catch (e) {
      console.error('unhandled route error', request.method, new URL(request.url).pathname, (e && e.stack) || e);
      response = new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      // The message the beacon reads comes off this body, so name the cause.
      errDetail = String((e && e.message) || e).slice(0, 200);
    }
    try {
      if (response && response.status >= 500) {
        // The message is read off a clone of the response body inside
        // waitUntil, so it never delays the client. Responses tagged by
        // markNoAlert() are skipped.
        const job = alertPayloadFor(request, response, errDetail)
          .then(info => (info ? reportServerError(env, null, info) : null))
          .catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch { /* never block the response */ }
    return stripAlertHeader(response);
  },

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...securityHeaders(), ...corsHeaders(origin, path, url.origin) },
      });
    }

    // Helper to wrap response with CORS headers + security headers
    const withCors = (resp) => {
      const h = new Headers(resp.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin, path, url.origin))) h.set(k, v);
      for (const [k, v] of Object.entries(securityHeaders())) h.set(k, v);
      return new Response(resp.body, { status: resp.status, headers: h });
    };

    try {
      // CSRF check on mutating requests
      if (!checkOrigin(request)) {
        return withCors(res({ error: 'Cross-origin request blocked' }, 403));
      }

      // ===== PUBLIC ROUTES =====
      if (path === '/api/health' && request.method === 'GET') {
        return withCors(res({ ok: true }));
      }

      // A copy with no session secret can't log anyone in. Say so before any
      // account is written, instead of failing halfway with "Server error".
      if (path.startsWith('/api/auth/') && request.method === 'POST' && path !== '/api/auth/logout'
          && (typeof env.GARDEN_SESSION_SECRET !== 'string' || env.GARDEN_SESSION_SECRET.length < 32)) {
        console.error('GARDEN_SESSION_SECRET is not set (or is shorter than 32 characters). Sign up and log in are off until it is.');
        return withCors(markNoAlert(res({ error: "This server isn't set up yet. Its owner needs to set GARDEN_SESSION_SECRET to a random string of 32 or more characters.", code: 'setup_required' }, 503)));
      }

      // Hub SSO: hub Pro JWT → Garden session JWT
      // - Checks hub_pro_jwt with the hub's verify endpoint (PRO_VERIFY_URL)
      // - Finds or auto-creates Garden user with that email
      // - Issues Garden session JWT
      if (path === '/api/auth/hub-sso' && request.method === 'POST') {
        return withCors(await hubSso(request, env));
      }

      // Email/password login (existing users)
      if (path === '/api/auth/login' && request.method === 'POST') {
        return withCors(await login(request, env));
      }

      // Email/password signup (new users without hub)
      if (path === '/api/auth/signup' && request.method === 'POST') {
        return withCors(await signup(request, env));
      }

      // Password reset — request a reset email
      if (path === '/api/auth/reset-request' && request.method === 'POST') {
        return withCors(await resetRequest(request, env));
      }

      // Password reset — confirm with token and set new password
      if (path === '/api/auth/reset-confirm' && request.method === 'POST') {
        return withCors(await resetConfirm(request, env));
      }

      // Email verification — finish with the 6-digit code from the email body
      if (path === '/api/auth/verify-code' && request.method === 'POST') {
        return withCors(await verifyCode(request, env));
      }

      // Email verification — legacy GET landing page hit from an old emailed link
      if (path === '/api/auth/verify-email' && request.method === 'GET') {
        return withCors(await verifyEmail(url, env));
      }

      // Email verification — resend the code email
      if (path === '/api/auth/resend-verification' && request.method === 'POST') {
        return withCors(await resendVerification(request, env));
      }

      // Feedback widget relay (off until FEEDBACK_WEBHOOK_URL is set): 5 per IP
      // per 10 min, a honeypot, and type/length checks before anything is forwarded.
      if (path === '/api/feedback' && request.method === 'POST') {
        const ip = ipKey(request);
        if (await overLimit(env, `feedback-ip:${ip}`, 5, 600)) return withCors(tooMany('Too many messages from this connection. Try again in a few minutes.', 600));
        return withCors(await feedback(request, env));
      }

      // Pro token refresh — same-origin proxy to the hub's refresh endpoint
      // (PRO_REFRESH_URL). The browser can't call the hub cross-origin, so we relay: JSON {token} in, hub's JSON + status straight back out
      // (200 {valid:true,token,pro_until} / 200 {valid:false} / 400 / 429).
      // On-demand only — nothing here is cached or stored server-side.
      if (path === '/api/pro-refresh' && request.method === 'POST') {
        return withCors(await proRefresh(request, env));
      }

      // Public: what this copy offers. The page reads it once on load, so it
      // never sells Pro this copy can't unlock, and hides Feedback when it's off.
      if (path === '/api/pro-config' && request.method === 'GET') {
        return withCors(res({
          pro_available: !!PRO_VERIFY,
          upgrade_url: UPGRADE_BASE || null,
          pro_price_text: (PRO_VERIFY && String(env.PRO_PRICE_TEXT || '').trim()) || null,
          feedback_available: !!env.FEEDBACK_WEBHOOK_URL,
        }, 200, { 'Cache-Control': 'no-store' }));
      }

      // Same-origin proxy to the hub's verify endpoint, so the page never calls
      // another site directly. Off (404) with no PRO_VERIFY_URL.
      if (path === '/api/pro-verify' && request.method === 'POST') {
        if (!PRO_VERIFY) return withCors(markNoAlert(res({ valid: false, error: 'Pro is off on this server.' }, 404)));
        if (await overLimit(env, `pro-verify-ip:${ipKey(request)}`, 30, 60)) return withCors(tooMany('Too many requests. Try again in a minute.', 60));
        const body = await readJson(request);
        const hub = body && isStr(body.token, 2048) ? await verifyHubToken(body.token) : null;
        return withCors(res(hub ? { valid: true, email: hub.email, pro_until: hub.pro_until } : { valid: false }));
      }

      // Internal service endpoint for a connected Pro hub's recap job. Carries its own
      // auth (X-Internal-Secret, timing-safe vs RECAP_SERVICE_SECRET), so it
      // lives with the public routes rather than behind cookie auth.
      if (path === '/api/service/recap' && request.method === 'GET') {
        return withCors(await serviceRecap(url, request, env));
      }

      // Non-API routes hit static assets (index.html / favicons / etc.)
      // before auth, so the SPA shell loads for anonymous visitors who will
      // log in via the UI. We re-wrap the asset response so security headers
      // (CSP, HSTS, X-Frame-Options, etc.) are delivered via HTTP — stronger
      // than the meta tag in index.html which is parsed mid-document.
      if (!path.startsWith('/api/')) {
        // /reset/<token> is a virtual route: there is no such asset, so ask
        // ASSETS for the SPA shell and let the frontend read the token off the
        // path. Without this the reset link 404s.
        const assetReq = /^\/reset\/[A-Za-z0-9._-]{16,256}\/?$/.test(path)
          ? new Request(new URL('/', request.url), request)
          : request;
        const asset = await env.ASSETS.fetch(assetReq);
        const h = new Headers(asset.headers);
        h.set('Content-Security-Policy',
          "default-src 'self'; " +
          "script-src 'self' https://static.cloudflareinsights.com; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com data:; " +
          "img-src 'self' data: blob:; " +
          "connect-src 'self' https://cloudflareinsights.com; " +
          "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';");
        for (const [k, v] of Object.entries(securityHeaders())) h.set(k, v);
        if (asset.status === 200 && request.method === 'GET' && APP_BASE && (h.get('Content-Type') || '').includes('text/html')) {
          h.delete('Content-Length');
          return withFooterYear(new Response(absoluteMeta(await asset.text(), APP_BASE), { status: 200, headers: h }));
        }
        return withFooterYear(new Response(asset.body, { status: asset.status, headers: h }));
      }

      // Logout needs no valid session: it always clears the cookie, so a stale
      // or revoked cookie can still be removed. A live session also has its
      // jti added to revoked_sessions, as before.
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const who = await getUser(request, env);
        if (who) {
          await env.DB.prepare('INSERT OR REPLACE INTO revoked_sessions (jti, user_id, revoked_at) VALUES (?, ?, ?)')
            .bind(who.jti, who.id, new Date().toISOString()).run();
        }
        const out = res({ ok: true });
        out.headers.append('Set-Cookie', clearSessionCookie());
        return withCors(out);
      }

      // ===== AUTHENTICATED ROUTES =====
      // GET /api/me below is also the boot check: the page can't read the
      // HttpOnly cookie, so one GET there decides "logged in?" (401 = no).
      const user = await getUser(request, env);
      if (!user) return withCors(unauth());

      if (path === '/api/me' && request.method === 'GET') {
        // has_password tells the delete-account modal which re-auth to ask
        // for: a password, or Pro hub re-verification for hub-only accounts.
        const me = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
        return withCors(res({ id: user.id, email: user.email, has_password: !!(me && me.password_hash) }));
      }

      // Pro follows the account: a session that has no hub token (older login, new
      // device) asks once and gets a hub-minted token back if the account is Pro.
      if (path === '/api/pro-lookup' && request.method === 'GET') {
        const t = await hubProLookup(user.email, env);
        return withCors(res(t ? { pro: true, token: t } : { pro: false }));
      }

      // ----- BILLS -----
      if (path === '/api/bills' && request.method === 'GET')  return withCors(await listBills(user, env));
      if (path === '/api/bills' && request.method === 'POST') return withCors(await createBill(user, request, env));

      const billMatch = path.match(/^\/api\/bills\/([0-9a-f-]{36})$/i);
      if (billMatch) {
        const id = billMatch[1];
        if (request.method === 'PUT')    return withCors(await updateBill(user, id, request, env));
        if (request.method === 'DELETE') return withCors(await deleteBill(user, id, env));
      }
      const archiveMatch = path.match(/^\/api\/bills\/([0-9a-f-]{36})\/archive$/i);
      if (archiveMatch && request.method === 'PATCH') {
        return withCors(await archiveBill(user, archiveMatch[1], request, env));
      }

      // ----- PAYMENTS -----
      if (path === '/api/payments' && request.method === 'GET')  return withCors(await listPayments(user, url, env));
      if (path === '/api/payments' && request.method === 'POST') return withCors(await createPayment(user, request, env));

      const payMatch = path.match(/^\/api\/payments\/([0-9a-f-]{36})$/i);
      if (payMatch) {
        const id = payMatch[1];
        if (request.method === 'PUT')    return withCors(await updatePayment(user, id, request, env));
        if (request.method === 'DELETE') return withCors(await deletePayment(user, id, env));
      }

      // ----- MONTHLY AMOUNTS -----
      if (path === '/api/monthly-amounts' && request.method === 'GET')  return withCors(await listMonthly(user, url, env));
      if (path === '/api/monthly-amounts' && request.method === 'POST') return withCors(await upsertMonthly(user, request, env));

      // ----- SETTINGS -----
      if (path === '/api/settings' && request.method === 'GET') return withCors(await getSettings(user, env));
      if (path === '/api/settings' && request.method === 'PUT') return withCors(await updateSettings(user, request, env));

      // ----- PRO STATUS -----
      if (path === '/api/pro-status' && request.method === 'GET') {
        const hubPro = await getHubPro(request, user);
        return withCors(res({
          is_pro: hasProAccess(hubPro),
          pro_available: !!PRO_VERIFY,
          email: hubPro?.email || null,
          pro_until: hubPro?.pro_until || null,
        }));
      }

      // ----- GDPR DATA EXPORT (Right to Access) -----
      if (path === '/api/account/export' && request.method === 'GET') {
        return withCors(await exportAccount(user, env));
      }

      // ----- PRO: 6-MONTH CASH FLOW FORECAST -----
      if (path === '/api/forecast' && request.method === 'GET') {
        const hubPro = await getHubPro(request, user);
        if (!hasProAccess(hubPro)) return withCors(res({
          error: 'Pro required',
          feature: 'cash-flow-forecast',
          upgrade_url: upgradeUrl('cash-flow-forecast'),
        }, 402));
        return withCors(await forecast(user, env));
      }

      // ----- PRO: CSV EXPORT -----
      if (path === '/api/export/csv' && request.method === 'GET') {
        const hubPro = await getHubPro(request, user);
        if (!hasProAccess(hubPro)) return withCors(res({
          error: 'Pro required',
          feature: 'csv-export',
          upgrade_url: upgradeUrl('csv-export'),
        }, 402));
        return withCors(await exportCsv(user, env));
      }

      // ----- DELETE ACCOUNT (requires password re-prompt or hub-JWT re-verify) -----
      if (path === '/api/me' && request.method === 'DELETE') {
        return withCors(await deleteAccount(user, request, env));
      }

      // Unknown /api/* route
      return withCors(notFound());
    } catch (err) {
      // Never leak stack traces or internal errors
      console.error('Worker error:', err && err.stack || err);
      return withCors(res({ error: 'Server error' }, 500));
    }
  },
};

// =============================== HANDLERS =================================

async function hubSso(request, env) {
  // Same per-IP bucket as password login: 10 per IP per 5 minutes.
  const ip = ipKey(request);
  if (await overLimit(env, `login-ip:${ip}`, 10, 300)) return tooMany('Too many sign-in attempts from this connection. Try again in a few minutes.', 300);
  const body = await readJson(request);
  if (!body || !isStr(body.hub_pro_jwt, 2048)) return badReq();
  if (!PRO_VERIFY) return markNoAlert(res({ error: 'Hub sign-in is off on this server.' }, 404));
  const hubPro = await verifyHubToken(body.hub_pro_jwt);
  if (!hubPro || !isEmail(hubPro.email)) return res({ error: 'Invalid hub token' }, 401);

  const email = hubPro.email.toLowerCase();
  let user = await env.DB.prepare('SELECT id, email, email_verified FROM users WHERE email = ?')
    .bind(email).first();

  if (!user) {
    // Auto-create the Garden user verified — hub already verified before SSO.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO users (id, email, created_at, last_sign_in_at, user_metadata, email_verified, verified_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).bind(id, email, now, now, JSON.stringify({ origin: 'hub_sso' }), now).run();
    user = { id, email };
  } else {
    // Existing user signing in via hub means hub already verified — bump them.
    if (!user.email_verified) {
      // The hub proved this email. Whoever set the row's password never did
      // (the row was unverified), so that password is dropped: a NULL hash can
      // never log in, and "Forgot password" is the only way to set a new one.
      // Before this, a squatter who signed up first kept their password after
      // the real owner arrived through the hub (pre-hijack account takeover).
      await env.DB.prepare('UPDATE users SET email_verified=1, verified_at=COALESCE(verified_at, ?), last_sign_in_at=?, password_hash=NULL WHERE id=?')
        .bind(new Date().toISOString(), new Date().toISOString(), user.id).run();
      await bumpTokenVersion(env, user.id); // the dropped password's sessions go with it
    } else {
      await env.DB.prepare('UPDATE users SET last_sign_in_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), user.id).run();
    }
  }

  const token = await signSessionJWT({ sub: user.id, email: user.email, tv: await currentTv(env, user.id) }, env.GARDEN_SESSION_SECRET);
  await logAuth('login_ok', request, { uid: user.id });
  return resWithSession({ user: { id: user.id, email: user.email } }, token);
}

async function login(request, env) {
  const body = await readJson(request);
  // Password length policy: 10–200 chars. (Existing 8-char users still work
  // for verify; only new signups need ≥10. Reject obviously-bad shapes here.)
  if (!body || !isEmail(body.email) || typeof body.password !== 'string'
      || body.password.length < 1 || body.password.length > 200) {
    return badReq();
  }
  const email = body.email.trim().toLowerCase();

  // Per-IP limit first: 10 attempts per IP per 5 minutes, across accounts.
  const ip = ipKey(request);
  if (await overLimit(env, `login-ip:${ip}`, 10, 300)) return tooMany('Too many sign-in attempts from this connection. Try again in a few minutes.', 300);

  // Wrong-password lockout (see RATE LIMITS). The try is recorded before the
  // password check, so parallel guesses can't race past it.
  const lockKey = lockKeyFor(email, request);
  if (await overLimit(env, lockKey, LOGIN_LOCKOUT_MAX, LOGIN_LOCKOUT_WINDOW_S)
      || await overLimit(env, `failed-login-all:${email}`, LOGIN_ALL_MAX, LOGIN_LOCKOUT_WINDOW_S)) {
    await logAuth('login_fail', request, { email });
    return lockedOut();
  }

  // Always perform a hash verify to avoid revealing user existence via timing
  const row = await env.DB.prepare('SELECT id, email, password_hash, email_verified FROM users WHERE email = ?')
    .bind(email).first();
  const stored = row?.password_hash || 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(body.password, stored);
  if (!ok || !row) {
    await logAuth('login_fail', request, { email });
    return res({ error: 'Invalid credentials' }, 401);
  }
  // Right password: take this try back out of both counters.
  await dropNewest(env, lockKey);
  await dropNewest(env, `failed-login-all:${email}`);
  if (!row.email_verified) {
    return res({ error: 'Please verify your email before logging in.', code: 'email_not_verified', email: row.email }, 403);
  }
  await env.DB.prepare('UPDATE users SET last_sign_in_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), row.id).run();
  const token = await signSessionJWT({ sub: row.id, email: row.email, tv: await currentTv(env, row.id) }, env.GARDEN_SESSION_SECRET);
  await logAuth('login_ok', request, { uid: row.id });
  const hubProToken = await hubProLookup(row.email, env);
  return resWithSession({ ...(hubProToken ? { hub_pro_token: hubProToken } : {}), user: { id: row.id, email: row.email } }, token);
}

// Pro follows the account, not the browser. At login (and any other
// session-minting response), ask the hub whether this email has Pro and carry
// a fresh hub token back. Optional: PRO_LOOKUP_URL + HUB_LOOKUP_SECRET. Unset =
// free plan for everyone. Never blocks login: any failure → null.
async function hubProLookup(email, env) {
  if (!env.PRO_LOOKUP_URL || !env.HUB_LOOKUP_SECRET) return null;
  try {
    const r = await fetch(env.PRO_LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.HUB_LOOKUP_SECRET },
      body: JSON.stringify({ email, app: 'side-hustle-garden' }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && j.pro === true && typeof j.token === 'string' ? j.token : null;
  } catch (e) {
    console.error('hubProLookup failed', e.message);
    return null;
  }
}

async function signup(request, env) {
  const body = await readJson(request);
  // Password policy for NEW signups: 10–200 chars.
  if (!body || !isEmail(body.email) || typeof body.password !== 'string'
      || body.password.length < 10 || body.password.length > 200) {
    return badReq('Email is required and password must be 10–200 characters.');
  }
  const email = body.email.trim().toLowerCase();
  const newsletter_consent = body.newsletter_consent === true;
  // 10 signups per IP per 5 minutes: each one costs a PBKDF2 hash, a D1 row
  // and a Resend email, so an unthrottled loop is both a cost bomb and a
  // way to flood someone's inbox with codes.
  const ip = ipKey(request);
  if (await overLimit(env, `signup-ip:${ip}`, 10, 300)) return tooMany('Too many signups from this connection. Try again in a few minutes.', 300);
  const SIGNUP_MSG = 'Check your inbox for a 6-digit code to verify your email before logging in.';
  const existing = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    if (!existing.email_verified) {
      // Nobody has proved they own this address yet. The newest signer-up
      // takes over the credentials and gets a fresh code; entering it is what
      // proves ownership. Before this, a row squatted by someone else kept ITS
      // password after the real owner verified (pre-hijack account takeover).
      const hash = await hashPassword(body.password);
      await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(hash, existing.id).run();
      await bumpTokenVersion(env, existing.id);
      const sent = await sendVerificationEmail(existing.id, email, env);
      return res({ ok: true, awaiting_verification: true, email, email_sent: sent, message: SIGNUP_MSG });
    }
    // Don't leak account existence. Burn PBKDF2 cycles to keep timing similar
    // and answer with the exact shape of a fresh signup.
    await hashPassword(body.password);
    return res({ ok: true, awaiting_verification: true, email, email_sent: true, message: SIGNUP_MSG });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const hash = await hashPassword(body.password);
  const userMeta = newsletter_consent
    ? JSON.stringify({ newsletter_consent: true, newsletter_consent_at: now })
    : null;
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, created_at, last_sign_in_at, user_metadata) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, email, hash, now, now, userMeta).run();
  // Optional operator ping on each signup (SIGNUP_WEBHOOK_URL). Off when unset.
  await notifySignup(env, 'side-hustle-garden', email, newsletter_consent === true);
  // email_sent is true only when Resend accepted the message, so the UI can
  // say when nothing went out instead of promising an inbox.
  const emailSent = await sendVerificationEmail(id, email, env);
  return res({ ok: true, awaiting_verification: true, email, email_sent: emailSent, message: SIGNUP_MSG });
}

// ── Email footer ────────────────────────────────────────────────────────────
// Every email this Worker sends ends with the same footer. Put your own company
// name and postal address here (many countries require one in email).
const EMAIL_SENDER_LINE = 'YOUR COMPANY NAME · YOUR BUSINESS ADDRESS';
const emailPrivacyUrl = () => `${APP_BASE}/legal/privacy`;
const emailFooterText = () => `${EMAIL_SENDER_LINE} · Privacy: ${emailPrivacyUrl()}`;
function emailFooterHtml(color = '#C9B3BE', rule = '#46304C') {
  return `<p style="font-size:12px;color:${color};margin-top:24px;text-align:center;border-top:1px solid ${rule};padding-top:12px;line-height:1.5">${EMAIL_SENDER_LINE.replace(' · ', ' &middot; ')} &middot; Privacy: <a href="${emailPrivacyUrl()}" style="color:${color}">${emailPrivacyUrl()}</a></p>`;
}

// Auth-mail limits. Every route that mails a typed address has a per-network
// cap already. These add a per-address cap (a script hopping networks can't
// flood one inbox) and an app-wide daily ceiling per kind of mail, so a flood
// can't burn the whole email quota. Sign-up codes and reset links have
// SEPARATE ceilings, so signup spam can't lock real users out of a reset.
const VERIFY_MAIL_DAILY = 150;      // signup + resend codes per rolling day
const RESET_MAIL_DAILY = 150;       // password reset links per rolling day
const MAIL_PER_ADDRESS = 3;         // codes per address per window
const MAIL_PER_ADDRESS_WINDOW_S = 900;
// True = send. Called only right before a real send to a real account. The
// caller answers as if nothing went out, which never reveals an account.
async function mayMail(env, kind, max) {
  if (await overLimit(env, `mail-day:${kind}`, max, 86400)) {
    console.log(JSON.stringify({ evt: 'mail_skipped', kind, reason: 'daily_ceiling' }));
    return false;
  }
  return true;
}

async function sendVerificationEmail(userId, email, env) {
  // Email a 6-digit CODE, not a magic link. A long tokenized verify-link to a
  // young domain reads as phishing to Gmail, which accepts then silently drops
  // it (Resend shows "delivered" but it never reaches the inbox). A code has no
  // clickable credential link, so it lands normally. Store only the hash.
  // Mail caps come FIRST. If no mail may go out, the code already in the
  // person's inbox is left alone (replacing it without sending a new one would
  // let a stranger kill someone's working code just by asking for more).
  if (env.RESEND_API_KEY) {
    if (await overLimit(env, `verify-email:${email}`, MAIL_PER_ADDRESS, MAIL_PER_ADDRESS_WINDOW_S)) {
      console.log(JSON.stringify({ evt: 'mail_skipped', kind: 'verify', reason: 'per_address_cap' }));
      return false;
    }
    if (!(await mayMail(env, 'verify', VERIFY_MAIL_DAILY))) return false;
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  // Scope the hash to the user so two users drawing the same 6-digit code don't
  // collide on the `token` PRIMARY KEY (which would throw on the second INSERT
  // and surface as a non-JSON 500 on signup).
  const codeHash = await sha256Hex(userId + ':' + code);
  const now = Math.floor(Date.now() / 1000);
  // One live code per user: clear any prior unused codes first.
  // Wrapped so a DB hiccup here can't bubble up as a 500 — the user still got
  // created; log and bail so the signup response stays clean.
  try {
    await env.DB.prepare('DELETE FROM email_verification_tokens WHERE user_id=? AND used=0').bind(userId).run();
    await env.DB.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(codeHash, userId, now + 1800, now).run(); // 30-minute window
  } catch (e) {
    console.error('sendVerificationEmail: token store failed', e && e.message || e);
    return false;
  }
  // Returns true only when Resend accepted the message, so callers can tell
  // the user when nothing went out instead of promising an inbox.
  if (!env.RESEND_API_KEY) {
    // Local testing only: DEV_LOG_CODES=true prints the code when no email key is set.
    if (env.DEV_LOG_CODES === 'true') { console.log('[dev] verify code for', email, code); return true; }
    console.error('sendVerificationEmail: RESEND_API_KEY not set'); return false;
  }
  // Awaited so the send completes before the request ends (un-awaited fetches
  // get cancelled when the Worker returns). Errors logged, not thrown.
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Side Hustle Garden <onboarding@resend.dev>',
        to: email,
        subject: `Your Side Hustle Garden code is ${code}`,
        text: `Your Side Hustle Garden verification code is: ${code}\n\nEnter it on the sign-in screen to finish setting up your account. It expires in 30 minutes.\n\nIf you didn't sign up for Side Hustle Garden, ignore this email.\n\n${emailFooterText()}`,
        html: emailLayout(EMAIL_THEME, {
          title: 'Your verification code',
          body: emailPara(EMAIL_THEME, 'Enter this code on the sign-in screen to finish setting up your Side Hustle Garden account:')
            + emailCode(EMAIL_THEME, code)
            + emailSmall(EMAIL_THEME, "This code expires in 30 minutes. If you didn't sign up for Side Hustle Garden, ignore this email."),
          footer: emailFooterHtml(EMAIL_THEME.muted, EMAIL_THEME.line),
        })
      })
    });
    if (!r.ok) { console.error('sendVerificationEmail: Resend FAIL', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('sendVerificationEmail threw', e && e.message || e); return false; }
}

// POST /api/auth/verify-code  body: { email, code, password } — finish email
// verification with the 6-digit code. Rate-limited (codes are low-entropy) and
// single-use. Returns a session token on success so the user is logged straight in.
async function verifyCode(request, env) {
  const body = await readJson(request);
  const cleanEmail = body && isEmail(body.email) ? body.email.trim().toLowerCase() : '';
  const cleanCode = String((body && body.code) || '').replace(/\D/g, '');
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!cleanEmail || cleanCode.length !== 6) return res({ error: 'Enter the 6-digit code from your email.' }, 400);
  if (!password || password.length > 200) return res({ error: 'Enter your password along with the code.' }, 400);
  const now = Math.floor(Date.now() / 1000);
  // Throttle guesses: 8/min per email + 30/min per network. Low-entropy codes need it.
  if (await overLimit(env, `verify-code:${cleanEmail}`, 8, 60)) return tooMany('Too many attempts. Please wait a minute and try again.', 60);
  if (await overLimit(env, `verify-code-ip:${ipKey(request)}`, 30, 60)) return tooMany('Too many requests. Try again later.', 60);

  const user = await env.DB.prepare('SELECT id, email, email_verified, password_hash, COALESCE(token_version, 0) AS tv FROM users WHERE email = ?').bind(cleanEmail).first();
  if (!user) return res({ error: 'That code is invalid or expired.' }, 400);
  // Already verified → DON'T issue a session (that would be a password-free
  // login bypass). Same 400 as an unknown address: a distinct 409 "already
  // verified" told anyone which emails have accounts.
  if (user.email_verified) return res({ error: 'That code is invalid or expired.' }, 400);
  // Wrong-code budget, only for a real unverified account, so junk requests
  // naming an address with no pending signup can't use it up. 20 misses a day
  // per account stops slow guessing from many networks. Each try is reserved
  // before the code is checked (so parallel guesses can't race past it) and a
  // right code hands its try back. Over budget answers the same generic 400.
  const dayKey = `verify-miss-day:${user.id}`;
  if (await overLimit(env, dayKey, 20, 86400)) return res({ error: 'That code is invalid or expired.' }, 400);
  // New hashes are scoped to the user (user.id + ':' + code) to avoid PK
  // collisions; legacyHash matches rows written before that change.
  const codeHash = await sha256Hex(user.id + ':' + cleanCode);
  const legacyHash = await sha256Hex(cleanCode);
  // Match SCOPED TO USER (user_id AND hash) so one user's code can never
  // verify another account. Single-use, unexpired.
  const row = await env.DB.prepare('SELECT token FROM email_verification_tokens WHERE user_id=? AND token IN (?,?) AND used=0 AND expires_at > ?')
    .bind(user.id, codeHash, legacyHash, now).first();
  if (!row) {
    try {
      // 5 misses burn the current code. The real owner just taps Resend code.
      if ((await hitCount(env, `verify-miss:${user.id}`, 1800)) >= 5) {
        await env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND used=0').bind(user.id).run();
      }
    } catch (e) { console.error('verify-miss count failed:', e && e.message || e); }
    return res({ error: 'That code is invalid or expired.' }, 400);
  }
  // The code proves the inbox, the password proves this is whoever set the
  // row's credentials (a signup on an unverified row replaces them). Without
  // both, someone who re-signed-up on the owner's address could ride the
  // owner's code into an account whose password they chose.
  await dropNewest(env, dayKey); // right code: not a miss
  if (!user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return res({ error: "That password doesn't match this account. If you didn't set it, use Forgot password." }, 400);
  }
  // Verify + consume in one atomic batch, conditional on the exact state just
  // checked. A signup that swapped the password, a token_version bump, or a
  // parallel request that already used this code between the reads above and
  // here makes a statement change 0 rows, and then no session is minted
  // The user UPDATE also requires the
  // code to still be unused, so it can't succeed without the consume.
  const nowIso = new Date().toISOString();
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(`UPDATE users SET email_verified=1, verified_at=?, last_sign_in_at=?
        WHERE id=? AND email_verified=0 AND password_hash=? AND COALESCE(token_version, 0)=?
        AND EXISTS (SELECT 1 FROM email_verification_tokens WHERE user_id=? AND token=? AND used=0)`)
        .bind(nowIso, nowIso, user.id, user.password_hash, user.tv, user.id, row.token),
      env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND token=? AND used=0').bind(user.id, row.token),
      env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=?').bind(user.id),
    ]);
  } catch (e) {
    console.error('verify-code batch failed:', e && e.message || e);
    return res({ error: 'That code is invalid or expired.' }, 400);
  }
  const changed = (r) => (r && r.meta && r.meta.changes) || 0;
  if (!changed(results[0]) || !changed(results[1])) {
    return res({ error: 'That code is invalid or expired.' }, 400);
  }
  // Issue a session EXACTLY like login does, from the row state just matched.
  const token = await signSessionJWT({ sub: user.id, email: user.email, tv: user.tv }, env.GARDEN_SESSION_SECRET);
  const hubProToken = await hubProLookup(user.email, env);
  return resWithSession({ ...(hubProToken ? { hub_pro_token: hubProToken } : {}), user: { id: user.id, email: user.email } }, token);
}

// Legacy GET /api/auth/verify-email?token=... from old emailed links. Signup
// uses 6-digit codes now, so this never touches the database. It only points
// people to the code step.
async function verifyEmail(url, env) {
  const appUrl = escapeAttr(APP_BASE || '/');
  return new Response(`<!DOCTYPE html><html><head><title>Link expired</title><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{font-family:-apple-system,sans-serif;background:#1A0F1E;color:#FFF4E8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}a{color:#FFD24A}h1{color:#FFD24A}</style></head><body><div><h1>This link has expired</h1><p>Sign in with your email and password. We'll email you a 6-digit code to finish setting up.</p><p><a href="${appUrl}">Go to Side Hustle Garden</a></p></div></body></html>`, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" } });
}

async function resendVerification(request, env) {
  const body = await readJson(request);
  if (!body || !isEmail(body.email)) return res({ ok: true });
  const emailLower = body.email.trim().toLowerCase();
  // 1 per address per minute, 10 per network per minute.
  if (await overLimit(env, `verify-resend:${emailLower}`, 1, 60)) return tooMany('Please wait a minute before requesting another email.', 60);
  if (await overLimit(env, `verify-resend-ip:${ipKey(request)}`, 10, 60)) return tooMany('Too many requests. Try again later.', 60);
  const user = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(emailLower).first();
  // An unknown or already-verified email still reads as sent (no enumeration);
  // only a real send that Resend refused reports email_sent:false.
  let emailSent = true;
  if (user && !user.email_verified) {
    emailSent = await sendVerificationEmail(user.id, emailLower, env);
  }
  return res({ ok: true, email_sent: emailSent, message: 'If that account exists and needs verification, an email has been sent.' });
}

async function resetRequest(request, env) {
  const body = await readJson(request);
  if (!body || !isEmail(body.email)) return res({ ok: true });
  const email = body.email.trim().toLowerCase();
  // Reset mail is the one email anybody can aim at any address. 3 per address
  // per 15 minutes and 10 per IP per hour stops inbox-bombing a victim and
  // burning the Resend quota; the answer stays the same shape (no enumeration).
  const ip = ipKey(request);
  if (await overLimit(env, `reset-email:${email}`, 3, 900)) return tooMany('A reset email was sent recently. Check your inbox, then try again in 15 minutes.', 900);
  if (await overLimit(env, `reset-ip:${ip}`, 10, 3600)) return tooMany('Too many reset requests from this connection. Try again later.', 3600);
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!row) return res({ ok: true });

  const rawToken = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(rawToken);
  const expires = new Date(Date.now() + 3600000).toISOString();
  await env.DB.prepare('INSERT OR REPLACE INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)')
    .bind(tokenHash, row.id, expires).run();

  if (!env.RESEND_API_KEY && env.DEV_LOG_CODES === 'true') console.log('[dev] reset link:', `${APP_BASE}/reset/${rawToken}`);
  if (env.RESEND_API_KEY && await mayMail(env, 'reset', RESET_MAIL_DAILY)) {
    const appUrl = APP_BASE;
    // Path form, NOT ?reset=<token>. Delivered mail mangled the '=' plus the
    // next two hex chars as a quoted-printable escape, so the link arrived as
    // '?reset,<token>' / '?reset\uFFFD<token>' and the reset screen never opened.
    // A path segment has nothing for QP to eat. The frontend still accepts the
    // old query form so links already sent keep working.
    const resetUrl = `${appUrl}/reset/${rawToken}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Side Hustle Garden <onboarding@resend.dev>',
        to: email,
        subject: 'Reset your Side Hustle Garden password',
        text: `Reset your Side Hustle Garden password\n\nOpen this link to set a new password. It expires in 1 hour.\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n${emailFooterText()}`,
        html: emailLayout(EMAIL_THEME, {
          title: 'Reset your password',
          body: emailPara(EMAIL_THEME, 'Tap below to set a new password for your Side Hustle Garden. This link expires in 1 hour.')
            + emailButton(EMAIL_THEME, resetUrl, 'Reset password')
            + emailSmall(EMAIL_THEME, "If you didn't request this, ignore this email."),
          footer: emailFooterHtml(EMAIL_THEME.muted, EMAIL_THEME.line),
        })
      })
    }).catch(() => {});
  }
  return res({ ok: true });
}

async function resetConfirm(request, env) {
  const body = await readJson(request);
  if (!body || typeof body.token !== 'string' || body.token.length < 16 || body.token.length > 256
      || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 200) {
    return badReq('Password must be 10 to 200 characters.');
  }
  const tokenHash = await sha256Hex(body.token);
  const rt = await env.DB.prepare('SELECT user_id, expires_at FROM reset_tokens WHERE token=? AND used=0')
    .bind(tokenHash).first();
  if (!rt || new Date(rt.expires_at) < new Date()) {
    return res({ error: 'Invalid or expired reset link' }, 400);
  }
  const hash = await hashPassword(body.password);
  // Claim the link in one statement: two requests racing with the same link
  // can't both get through. Then every other reset link for this user dies too.
  const claim = await env.DB.prepare('UPDATE reset_tokens SET used=1 WHERE token=? AND used=0').bind(tokenHash).run();
  if (!claim || !claim.meta || !claim.meta.changes) return res({ error: 'Invalid or expired reset link' }, 400);
  await env.DB.batch([
    // Opening the emailed link proved the inbox, so the account is verified too.
    env.DB.prepare('UPDATE users SET password_hash=?, email_verified=1, verified_at=COALESCE(verified_at, ?) WHERE id=?').bind(hash, new Date().toISOString(), rt.user_id),
    env.DB.prepare('UPDATE reset_tokens SET used=1 WHERE user_id=?').bind(rt.user_id),
  ]);
  // Sign out every other session: a stolen token dies with the old password.
  await bumpTokenVersion(env, rt.user_id);
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id=?').bind(rt.user_id).first();
  // The owner proved the inbox, so earlier wrong-password counts are cleared.
  try {
    const lockPrefix = 'failed-login:' + String(user.email).toLowerCase() + '|';
    await env.DB.prepare('DELETE FROM rate_limits WHERE substr(key, 1, ?) = ? OR key = ?')
      .bind(lockPrefix.length, lockPrefix, 'failed-login-all:' + String(user.email).toLowerCase()).run();
  } catch (e) { console.error('lock clear after reset failed:', e && e.message || e); }
  await logAuth('password_reset', request, { uid: user.id });
  const token = await signSessionJWT({ sub: user.id, email: user.email, tv: await currentTv(env, user.id) }, env.GARDEN_SESSION_SECRET);
  const hubProToken = await hubProLookup(user.email, env);
  return resWithSession({ ok: true, ...(hubProToken ? { hub_pro_token: hubProToken } : {}), user: { id: user.id, email: user.email } }, token);
}

// POST /api/pro-refresh  body: { token } — relay a hub Pro JWT to the hub's
// refresh endpoint and pass the hub's answer through verbatim. Validates the
// token SHAPE only (string, ≤2048); the hub decides whether it's renewable.
async function proRefresh(request, env) {
  if (await overLimit(env, `pro-refresh-ip:${ipKey(request)}`, 30, 60)) return tooMany('Too many requests. Try again in a minute.', 60);
  const body = await readJson(request);
  const token = body ? body.token : null;
  // Optional: PRO_REFRESH_URL is the hub's token refresh endpoint. Unset = off.
  if (!env.PRO_REFRESH_URL) return markNoAlert(res({ valid: false, error: 'Pro refresh is off on this server.' }, 404));
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    return res({ valid: false }, 400);
  }
  try {
    const r = await fetch(env.PRO_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    let d = null;
    try { d = await r.json(); } catch {}
    return res(d !== null ? d : { valid: false }, r.status);
  } catch {
    // Hub unreachable — 502 so the client knows to keep its current token.
    return res({ valid: false, error: 'Hub unreachable' }, 502);
  }
}

// Feedback relay: set FEEDBACK_WEBHOOK_URL to turn it on. Unset = off.
async function feedback(request, env) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badReq('Invalid request body.');
  // Honeypot: a hidden field people never see. Bots fill it; answer as if sent.
  if (body.website) return res({ ok: true });
  if (!env.FEEDBACK_WEBHOOK_URL) return markNoAlert(res({ error: "Feedback isn't set up on this server." }, 503));
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const message = str(body.message, 2000);
  if (message.length < 3) return badReq('Please write a bit more so the message is clear.');
  const email = str(body.email, 200);
  if (email && !isEmail(email)) return badReq("That email doesn't look right. Fix it or leave it blank.");
  const type = ['bug', 'feature', 'other'].includes(body.type) ? body.type : 'other';
  const r = await fetch(env.FEEDBACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: env.APP_NAME || 'Side Hustle Garden',
      type,
      message,
      email,
      url: str(body.url, 500),
      user_agent: (request.headers.get('User-Agent') || '').slice(0, 500),
    }),
  }).catch(() => null);
  // markNoAlert keeps a webhook outage out of the error beacon.
  if (!r || !r.ok) return markNoAlert(res({ error: 'Could not send. Try again in a minute.' }, 502));
  return res({ ok: true });
}

async function purgeExpired(env) {
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;
  const out = await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE created_at < ?').bind(now - 86400),
    env.DB.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').bind(new Date(weekAgo * 1000).toISOString()),
    env.DB.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ?').bind(weekAgo),
    env.DB.prepare('DELETE FROM revoked_sessions WHERE revoked_at < ?').bind(new Date((now - 31 * 86400) * 1000).toISOString()),
  ]);
  console.log(JSON.stringify({ evt: 'purge', deleted: out.map(r => (r.meta && r.meta.changes) || 0) }));
}

// Optional signup notification to the operator. Set SIGNUP_WEBHOOK_URL and
// SIGNUP_WEBHOOK_SECRET to get a POST on each signup (the secret rides in the
// X-Signup-Secret header).
async function notifySignup(env, appName, email, appNewsletterConsent) {
  if (!env.SIGNUP_WEBHOOK_URL || !env.SIGNUP_WEBHOOK_SECRET) return;
  await fetch(env.SIGNUP_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signup-Secret': env.SIGNUP_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      email,
      app_name: appName,
      app_newsletter_consent: !!appNewsletterConsent,
      ss_newsletter_consent: false,
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {});
}

// ---- bills ----

// The six plant types the Bills form offers. Anything else is rejected so a
// stored type can never be a 50-char blob or a prototype key.
const BILL_TYPES = new Set(['housing', 'debt', 'utility', 'subscription', 'insurance', 'other']);

async function listBills(user, env) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, amount, type, is_final, repeats, archived, start_month, end_month, created_at FROM bills WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(user.id).all();
  return res(results || []);
}

async function createBill(user, request, env) {
  const b = await readJson(request);
  if (!b || !isStr(b.name, 200) || !isPosNum(b.amount)) return badReq();
  if (b.type != null && !BILL_TYPES.has(b.type)) return badReq('Bill type must be one of: ' + [...BILL_TYPES].join(', '));
  const type = BILL_TYPES.has(b.type) ? b.type : null;
  const is_final = b.is_final ? 1 : 0;
  const repeats = b.repeats ? 1 : 0;
  const start_month = isMonth(b.start_month) ? b.start_month : null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO bills (id, user_id, name, amount, type, is_final, repeats, archived, start_month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ).bind(id, user.id, b.name, b.amount, type, is_final, repeats, start_month, now).run();
  return res({ id, name: b.name, amount: b.amount, type, is_final, repeats, archived: 0, start_month, created_at: now });
}

async function updateBill(user, id, request, env) {
  if (!isUuid(id)) return badReq();
  const b = await readJson(request);
  if (!b) return badReq();
  // Build dynamic update only for whitelisted fields
  const sets = [];
  const binds = [];
  if (isStr(b.name, 200)) { sets.push('name = ?'); binds.push(b.name); }
  if (isPosNum(b.amount)) { sets.push('amount = ?'); binds.push(b.amount); }
  if ('type' in b) {
    if (b.type !== null && !BILL_TYPES.has(b.type)) return badReq('Bill type must be one of: ' + [...BILL_TYPES].join(', '));
    sets.push('type = ?'); binds.push(b.type);
  }
  if (isBool(b.is_final)) { sets.push('is_final = ?'); binds.push(b.is_final ? 1 : 0); }
  if (isBool(b.repeats)) { sets.push('repeats = ?'); binds.push(b.repeats ? 1 : 0); }
  if (sets.length === 0) return badReq('No updatable fields');
  binds.push(id, user.id);
  const r = await env.DB.prepare(
    `UPDATE bills SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();
  if (!r.success || r.meta.changes === 0) return notFound();
  return res({ ok: true });
}

async function deleteBill(user, id, env) {
  if (!isUuid(id)) return badReq();
  // Manual cascade: monthly_amounts is FK to bills, also FK to users — both go away
  await env.DB.prepare('DELETE FROM monthly_amounts WHERE bill_id = ? AND user_id = ?').bind(id, user.id).run();
  const r = await env.DB.prepare('DELETE FROM bills WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (r.meta.changes === 0) return notFound();
  return res({ ok: true });
}

async function archiveBill(user, id, request, env) {
  if (!isUuid(id)) return badReq();
  const b = await readJson(request);
  if (!b || !isBool(b.archived)) return badReq();
  // end_month: the month the bill stopped being paid. Only kept while
  // archived; restoring a bill clears it.
  if (b.end_month != null && !isMonth(b.end_month)) return badReq();
  const end_month = b.archived && isMonth(b.end_month) ? b.end_month : null;
  const r = await env.DB.prepare(
    'UPDATE bills SET archived = ?, end_month = ? WHERE id = ? AND user_id = ?'
  ).bind(b.archived ? 1 : 0, end_month, id, user.id).run();
  if (r.meta.changes === 0) return notFound();
  return res({ ok: true });
}

// ---- payments ----

async function listPayments(user, url, env) {
  const month = url.searchParams.get('month');
  let sql = 'SELECT id, source, amount, month, targets, pay_date, created_at FROM payments WHERE user_id = ?';
  const binds = [user.id];
  if (month && isMonth(month)) { sql += ' AND month = ?'; binds.push(month); }
  sql += ' ORDER BY created_at ASC';
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  // Parse targets JSON; a row with a malformed blob reads as no targets
  // instead of turning the whole list into a 500.
  const rows = (results || []).map(r => {
    let targets = [];
    if (r.targets) { try { targets = JSON.parse(r.targets); } catch { targets = []; } }
    return { ...r, targets: Array.isArray(targets) ? targets : [] };
  });
  return res(rows);
}

// Targets are written by the client as { billId, billName, applied } (camelCase).
// Normalize + validate to that canonical shape; tolerate legacy { bill_id, amount }.
// Reading code (coveragePct/billPaid) keys off billId + applied, so storing any
// other shape silently zeroes a payment's bill allocation.
function normalizeTargets(arr) {
  return (arr || []).map(t => {
    if (!t || typeof t !== 'object') return null;
    const billId = t.billId || t.bill_id;
    const applied = t.applied != null ? t.applied : t.amount;
    if (!isUuid(billId) || !isPosNum(applied)) return null;
    return { billId, billName: isStr(t.billName, 200) ? t.billName : '', applied };
  }).filter(Boolean);
}

async function createPayment(user, request, env) {
  const p = await readJson(request);
  if (!p || !isStr(p.source, 200) || !isPosNum(p.amount) || !isMonth(p.month) || !isDate(p.pay_date)) return badReq();
  if (p.targets && !Array.isArray(p.targets)) return badReq();
  const targets = normalizeTargets(p.targets);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO payments (id, user_id, source, amount, month, targets, pay_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, p.source, p.amount, p.month, JSON.stringify(targets), p.pay_date, now).run();
  return res({ id, source: p.source, amount: p.amount, month: p.month, targets, pay_date: p.pay_date, created_at: now });
}

async function updatePayment(user, id, request, env) {
  if (!isUuid(id)) return badReq();
  const p = await readJson(request);
  if (!p) return badReq();
  const sets = []; const binds = [];
  if (isStr(p.source, 200)) { sets.push('source = ?'); binds.push(p.source); }
  if (isPosNum(p.amount)) { sets.push('amount = ?'); binds.push(p.amount); }
  if (isDate(p.pay_date)) { sets.push('pay_date = ?'); binds.push(p.pay_date); }
  if (Array.isArray(p.targets)) {
    sets.push('targets = ?'); binds.push(JSON.stringify(normalizeTargets(p.targets)));
  }
  if (sets.length === 0) return badReq('No updatable fields');
  binds.push(id, user.id);
  const r = await env.DB.prepare(
    `UPDATE payments SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();
  if (r.meta.changes === 0) return notFound();
  return res({ ok: true });
}

async function deletePayment(user, id, env) {
  if (!isUuid(id)) return badReq();
  const r = await env.DB.prepare('DELETE FROM payments WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (r.meta.changes === 0) return notFound();
  return res({ ok: true });
}

// ---- monthly amounts ----

async function listMonthly(user, url, env) {
  const month = url.searchParams.get('month');
  let sql = 'SELECT id, bill_id, month, amount FROM monthly_amounts WHERE user_id = ?';
  const binds = [user.id];
  if (month && isMonth(month)) { sql += ' AND month = ?'; binds.push(month); }
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return res(results || []);
}

async function upsertMonthly(user, request, env) {
  const m = await readJson(request);
  if (!m || !isUuid(m.bill_id) || !isMonth(m.month) || !isPosNum(m.amount)) return badReq();
  // Confirm bill belongs to user (prevent cross-user writes via bill_id)
  const own = await env.DB.prepare('SELECT 1 FROM bills WHERE id = ? AND user_id = ?')
    .bind(m.bill_id, user.id).first();
  if (!own) return notFound();
  // UNIQUE(bill_id, month) lets us use ON CONFLICT
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO monthly_amounts (id, user_id, bill_id, month, amount) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bill_id, month) DO UPDATE SET amount = excluded.amount`
  ).bind(id, user.id, m.bill_id, m.month, m.amount).run();
  return res({ ok: true });
}

// ---- settings ----

async function getSettings(user, env) {
  const row = await env.DB.prepare('SELECT monthly_goal, updated_at FROM user_settings WHERE user_id = ?')
    .bind(user.id).first();
  return res(row || { monthly_goal: 0, updated_at: null });
}

async function updateSettings(user, request, env) {
  const s = await readJson(request);
  // monthly_goal is a dollar amount and may be fractional (the goal modal uses
  // parseFloat) — accept any finite non-negative number, not just integers.
  if (!s || typeof s.monthly_goal !== 'number' || !Number.isFinite(s.monthly_goal) || s.monthly_goal < 0 || s.monthly_goal > 1_000_000_000) return badReq();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, monthly_goal, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET monthly_goal = excluded.monthly_goal, updated_at = excluded.updated_at`
  ).bind(user.id, s.monthly_goal, now).run();
  return res({ ok: true });
}

// ---- GDPR data export ----
// Returns all user-owned data as JSON. Sent with attachment headers so the
// browser downloads it as garden-export-<YYYY-MM-DD>.json.
async function exportAccount(user, env) {
  const u = await env.DB.prepare(
    'SELECT id, email, created_at, last_sign_in_at, user_metadata FROM users WHERE id = ?'
  ).bind(user.id).first();
  if (!u) return notFound();
  const bills = await env.DB.prepare(
    'SELECT id, name, amount, type, is_final, repeats, archived, start_month, end_month, created_at FROM bills WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(user.id).all();
  const payments = await env.DB.prepare(
    'SELECT id, source, amount, month, targets, pay_date, created_at FROM payments WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(user.id).all();
  const monthlyAmounts = await env.DB.prepare(
    'SELECT id, bill_id, month, amount FROM monthly_amounts WHERE user_id = ? ORDER BY month ASC'
  ).bind(user.id).all();
  const settings = await env.DB.prepare(
    'SELECT monthly_goal, updated_at FROM user_settings WHERE user_id = ?'
  ).bind(user.id).first();

  // Parse user_metadata JSON for readability.
  let userMeta = null;
  if (u.user_metadata) { try { userMeta = JSON.parse(u.user_metadata); } catch {} }

  const payload = {
    exported_at: new Date().toISOString(),
    schema_version: 1,
    user: {
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      user_metadata: userMeta,
    },
    bills: bills.results || [],
    payments: (payments.results || []).map(p => ({
      ...p,
      targets: p.targets ? (() => { try { return JSON.parse(p.targets); } catch { return p.targets; } })() : [],
    })),
    monthly_amounts: monthlyAmounts.results || [],
    settings: settings || null,
  };
  const date = new Date().toISOString().slice(0, 10);
  return res(payload, 200, {
    'Content-Disposition': `attachment; filename="garden-export-${date}.json"`,
  });
}

// ============================================================================
// INTERNAL SERVICE — Recap stats
// ============================================================================
// Called by a connected Pro hub's recap job with the shared RECAP_SERVICE_SECRET.
// The hub decides who is Pro; this endpoint only reports a user's month.
// Fail-closed: 401 whenever the secret is unset or the header mismatches.

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Previous calendar month key: '2026-07' -> '2026-06'.
function prevMonthKey(ymKey) {
  const [y, m] = ymKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

async function serviceRecap(url, request, env) {
  const provided = request.headers.get('X-Internal-Secret') || '';
  if (!env.RECAP_SERVICE_SECRET || !timingSafeEqualStr(provided, env.RECAP_SERVICE_SECRET)) {
    return unauth();
  }
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';
  if (!isEmail(email) || !isDate(start) || !isDate(end)) {
    return badReq('email, start, end required');
  }
  const userRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!userRow) return res({ found: false });
  const uid = userRow.id;
  const month = start.slice(0, 7); // the window is always one calendar month

  // Earned + watering count for the month.
  const pay = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS earned, COUNT(*) AS n FROM payments WHERE user_id = ? AND month = ?'
  ).bind(uid, month).first();
  const earned = Math.round((Number(pay?.earned) || 0) * 100) / 100;
  const wateredCount = Number(pay?.n) || 0;

  // Coverage math mirrors public/app.js (coveragePct / billActiveInMonth /
  // billAmt / billPaid): a bill counts in a month when it had started
  // (start_month NULL or <= that month) and had not stopped (not archived, or
  // archived with an end_month after that month); its target is the
  // monthly_amounts override for that month when present, else bills.amount;
  // paid = the sum of payments.targets[].applied pointing at that bill in that
  // month. Money on a bill that doesn't count that month counts on neither side.
  const billsRows = await env.DB.prepare(
    'SELECT id, amount, archived, start_month, end_month FROM bills WHERE user_id = ?'
  ).bind(uid).all();
  const bills = billsRows.results || [];
  const ovRows = await env.DB.prepare(
    'SELECT bill_id, month, amount FROM monthly_amounts WHERE user_id = ?'
  ).bind(uid).all();
  // Null-prototype maps: a stored bill id or target billId that spells
  // "__proto__" or "constructor" must never resolve to Object.prototype.
  const overrides = Object.create(null);
  for (const o of (ovRows.results || [])) overrides[`${o.bill_id}|${o.month}`] = Number(o.amount) || 0;
  const billTarget = (b, m) => {
    const ov = overrides[`${b.id}|${m}`];
    return ov !== undefined ? ov : (Number(b.amount) || 0);
  };
  const billActiveIn = (b, m) => (!b.start_month || b.start_month <= m)
    && (!b.archived || (!!b.end_month && m < b.end_month));
  const activeIn = (m) => bills.filter(b => billActiveIn(b, m));
  const billById = Object.create(null);
  for (const b of bills) billById[b.id] = b;

  // Applied totals: per bill for the recap month, per month for the streak
  // (bounded window; streak result is capped to it).
  const STREAK_WINDOW = 24;
  let lower = month;
  for (let i = 1; i < STREAK_WINDOW; i++) lower = prevMonthKey(lower);
  const tRows = await env.DB.prepare(
    'SELECT month, targets FROM payments WHERE user_id = ? AND month BETWEEN ? AND ?'
  ).bind(uid, lower, month).all();
  const appliedByMonth = Object.create(null);
  const appliedByBill = Object.create(null);
  for (const r of (tRows.results || [])) {
    let targets;
    try { targets = JSON.parse(r.targets || '[]'); } catch { targets = []; }
    if (!Array.isArray(targets)) targets = [];
    for (const t of targets) {
      const a = Number(t?.applied) || 0;
      const tb = t?.billId ? billById[t.billId] : undefined;
      if (!tb || !billActiveIn(tb, r.month)) continue;
      appliedByMonth[r.month] = (appliedByMonth[r.month] || 0) + a;
      if (r.month === month && t?.billId) {
        appliedByBill[t.billId] = (appliedByBill[t.billId] || 0) + a;
      }
    }
  }

  // Recap month: bloomed = active bills fully paid (same >= test as the app's
  // withered check), coverage = applied / targets, capped at 100.
  const active = activeIn(month);
  let totB = 0;
  let bloomed = 0;
  for (const b of active) {
    const target = billTarget(b, month);
    totB += target;
    // A $0 month (bill not due, e.g. every other month) is not a bloom.
    if (target > 0 && (appliedByBill[b.id] || 0) >= target) bloomed++;
  }
  const totP = appliedByMonth[month] || 0;
  const coveragePct = totB > 0 ? Math.min(100, Math.round((totP / totB) * 100)) : 0;

  // Consecutive fully-covered months ending at the recap month. A month with
  // no bills (or zero targets) ends the streak rather than counting free.
  const coveredIn = (m) => {
    const act = activeIn(m);
    if (!act.length) return false;
    const t = act.reduce((s, b) => s + billTarget(b, m), 0);
    if (t <= 0) return false;
    return (appliedByMonth[m] || 0) >= t;
  };
  let monthStreak = 0;
  for (let m = month, i = 0; i < STREAK_WINDOW && coveredIn(m); i++, m = prevMonthKey(m)) {
    monthStreak++;
  }

  const settings = await env.DB.prepare(
    'SELECT monthly_goal FROM user_settings WHERE user_id = ?'
  ).bind(uid).first();
  const goal = settings && Number(settings.monthly_goal) > 0 ? Number(settings.monthly_goal) : null;
  const goalPct = goal ? Math.round((earned / goal) * 100) : null;

  return res({
    found: true,
    stats: {
      earned,
      watered_count: wateredCount,
      bloomed,
      // Bills due this month; a $0 (not-due) month is left out, matching the app's "X of Y bloomed".
      total_bills: active.filter((b) => billTarget(b, month) > 0).length,
      coverage_pct: coveragePct,
      goal,
      goal_pct: goalPct,
      month_streak: monthStreak,
      // Never send an empty recap: skip months with no waterings at all.
      skip: earned === 0,
    },
  });
}

// ============================================================================
// PRO FEATURE — 6-Month Cash Flow Forecast
// ============================================================================
// Pro subscribers get a 6-month projection of income vs bills based on the
// trailing 3-month average. Pure read + math, no schema changes, no third-party
// calls. Returns:
//   { generated_at, months: [{ month, projected_income, projected_bills, surplus, cumulative_surplus, ... }] }
async function forecast(user, env) {
  const today = new Date();
  const todayYM = today.toISOString().slice(0, 7);

  // Trailing 3 months for the avg-income basis (exclude current month — it's incomplete).
  const trailingMonths = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    trailingMonths.push(d.toISOString().slice(0, 7));
  }
  const placeholders = trailingMonths.map(() => '?').join(',');

  // 1. Trailing 3-month income (sum of payments per month)
  const incomeRows = await env.DB.prepare(
    `SELECT month, SUM(amount) AS total FROM payments WHERE user_id = ? AND month IN (${placeholders}) GROUP BY month`
  ).bind(user.id, ...trailingMonths).all();
  const incomeByMonth = Object.create(null);
  for (const r of (incomeRows.results || [])) incomeByMonth[r.month] = Number(r.total) || 0;
  const validMonths = trailingMonths.filter(m => incomeByMonth[m] !== undefined);
  const avgMonthlyIncome = validMonths.length > 0
    ? trailingMonths.reduce((s, m) => s + (incomeByMonth[m] || 0), 0) / validMonths.length
    : 0;

  // 2. Active (non-archived) bills + their default monthly amounts
  const billsRows = await env.DB.prepare(
    'SELECT id, name, amount, type, is_final, repeats, start_month FROM bills WHERE user_id = ? AND archived = 0'
  ).bind(user.id).all();
  const bills = billsRows.results || [];

  // 3. Per-month overrides
  const monthlyAmtRows = await env.DB.prepare(
    'SELECT bill_id, month, amount FROM monthly_amounts WHERE user_id = ?'
  ).bind(user.id).all();
  const overrides = Object.create(null);
  for (const m of (monthlyAmtRows.results || [])) {
    overrides[`${m.bill_id}|${m.month}`] = Number(m.amount) || 0;
  }

  // 4. Project the next 6 months (this month + 5 forward)
  const months = [];
  let cumulative = 0;
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const ym = d.toISOString().slice(0, 7);

    // Bills due this month: include all unless start_month is in the future
    let projectedBills = 0;
    let billCount = 0;
    for (const b of bills) {
      if (b.start_month && b.start_month > ym) continue;
      const amt = overrides[`${b.id}|${ym}`] !== undefined
        ? overrides[`${b.id}|${ym}`]
        : Number(b.amount) || 0;
      projectedBills += amt;
      billCount++;
    }

    // Income: actual if available, else avg
    const projectedIncome = incomeByMonth[ym] !== undefined
      ? incomeByMonth[ym]
      : avgMonthlyIncome;

    const surplus = projectedIncome - projectedBills;
    cumulative += surplus;

    months.push({
      month: ym,
      label: d.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      projected_income: Math.round(projectedIncome * 100) / 100,
      projected_bills: Math.round(projectedBills * 100) / 100,
      surplus: Math.round(surplus * 100) / 100,
      cumulative_surplus: Math.round(cumulative * 100) / 100,
      bill_count: billCount,
      income_is_projection: incomeByMonth[ym] === undefined,
    });
  }

  // Headline metrics
  const monthsOfRunway = avgMonthlyIncome > 0 && months[0]
    ? (months[0].projected_bills > 0
        ? Math.round((cumulative > 0 ? Infinity : avgMonthlyIncome / months[0].projected_bills) * 10) / 10
        : Infinity)
    : 0;

  return res({
    generated_at: new Date().toISOString(),
    avg_monthly_income: Math.round(avgMonthlyIncome * 100) / 100,
    months_of_data: validMonths.length,
    months,
  });
}

// ============================================================================
// PRO FEATURE — CSV Export
// ============================================================================
// Single-file CSV with three sections (bills, payments, monthly_amounts).
// Useful for tax season + record-keeping outside the app.
async function exportCsv(user, env) {
  const bills = await env.DB.prepare(
    'SELECT id, name, amount, type, is_final, repeats, archived, start_month, end_month, created_at FROM bills WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(user.id).all();
  const payments = await env.DB.prepare(
    'SELECT id, source, amount, month, targets, pay_date, created_at FROM payments WHERE user_id = ? ORDER BY pay_date ASC'
  ).bind(user.id).all();
  const monthly = await env.DB.prepare(
    'SELECT bill_id, month, amount FROM monthly_amounts WHERE user_id = ? ORDER BY month ASC'
  ).bind(user.id).all();

  // Escape per RFC 4180 — wrap in quotes if any control char; double inner quotes.
  const esc = v => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Text that starts like a formula would run when the file opens in a
    // spreadsheet. Numbers are left alone.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };

  let csv = '';
  csv += '# Side Hustle Garden CSV export\r\n';
  csv += `# Exported: ${new Date().toISOString()}\r\n`;
  csv += `# Account: ${esc(user.email || '')}\r\n`;
  csv += '\r\n';

  csv += '## Bills\r\n';
  csv += 'id,name,amount,type,is_final,repeats,archived,start_month,end_month,created_at\r\n';
  for (const b of (bills.results || [])) {
    csv += [b.id, esc(b.name), b.amount, esc(b.type || ''), b.is_final ? 1 : 0, b.repeats ? 1 : 0, b.archived ? 1 : 0, esc(b.start_month || ''), esc(b.end_month || ''), esc(b.created_at || '')].join(',') + '\r\n';
  }
  csv += '\r\n';

  csv += '## Payments\r\n';
  csv += 'id,source,amount,month,targets,pay_date,created_at\r\n';
  for (const p of (payments.results || [])) {
    csv += [p.id, esc(p.source || ''), p.amount, esc(p.month || ''), esc(p.targets || ''), esc(p.pay_date || ''), esc(p.created_at || '')].join(',') + '\r\n';
  }
  csv += '\r\n';

  csv += '## Monthly amounts (per-bill, per-month overrides)\r\n';
  csv += 'bill_id,month,amount\r\n';
  for (const m of (monthly.results || [])) {
    csv += [m.bill_id, esc(m.month || ''), m.amount].join(',') + '\r\n';
  }

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="garden-${date}.csv"`,
      ...securityHeaders(),
    },
  });
}

// ---- account delete with re-authentication ----
// Two proofs are accepted, either one is enough:
//   - hub_pro_jwt in the body, re-verified live against the Pro hub
//     /api/pro-verify and matching this account's email (the same proof
//     hub-sso accepts to log in, so it is as strong as a password here);
//   - current_password, for any account that has one.
// An account with no password (created or auto-verified through the hub) can
// only use the hub proof. An older version picked the path by the row's
// origin marker, so a hub-origin user who later set a password through
// "Forgot password" was still refused the password path.
async function deleteAccount(user, request, env) {
  const body = await readJson(request) || {};

  const row = await env.DB.prepare(
    'SELECT id, email, password_hash FROM users WHERE id = ?'
  ).bind(user.id).first();
  if (!row) return notFound();

  if (!row.password_hash) {
    // No password on the account (it signs in through the hub): the hub proof
    // is the only re-check there is. An account WITH a password must give it,
    // so a stolen session plus a stored hub token can't delete the account.
    if (!isStr(body.hub_pro_jwt, 2048)) {
      return res({ error: 'This account signs in through a Pro hub. Open the app from the hub again, then try again.' }, 400);
    }
    const hub = await verifyHubToken(body.hub_pro_jwt);
    if (!hub || String(hub.email || '').toLowerCase() !== String(row.email).toLowerCase()) {
      return res({ error: 'Re-verification failed' }, 401);
    }
  } else {
    if (typeof body.current_password !== 'string'
        || body.current_password.length < 1 || body.current_password.length > 200) {
      return res({ error: 'Current password is required to delete this account.' }, 400);
    }
    // Shares the login lockout, so a stolen session can't be used to guess the password.
    const delEmail = String(row.email).toLowerCase();
    const delKey = lockKeyFor(delEmail, request);
    if (await overLimit(env, delKey, LOGIN_LOCKOUT_MAX, LOGIN_LOCKOUT_WINDOW_S)
        || await overLimit(env, `failed-login-all:${delEmail}`, LOGIN_ALL_MAX, LOGIN_LOCKOUT_WINDOW_S)) return lockedOut();
    const ok = await verifyPassword(body.current_password, row.password_hash);
    if (!ok) {
      return res({ error: 'Current password is incorrect' }, 401);
    }
    await dropNewest(env, delKey);
    await dropNewest(env, `failed-login-all:${delEmail}`);
  }

  // FK ON DELETE CASCADE handles bills/payments/monthly/settings.
  // revoked_sessions has no FK — clean up explicitly to keep the
  // table tidy and prevent orphan rows.
  await env.DB.prepare('DELETE FROM revoked_sessions WHERE user_id = ?').bind(user.id).run();
  const lockPrefix = 'failed-login:' + String(row.email).toLowerCase() + '|';
  await env.DB.prepare('DELETE FROM rate_limits WHERE substr(key, 1, ?) = ? OR key = ?')
    .bind(lockPrefix.length, lockPrefix, 'failed-login-all:' + String(row.email).toLowerCase()).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  await logAuth('account_delete', request, { uid: user.id });
  const out = res({ ok: true });
  out.headers.append('Set-Cookie', clearSessionCookie());
  return out;
}
