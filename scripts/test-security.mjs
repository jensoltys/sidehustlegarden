// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Security regression scanner — Side Hustle Garden.
// Run: node scripts/test-security.mjs
//
// Catches the same class of issue twice. Every audit finding gets a check
// here so the same thing can't silently regress in a future change.
//
// Garden-specific notes:
//   - Every check here blocks a deploy (npm run deploy runs this first).
//   - Schema migrations live in `migrations/`.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function listFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (['vendor', 'node_modules', '.wrangler', 'dist', 'build', 'migration'].includes(entry)) continue;
      listFiles(full, exts, out);
    } else if (exts.some(e => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
function flag(severity, file, line, rule, detail) {
  findings.push({ severity, file: relative(repoRoot, file), line, rule, detail });
}

// ── Source code checks (src/) ──────────────────────────────────────────────
const srcFiles = listFiles(join(repoRoot, 'src'), ['.js']);
for (const f of srcFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const ln = idx + 1;
    if (/\bSELECT\s+\*/i.test(line) && !/--.*SELECT \*/i.test(line)) {
      flag('HIGH', f, ln, 'SELECT *', 'Explicitly list columns. Prevents leaking sensitive columns added later (password_hash, token_version, etc).');
    }
    if (/Access-Control-Allow-Origin['"\s:,]+\*/.test(line)) {
      flag('HIGH', f, ln, 'CORS wildcard', 'Origin allowlist is required. Never `*`.');
    }
    if (/sk-ant-api03-[A-Za-z0-9_-]{20,}/.test(line)) flag('HIGH', f, ln, 'hardcoded ANTHROPIC key', 'Move to wrangler secret.');
    if (/\bre_[A-Za-z0-9]{20,}/.test(line))            flag('HIGH', f, ln, 'hardcoded RESEND key', 'Move to wrangler secret.');
    if (/sk_live_[A-Za-z0-9]{20,}/.test(line))         flag('HIGH', f, ln, 'hardcoded STRIPE live key', 'Move to wrangler secret.');
    if (/sk-[A-Za-z0-9]{40,}/.test(line) && !/sk-ant/.test(line)) flag('HIGH', f, ln, 'hardcoded OpenAI-shaped key', 'Move to wrangler secret.');
    if (/xox[baprs]-[A-Za-z0-9-]{20,}/.test(line))     flag('HIGH', f, ln, 'hardcoded Slack token', 'Move to secret store.');
    if (/AIza[A-Za-z0-9_-]{30,}/.test(line))           flag('HIGH', f, ln, 'hardcoded Google API key', 'Move to secret store.');
    if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(line)) flag('HIGH', f, ln, 'hardcoded GitHub PAT', 'Move to secret store.');

    if (/\bstatus\s*[:=]\s*429\b/.test(line) || /\.status\(429\)/.test(line) || /,\s*429\b/.test(line)) {
      const window = lines.slice(Math.max(0, idx - 5), Math.min(lines.length, idx + 10)).join('\n');
      if (!/Retry-After/i.test(window)) {
        flag('MEDIUM', f, ln, '429 without Retry-After', 'Add Retry-After header so clients can back off cleanly.');
      }
    }
  });
}

// ── Worker checks: signup MUST require >=10 chars (HIGH-MED-1 regression) ──
const workerJs = readFileSync(join(repoRoot, 'src', 'worker.js'), 'utf8');

// Signup min-10 enforcement. Either the explicit length check OR an isStr
// equivalent with 10 must appear within the signup function.
const signupFn = workerJs.match(/async function signup\(request, env\)\s*{[\s\S]*?\n}\n/);
if (signupFn) {
  if (!/password\.length\s*<\s*10\b/.test(signupFn[0])) {
    flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'signup password min < 10',
      'Audit requires min 10. Re-add `body.password.length < 10` in signup().');
  }
  if (!/password\.length\s*>\s*200\b/.test(signupFn[0])) {
    flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'signup password max > 200',
      'Audit requires max 200. Re-add `body.password.length > 200` in signup().');
  }
}

