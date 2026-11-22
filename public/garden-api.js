// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
/* Garden API client — Supabase-shaped facade over the Worker /api/* routes.
 * Drop-in replacement for `supabase.createClient(...)` minus realtime/storage.
 * Only the methods Garden actually uses are implemented.
 */
(function () {
  'use strict';

  // Endpoint map
  const ENDPOINTS = {
    bills: '/api/bills',
    payments: '/api/payments',
    monthly_amounts: '/api/monthly-amounts',
    user_settings: '/api/settings',
  };

  // ---- low-level fetch with auth + hub Pro headers --------------------------

  // The session is the HttpOnly garden_session cookie, set and cleared by the
  // Worker. Page scripts can't read it, so `signedIn` only tracks whether the
  // last answer from the server said this browser has a live session.
  let signedIn = false;
  // The pre-cookie localStorage token is no longer accepted by the server.
  // Wipe any stale copy on load (and again on sign-out).
  const LEGACY_KEY = 'garden_token';
  function dropLegacyToken() { try { localStorage.removeItem(LEGACY_KEY); } catch (_) {} }
  dropLegacyToken();

  // Plain copy for the two failures a user can do nothing about except retry.
  // Real API error messages pass through untouched.
  const NET_ERR = "Can't reach the server. Check your connection and try again.";
  const SERVER_ERR = 'Something went wrong on our end. Try again in a minute.';

  async function apiFetch(path, opts) {
    opts = opts || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      opts.headers || {}
    );
    const hubPro = localStorage.getItem('hub_pro_jwt');
    if (hubPro) headers['X-Hub-Pro'] = hubPro;
    let r;
    try {
      r = await fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
    } catch (e) {
      // A dropped connection rejects fetch() with a TypeError ("Failed to
      // fetch"). Developer copy never reaches the user.
      const ne = new Error(NET_ERR); ne.network = true; throw ne;
    }
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) {} }
    // A 5xx carries the worker's generic 'Server error' (or nothing at all);
    // the user sees one plain line instead.
    if (r.status >= 500) data = Object.assign({}, data || {}, { error: SERVER_ERR });
    // A 401 on anything but the auth routes means the session the browser
    // holds is no longer good (expired, or revoked by a sign-out elsewhere).
    // Tell the app, which ends the session in place with a message instead
    // of leaving a stale garden on screen. The auth routes answer their own
    // 401s (a wrong password must stay an inline error).
    if (r.status === 401 && signedIn && path.indexOf('/api/auth/') !== 0) {
      signedIn = false;
      emit('SESSION_ENDED', null);
    }
    // Any session-minting response (login, verify-code, reset-confirm) may
    // carry a hub Pro token — Pro follows the account, not the browser. Same
    // localStorage slot as the ?hubpro= hand-off; captured here so every auth
    // path gets it without per-handler wiring.
    if (data && typeof data.hub_pro_token === 'string') localStorage.setItem('hub_pro_jwt', data.hub_pro_token);
    return { status: r.status, ok: r.ok, data };
  }

  // ---- auth listeners (Supabase compat) -------------------------------------

  const authListeners = [];
  let _sessionPromise = null;
  function emit(event, session) { authListeners.forEach(fn => { try { fn(event, session); } catch (_) {} }); }

  // Capture the password-reset token from the URL on landing. Held in memory
  // so the updateUser({password}) call can submit it. Stripped from the URL so
  // a refresh doesn't re-trigger the recovery flow.
  //
  // TWO shapes are accepted:
  //   /reset/<token>   preferred, and what the email now sends
  //   ?reset=<token>   legacy, kept so links already in inboxes still work
  //
  // WHY the path form exists: mail transfer mangles the '=' in a query string.
  // Reset emails arrived with '?reset,<token>' and '?reset\uFFFD<token>' — the
  // '=' plus the next two hex characters eaten as a quoted-printable escape.
  // searchParams.get('reset') then returns null and the reset screen never
  // opens. A path segment has no '=' to mangle.
  let recoveryToken = null;
  (function captureRecoveryToken() {
    try {
      const u = new URL(window.location.href);
      const m = u.pathname.match(/^\/reset\/([A-Za-z0-9._-]{16,256})\/?$/);
      const t = (m && m[1]) || u.searchParams.get('reset');
      if (t && t.length >= 16 && t.length <= 256) {
        recoveryToken = t;
        u.searchParams.delete('reset');
        const path = m ? '/' : u.pathname;
        window.history.replaceState({}, '', path + (u.search || '') + u.hash);
      }
    } catch (_) {}
  })();

  // ---- query builder --------------------------------------------------------

  function QueryBuilder(table) {
    this.table = table;
    this._filters = [];
    this._order = null;
    this._action = null;
    this._payload = null;
    this._upsertOpts = null;
  }

  QueryBuilder.prototype.select = function () {
    // .select() means "return the affected rows" — Supabase chains it after
    // insert/update/upsert/delete. Only set action to 'select' when no
    // mutation action has been set yet; otherwise it's a return-rows tag.
    if (!this._action) this._action = 'select';
    return this;
  };
  QueryBuilder.prototype.insert = function (rows) {
    this._action = 'insert';
    this._payload = Array.isArray(rows) ? rows : [rows];
    // Supabase pattern: insert().select() returns the inserted rows.
    // Our Worker returns the new row directly, so .select() is a no-op tag.
    return this;
  };
  QueryBuilder.prototype.update = function (obj) { this._action = 'update'; this._payload = obj; return this; };
  QueryBuilder.prototype.delete = function () { this._action = 'delete'; return this; };
  QueryBuilder.prototype.upsert = function (obj, opts) {
    this._action = 'upsert'; this._payload = obj; this._upsertOpts = opts || null; return this;
  };
  QueryBuilder.prototype.eq = function (col, val) { this._filters.push({ col, val }); return this; };
  QueryBuilder.prototype.order = function (col) { this._order = col; return this; };

  // Thenable so `await sb.from(...).select(...)...` works
  QueryBuilder.prototype.then = function (resolve, reject) {
    return this._execute().then(resolve, reject);
  };
  QueryBuilder.prototype.maybeSingle = function () {
    this._maybeSingle = true;
    return this._execute();
  };
  QueryBuilder.prototype.single = function () {
    this._single = true;
    return this._execute();
  };

  QueryBuilder.prototype._execute = async function () {
    const endpoint = ENDPOINTS[this.table];
    if (!endpoint) return { data: null, error: { message: 'unknown table: ' + this.table } };

    try {
      const result = await this._dispatch(endpoint);
      return this._wrap(result);
    } catch (e) {
      return { data: null, error: { message: e && e.message || 'request failed' } };
    }
  };

  QueryBuilder.prototype._dispatch = async function (endpoint) {
    const a = this._action;
    const idFilter = this._filters.find(f => f.col === 'id');
    const monthFilter = this._filters.find(f => f.col === 'month');

    // user_settings is a singleton per user — different REST shape
    if (this.table === 'user_settings') {
      if (a === 'select')  return apiFetch(endpoint);
      if (a === 'upsert' || a === 'update') {
        return apiFetch(endpoint, { method: 'PUT', body: JSON.stringify({ monthly_goal: this._payload.monthly_goal }) });
      }
      throw new Error('user_settings: unsupported action ' + a);
    }

    if (a === 'select') {
      const qs = monthFilter ? '?month=' + encodeURIComponent(monthFilter.val) : '';
      return apiFetch(endpoint + qs);
    }
    if (a === 'insert') {
      // Worker inserts one at a time. Garden never bulk-inserts.
      return apiFetch(endpoint, { method: 'POST', body: JSON.stringify(this._payload[0]) });
    }
    if (a === 'update') {
      if (!idFilter) throw new Error('update requires .eq("id", ...)');
      // Special case: { archived: bool, end_month? } toggles archive endpoint
      const keys = Object.keys(this._payload);
      if (keys.includes('archived') && keys.every(k => k === 'archived' || k === 'end_month')) {
        return apiFetch(endpoint + '/' + encodeURIComponent(idFilter.val) + '/archive', {
          method: 'PATCH', body: JSON.stringify({ archived: !!this._payload.archived, end_month: this._payload.end_month || null }),
        });
      }
      return apiFetch(endpoint + '/' + encodeURIComponent(idFilter.val), {
        method: 'PUT', body: JSON.stringify(this._payload),
      });
    }
    if (a === 'delete') {
      if (!idFilter) throw new Error('delete requires .eq("id", ...)');
      return apiFetch(endpoint + '/' + encodeURIComponent(idFilter.val), { method: 'DELETE' });
    }
    if (a === 'upsert') {
      // monthly_amounts upsert: Worker handles ON CONFLICT(bill_id, month)
      return apiFetch(endpoint, { method: 'POST', body: JSON.stringify(this._payload) });
    }
    throw new Error('unsupported action: ' + a);
  };

  QueryBuilder.prototype._wrap = function (r) {
    if (!r.ok) {
      return { data: null, error: { message: (r.data && r.data.error) || ('HTTP ' + r.status), status: r.status } };
    }
    const data = r.data;
    if (this._maybeSingle || this._single) {
      if (Array.isArray(data)) return { data: data[0] || null, error: null };
      return { data: data || null, error: null };
    }
    // Insert returns single object; Supabase expects array when .select() used.
    if (this._action === 'insert') {
      return { data: Array.isArray(data) ? data : [data], error: null };
    }
    return { data, error: null };
  };

  // ---- auth methods (Supabase shape) ----------------------------------------

  const auth = {
    async signUp(creds) {
      const newsletter_consent = !!(creds && creds.options && creds.options.data && creds.options.data.newsletter_consent);
      const r = await apiFetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: creds.email, password: creds.password, newsletter_consent }) });
      if (!r.ok) return { data: { user: null, session: null }, error: { message: (r.data && r.data.error) || 'signup failed' } };
      // Shape: { ok, message, user? }. Only a response that started a session
      // (cookie set by the Worker) carries `user`. Without it we must NOT emit
      // SIGNED_IN, so the UI shows the verify message.
      if (!r.data || !r.data.user) {
        // email_sent is false only when the worker tried to send the code and
        // the mail provider refused; the UI must not promise an inbox then.
        return { data: { user: null, session: null, message: (r.data && r.data.message) || 'If that email is new, check your inbox to verify.', email_sent: r.data ? r.data.email_sent : undefined }, error: null };
      }
      signedIn = true;
      const session = { user: r.data.user };
      emit('SIGNED_IN', session);
      return { data: { user: r.data.user, session }, error: null };
    },
    async signInWithPassword(creds) {
      const r = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: creds.email, password: creds.password }) });
      if (!r.ok) {
        const err = { message: (r.data && r.data.error) || 'login failed' };
        if (r.data && r.data.code) err.code = r.data.code;
        if (r.data && r.data.email) err.email = r.data.email;
        return { data: { user: null, session: null }, error: err };
      }
      signedIn = true;
      const session = { user: r.data.user };
      emit('SIGNED_IN', session);
      return { data: { user: r.data.user, session }, error: null };
    },
    async resendVerification(email) {
      const r = await apiFetch('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      if (!r.ok) return { error: { message: (r.data && r.data.error) || 'Could not resend email' } };
      return { data: r.data, error: null };
    },
    // Finish email verification with the 6-digit code. On a real match the
    // Worker sets the session cookie, so we emit SIGNED_IN exactly like a
    // normal login — the app boots straight through.
    // The password goes along too: the Worker checks it so a code can't finish
    // an account whose password someone else set.
    async verifyCode(email, code, password) {
      const r = await apiFetch('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email, code, password }) });
      if (!r.ok || !r.data || !r.data.user) {
        return { data: { user: null, session: null }, error: { message: (r.data && r.data.error) || 'Could not verify code' } };
      }
      signedIn = true;
      const session = { user: r.data.user };
      emit('SIGNED_IN', session);
      return { data: { user: r.data.user, session }, error: null };
    },
    async signOut() {
      // The Worker revokes the session and clears the HttpOnly cookie.
      signedIn = false;
      try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      dropLegacyToken();
      emit('SIGNED_OUT', null);
      return { error: null };
    },
    // One GET /api/me decides "logged in?" (the cookie is HttpOnly). Calls that
    // overlap share one request, so boot makes exactly one. A dropped
    // connection rejects (the app says so); a 5xx answers "no session".
    getSession() {
      if (_sessionPromise) return _sessionPromise;
      _sessionPromise = (async () => {
        const r = await apiFetch('/api/me');
        signedIn = r.ok;
        if (!r.ok) return { data: { session: null }, error: null };
        return { data: { session: { user: r.data } }, error: null };
      })();
      return _sessionPromise.finally(() => { _sessionPromise = null; });
    },
    async getUser() {
      const r = await apiFetch('/api/me');
      if (!r.ok) return { data: { user: null }, error: { message: 'no session' } };
      return { data: { user: r.data }, error: null };
    },
    async resetPasswordForEmail(email, _opts) {
      const r = await apiFetch('/api/auth/reset-request', { method: 'POST', body: JSON.stringify({ email }) });
      // Worker returns 200 ok regardless of whether the email exists (no enumeration).
      if (!r.ok) return { data: null, error: { message: (r.data && r.data.error) || 'Could not send reset email' } };
      return { data: {}, error: null };
    },
    async updateUser(attrs) {
      // Garden only uses updateUser to set a new password after PASSWORD_RECOVERY.
      if (attrs && typeof attrs.password === 'string') {
        if (!recoveryToken) return { data: { user: null }, error: { message: 'Reset link is missing or expired. Request a new one.' } };
        const r = await apiFetch('/api/auth/reset-confirm', { method: 'POST', body: JSON.stringify({ token: recoveryToken, password: attrs.password }) });
        if (!r.ok) return { data: { user: null }, error: { message: (r.data && r.data.error) || 'Could not reset password' } };
        recoveryToken = null;
        signedIn = true;
        emit('SIGNED_IN', { user: r.data.user });
        return { data: { user: r.data.user }, error: null };
      }
      return { data: { user: null }, error: { message: 'updateUser only supports {password} for now' } };
    },
    onAuthStateChange(fn) {
      authListeners.push(fn);
      // If we landed with ?reset=<token>, fire PASSWORD_RECOVERY so the Garden
      // UI flips into the reset-password screen. No INITIAL_SESSION event: the
      // app boots from its own getSession() call, and a second /api/me here
      // would race hub-sso on a ?hubpro= arrival.
      Promise.resolve().then(() => {
        if (recoveryToken) fn('PASSWORD_RECOVERY', null);
      });
      return {
        data: {
          subscription: {
            unsubscribe: function () {
              const i = authListeners.indexOf(fn);
              if (i >= 0) authListeners.splice(i, 1);
            },
          },
        },
      };
    },
    // Hub SSO — capture ?hubpro= from URL on landing and exchange for Garden session
    async hubSsoExchange(hubProJwt) {
      const r = await apiFetch('/api/auth/hub-sso', { method: 'POST', body: JSON.stringify({ hub_pro_jwt: hubProJwt }) });
      if (!r.ok) return { error: { message: (r.data && r.data.error) || 'hub-sso failed' } };
      signedIn = true;
      emit('SIGNED_IN', { user: r.data.user });
      return { data: { user: r.data.user } };
    },
  };

  // ---- client export --------------------------------------------------------

  function GardenClient() {}
  GardenClient.prototype.from = function (table) { return new QueryBuilder(table); };
  Object.defineProperty(GardenClient.prototype, 'auth', { get: function () { return auth; } });

  // Expose a `supabase` global with `.createClient()` to mimic the SDK exactly.
  // Garden's existing code does: const sb = supabase.createClient(URL, KEY);
  // We ignore URL/KEY since we talk to /api/* on this same origin.
  window.supabase = {
    createClient: function (_url, _key) { return new GardenClient(); },
  };
})();
