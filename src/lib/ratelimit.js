// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Sliding-window limits on the D1 rate_limits table.
//
// hitCount records this hit THEN counts, in one D1 batch (a single
// transaction). Counting first and inserting after let a burst of parallel
// requests all read "under the cap" before any of them was recorded.
// Returns the count INCLUDING this hit.
export async function hitCount(env, key, windowS) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ? AND created_at < ?').bind(key, now - windowS).run();
  const [, counted] = await env.DB.batch([
    env.DB.prepare('INSERT INTO rate_limits (key, created_at) VALUES (?, ?)').bind(key, now),
    env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND created_at >= ?').bind(key, now - windowS),
  ]);
  return Number(counted?.results?.[0]?.n ?? 0);
}

// True when `key` has already been hit `max` times in the last `windowS`
// seconds. A hit that gets refused is taken back out, so hammering a capped
// route can't keep it capped forever (that let a stranger block someone
// else's password-reset email for as long as they kept asking). Fail-open on
// a D1 error so an outage never locks real people out of signup or reset.
export async function overLimit(env, key, max, windowS) {
  try {
    const n = await hitCount(env, key, windowS);
    if (n <= max) return false;
    await dropNewest(env, key);
    return true;
  } catch (e) {
    console.error('rate_limits overLimit failed:', (e && e.message) || e);
    return false;
  }
}

// Removes the newest hit for a key: a refused hit, or a try that turned out
// to be a correct password.
export async function dropNewest(env, key) {
  try {
    await env.DB.prepare('DELETE FROM rate_limits WHERE id IN (SELECT id FROM rate_limits WHERE key = ? ORDER BY id DESC LIMIT 1)').bind(key).run();
  } catch (e) {
    console.error('rate_limits dropNewest failed:', (e && e.message) || e);
  }
}

// A caller's network, for rate-limit keys: an IPv4 address as is, an IPv6
// address cut to its /64 (one home or phone network), so hopping between
// addresses inside one network doesn't hand out a fresh allowance each time.
export function ipKey(request) {
  const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').toLowerCase();
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