// Signup enumeration defense — HIGH-1 must not regress.
if (/return res\(\s*\{\s*error:\s*['"]Email already in use/.test(workerJs)) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'signup leaks account existence',
    'Replace explicit dupe error with the burn-cycles success-shaped response.');
}

// Login lockout — HIGH-2.
// The try must be recorded (overLimit on the lock key) BEFORE the password check.
const loginFn = workerJs.match(/async function login\([^)]*\)\s*{[\s\S]*?\n}\n/);
if (!loginFn || !/overLimit\(env, lockKey,/.test(loginFn[0])
    || loginFn[0].indexOf('overLimit(env, lockKey,') > loginFn[0].indexOf('verifyPassword(')) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'login lockout missing',
    'login() must call overLimit(env, lockKey, ...) before verifyPassword().');
}
// The limiter must record and count in one batch, never count-then-insert.
const rlJs = readFileSync(join(repoRoot, 'src', 'lib', 'ratelimit.js'), 'utf8');
if (!/env\.DB\.batch\(\[\s*env\.DB\.prepare\('INSERT INTO rate_limits/.test(rlJs)) {
  flag('HIGH', join(repoRoot, 'src', 'lib', 'ratelimit.js'), 0, 'rate limiter is not atomic',
    'hitCount() must INSERT then COUNT inside one env.DB.batch().');
}

// Account delete re-prompt — HIGH-3.
const deleteFn = workerJs.match(/async function deleteAccount\([^)]*\)\s*{[\s\S]*?\n}\n/);
if (deleteFn) {
  if (!/current_password/.test(deleteFn[0])) {
    flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'deleteAccount missing re-auth',
      'Account delete must require current_password.');
  }
}

// GDPR export endpoint — HIGH-4.
if (!/['"]\/api\/account\/export['"]/.test(workerJs) || !/function exportAccount\b/.test(workerJs)) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'GDPR export endpoint missing',
    'Add GET /api/account/export authed handler.');
}

// Body size cap — HIGH-5.
if (!/MAX_BODY_BYTES\b/.test(workerJs) && !/Content-Length/i.test(workerJs)) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'no body size cap',
    'readJson() must reject oversized bodies before JSON.parse.');
}

// CSRF Origin/Referer check — must still exist.
if (!/function checkOrigin\b/.test(workerJs)) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'CSRF Origin check missing',
    'checkOrigin() helper must validate Origin or Referer against ALLOWED_ORIGINS.');
}

// Security headers — HSTS/X-Frame-Options.
if (!/Strict-Transport-Security/.test(workerJs)) {
  flag('MEDIUM', join(repoRoot, 'src', 'worker.js'), 0, 'HSTS missing',
    'Every response should include Strict-Transport-Security.');
}
if (!/X-Frame-Options/.test(workerJs)) {
  flag('MEDIUM', join(repoRoot, 'src', 'worker.js'), 0, 'X-Frame-Options missing', '');
}

// rate_limits migration — HIGH-2 regression.
const migrationsDir = join(repoRoot, 'migrations');
if (existsSync(migrationsDir)) {
  const migrationFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
  const allMigration = migrationFiles.map(f => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');
  if (!/CREATE TABLE IF NOT EXISTS rate_limits|CREATE TABLE rate_limits/i.test(allMigration)) {
    flag('HIGH', migrationsDir, 0, 'rate_limits table missing',
      'Login lockout depends on rate_limits. Add migration creating it.');
  }
}

// ── Frontend JS sink checks (public/*.js) ──────────────────────────────────
// Every user-named string (bill name, payment source, target billName) that lands
// in a template literal must go through esc(). A dropped esc() is a stored XSS.
const jsFiles = listFiles(join(repoRoot, 'public'), ['.js']);
for (const f of jsFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const ln = idx + 1;
    if (!/</.test(line)) return; // text-only sinks (textContent, toast, modal label) are not HTML
    const re = /\$\{([^}]*\.(?:name|source|billName)\b[^}]*)\}/g;
    let m;
    while ((m = re.exec(line))) {
      const expr = m[1];
      if (/\besc\(/.test(expr)) continue;
      if (/\.(length|toFixed|toLowerCase\(\)\.replace)/.test(expr)) continue;
      flag('HIGH', f, ln, 'unescaped user string in template', expr.slice(0, 80));
    }
    if (/\.innerHTML\s*=\s*[a-zA-Z_$][\w$]*\.(name|source|billName)\b/.test(line)) {
      flag('HIGH', f, ln, 'innerHTML assigned a raw user string', line.trim().slice(0, 80));
    }
  });
}
// The CSP is delivered by the Worker, not a <meta> tag; make sure it is still there.
{
  const w = join(repoRoot, 'src', 'worker.js');
  const wc = readFileSync(w, 'utf8');
  if (!/Content-Security-Policy/.test(wc)) flag('HIGH', w, 0, 'CSP header missing', 'worker.js no longer sets Content-Security-Policy on asset responses.');
  if (!/frame-ancestors 'none'/.test(wc)) flag('MEDIUM', w, 0, 'frame-ancestors missing', "CSP should carry frame-ancestors 'none'.");
  if (!/script-src 'self'/.test(wc) || /script-src[^;]*'unsafe-inline'/.test(wc)) flag('HIGH', w, 0, 'script-src weakened', "script-src must be 'self' without 'unsafe-inline'.");
}

// ── HTML asset checks (public/) ────────────────────────────────────────────
const htmlFiles = listFiles(join(repoRoot, 'public'), ['.html']);
for (const f of htmlFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const ln = idx + 1;
    const linkRe = /<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi;
    const matches = line.match(linkRe);
    if (matches) {
      for (const tag of matches) {
        if (!/\brel\s*=\s*["'][^"']*\bnoopener\b/i.test(tag)) {
          flag('LOW', f, ln, 'target=_blank without rel=noopener', tag.slice(0, 80));
        }
      }
    }
    const cdnScript = line.match(/<script[^>]+src\s*=\s*["']https:\/\/(cdn\.|unpkg\.|cdnjs\.)[^"']+["'][^>]*>/gi);
    if (cdnScript) {
      for (const tag of cdnScript) {
        if (!/\bintegrity\s*=/i.test(tag)) {
          flag('MEDIUM', f, ln, 'CDN script without SRI', tag.slice(0, 80));
        }
      }
    }
    const checkboxMatches = line.match(/<input\b[^>]*\btype\s*=\s*["']checkbox["'][^>]*>/gi);
    if (checkboxMatches) {
      for (const tag of checkboxMatches) {
        if (/\b(newsletter|marketing|subscribe|opt[-_]?in|promo)\b/i.test(tag) && /\bchecked\b/i.test(tag)) {
          flag('HIGH', f, ln, 'consent checkbox default-checked', 'Pre-checked consent violates GDPR/ePrivacy. Default unchecked.');
        }
      }
    }
  });

  // Privacy modal must NOT say "Supabase" (the data lives in D1).
  if (/Privacy Policy/.test(content) && /stored in Supabase/i.test(content)) {
    flag('HIGH', f, 0, 'privacy policy references Supabase',
      'Garden data is in Cloudflare D1. Update privacy modal copy.');
  }

  // Delete-account modal must NOT be a mailto stub (MED gap — modal contradicted API).
  if (/id=["']delete-modal["']/.test(content)) {
    // The new modal calls submitDeleteAccount(); reject if any prominent mailto
    // remains as the primary delete action.
    const mailtoButtons = content.match(/<a[^>]+mailto:[^"']*delete[^"']*[^>]*>(?:[^<]*?)(?:Delete|Send email)[^<]*<\/a>/gi);
    if (mailtoButtons) {
      flag('HIGH', f, 0, 'delete-account modal uses mailto',
        'Delete-account must call DELETE /api/me with password, not a mailto link.');
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log(`   scanned ${srcFiles.length} src + ${htmlFiles.length} html files, no security regressions found`);
  process.exit(0);
}

const high = findings.filter(f => f.severity === 'HIGH');
const med  = findings.filter(f => f.severity === 'MEDIUM');
const low  = findings.filter(f => f.severity === 'LOW');

console.error(`   security scan: ${high.length} HIGH, ${med.length} MEDIUM, ${low.length} LOW`);
for (const f of findings) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.error(`     [${f.severity}] ${where}  '${f.rule}'  — ${f.detail}`);
}

if (high.length > 0) process.exit(1);
console.error('   (warnings only — deploy continues)');
process.exit(0);
