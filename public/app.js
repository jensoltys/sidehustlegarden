// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
'use strict';

// The tab (or day) the user was on before they hit refresh. history.state
// survives a reload of the same entry, but init() replaceState()s an
// auth-landing entry over it before enterApp() ever runs, so it has to be captured HERE, at module load,
// before anything touches history. Without it, refreshing anywhere but the
// default tab bounced the user back to the default.
const BOOT_VIEW=(history.state||{}).view||null;
// Side Hustle Garden — main app logic.
// Lives in its own file so the CSP can drop 'unsafe-inline' from script-src.
// Order matters: /garden-api.js MUST load before this file (it exposes the
// small auth + data client used below as window.supabase).

// Used by /feedback-widget.js — set before that script loads at end of body.
window.FEEDBACK_APP = 'Side Hustle Garden';

// ── Pro on a copy ───────────────────────────────────────────────────────────
// Pro is part of the hosted version, so nobody has it on a copy. The Pro-only
// surfaces stay visible and locked, and every Go Pro says where Pro lives.
function hasProAccess() {
  return false;
}
function syncProBadge() {
  // The Forecast tab keeps its star and a locked state, so people know the
  // feature exists. Opening it shows the note about the hosted version.
  document.querySelectorAll('.pro-feature').forEach(el => {
    el.style.display = '';
    el.classList.add('pro-locked');
  });
  const region = document.getElementById('pro-badge-region');
  const btn = document.getElementById('unlock-pro-btn');
  const sbRegion = document.getElementById('sb-pro-badge');
  const sbBtn = document.getElementById('sb-unlock-pro-btn');
  if (region) { region.classList.remove('show'); region.style.display = ''; }
  if (btn) btn.style.display = 'inline-block';
  if (sbRegion) { sbRegion.classList.remove('show'); sbRegion.style.display = ''; }
  if (sbBtn) sbBtn.style.display = 'inline-block';
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncProBadge);
} else {
  syncProBadge();
}

// ── Overlay history (back-button rule) ────────────────────────────────
// Every modal/drawer/overlay pushes ONE history entry when it opens, so the
// browser Back button closes it instead of leaving the page. Before this, the
// popstate handler already called closeAllOverlays() — but nothing ever pushed
// an entry, so there was nothing to pop and Back navigated off the app.
// State keeps the {view,month} snapshot
// pushViewState() uses so one popstate always restores a consistent view.
let sgOverlayDepth = 0;
function pushOverlayState() {
  sgOverlayDepth++;
  const state = { ...(history.state || {}), view: currentTab, month: viewMonth, sgOverlay: sgOverlayDepth };
  history.pushState(state, '', location.pathname + location.search);
}
// Hands the close off to history so the on-screen button and the browser Back
// button stay in sync (no dead presses). Returns true when it did — the caller
// must then NOT hide the element itself; the popstate handler does it.
function closeOverlayViaHistory() {
  if (sgOverlayDepth > 0 && (history.state || {}).sgOverlay) {
    history.back();
    return true;
  }
  return false;
}

// ── Unified Pro-required modal ──────────────────────────────────────────────
// Used wherever an active user click hits a
// Pro gate. The inline locked tabs (forecast, future) still exist as
// contextual displays — both reach the same upgrade page.
// What this site offers, from GET /api/site-config: whether the Feedback button is on.
let feedbackAvailable=false;
const SITE_CONFIG_READY=fetch('/api/site-config',{credentials:'same-origin'})
  .then(r=>r.ok?r.json():null)
  .then(d=>{feedbackAvailable=!!(d&&d.feedback_available===true);})
  .catch(()=>{});
// Every Go Pro link opens the popup that says where Pro lives.
document.addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('#unlock-pro-btn,#sb-unlock-pro-btn,[data-pro-cta]');
  if(!b)return;
  e.preventDefault();
  showProRequired(b.dataset.proCta||'');
});
const PRO_FEATURE_COPY = {
  'cash-flow-forecast': { title: '6-month cash flow forecast', desc: 'See where your bills and side hustle income land over the next 6 months.' },
  'csv-export': { title: 'CSV export', desc: 'Download all your bills, payments, and monthly amounts as CSV.' },
};
function showProRequired(feature) {
  // Pro only exists on the hosted version, so say that plainly.
  const copy = { title: (PRO_FEATURE_COPY[feature] || { title: 'Pro feature' }).title, desc: "Pro isn't available on this copy of Side Hustle Garden. It's part of the hosted version at sidehustlegarden.com. A garden there starts fresh, nothing moves over from here." };
  const url = 'https://sidehustlegarden.com';
  const modal = document.getElementById('pro-required-modal');
  if (!modal) return;
  modal.querySelector('#pro-required-title').textContent = copy.title;
  modal.querySelector('#pro-required-desc').textContent = copy.desc;
  const cta = modal.querySelector('#pro-required-cta');
  cta.href = url;
  cta.textContent = 'Open sidehustlegarden.com';
  modal.style.display = 'flex';
  pushOverlayState();
}
// fromHistory=true means popstate is already unwinding the entry — hide
// directly, or calling history.back() again would loop.
function closeProRequired(fromHistory) {
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  const m = document.getElementById('pro-required-modal');
  if (m) m.style.display = 'none';
}
document.addEventListener('click', (e) => {
  if (e.target?.dataset?.action === 'close-pro-modal') closeProRequired();
  const t = e.target.closest?.('[data-action]');
  if (!t) return;
  if (t.dataset.action === 'close-help') closeHelp();
  else if (t.dataset.action === 'start-tour') { closeHelp(); setTimeout(startTour, 220); }
  else if (t.dataset.action === 'tip-act') runTipAction(t.dataset.tipAct);
});

// ── Boot gate ───────────────────────────────────────────────────────────────
// #auth-screen is hidden in the markup, so the logged-out card cannot paint over
// a session that is seconds from resolving.
// The session is an HttpOnly cookie the page can't read, so everyone waits on
// the boot screen until boot() below asks GET /api/me (401 = the auth screen).
// A logged-in user never sees the login card flash, and a logged-out one sees
// the boot screen for one round trip.
function showAuthScreen() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.style.display = 'none';
  const auth = document.getElementById('auth-screen');
  if (auth) auth.style.display = 'flex';
}
function hideBootScreen() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.style.display = 'none';
}
(function bootGate() {
  const msg = document.getElementById('boot-msg');
  if (msg) msg.textContent = 'Opening your garden…';
})();

function showProUpgrade(featureId) {
  showProRequired(featureId);
}

// Data layer is Cloudflare D1 via the Worker. `supabase` here is the
// garden-api.js facade (Supabase-shaped API over /api/* routes), NOT Supabase —
// createClient ignores any URL/key. Fully migrated off Supabase; no real
// Supabase project is used. See garden-api.js.
const sb=supabase.createClient(); window.sb=sb;

const MNAMES=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Tier system based on bill amount
// SVG plant sprites
const SP={
  tree:'<svg viewBox="0 0 40 46" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="17" y="30" width="6" height="14" rx="2" fill="#A0785A"/><ellipse cx="20" cy="24" rx="16" ry="14" fill="#C8E6C8" stroke="white" stroke-width=".8"/><ellipse cx="20" cy="20" rx="13" ry="12" fill="#D8F0D8"/><ellipse cx="20" cy="17" rx="9" ry="9" fill="#E8F8E8"/><ellipse cx="15" cy="14" rx="4" ry="3" fill="rgba(255,255,255,.3)"/><circle cx="12" cy="22" r="2.5" fill="#F472B6" opacity=".8"/><circle cx="27" cy="19" r="2" fill="#FBBF24" opacity=".8"/><circle cx="20" cy="28" r="1.5" fill="#FB7185" opacity=".6"/></svg>',
  vine:'<svg viewBox="0 0 36 42" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="15" y="28" width="5" height="12" rx="2" fill="#A0785A"/><path d="M18 28Q8 22 12 10Q16 2 22 8Q28 14 18 28" fill="#D8F0D8" stroke="white" stroke-width=".6"/><path d="M18 28Q28 24 26 12Q24 4 18 8Q12 14 18 28" fill="#C8E6C8"/><ellipse cx="14" cy="12" rx="3" ry="2" fill="rgba(255,255,255,.2)"/><circle cx="22" cy="14" r="2" fill="#B8C690" opacity=".6"/></svg>',
  thorn:'<svg viewBox="0 0 36 40" width="1em" height="1.1em" style="vertical-align:middle;display:inline-block"><rect x="15" y="26" width="5" height="12" rx="2" fill="#A0785A"/><path d="M18 26Q10 20 8 10Q12 4 18 9Q24 4 28 10Q26 20 18 26" fill="#C8DFC0" stroke="white" stroke-width=".6"/><path d="M18 9Q15 16 18 22Q21 16 18 9" fill="#B8D0A8" opacity=".5"/><line x1="8" y1="16" x2="3" y2="13" stroke="#C8DFC0" stroke-width="2.5" stroke-linecap="round"/><line x1="28" y1="16" x2="33" y2="13" stroke="#C8DFC0" stroke-width="2.5" stroke-linecap="round"/><line x1="10" y1="22" x2="6" y2="22" stroke="#C8DFC0" stroke-width="2" stroke-linecap="round"/><line x1="26" y1="22" x2="30" y2="22" stroke="#C8DFC0" stroke-width="2" stroke-linecap="round"/></svg>',
  weed:'<svg viewBox="0 0 30 38" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="13" y="24" width="4" height="12" rx="1.5" fill="#A0785A"/><path d="M15 24Q8 18 10 8Q14 2 15 10Q16 2 20 8Q22 18 15 24" fill="#D0ECD0" stroke="white" stroke-width=".6"/><ellipse cx="12" cy="10" rx="2.5" ry="2" fill="rgba(255,255,255,.2)"/></svg>',
  seed:'<svg viewBox="0 0 24 34" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="10" y="22" width="4" height="10" rx="1.5" fill="#A0785A"/><ellipse cx="12" cy="20" rx="7" ry="8" fill="#C8E6C8" stroke="white" stroke-width=".6"/><ellipse cx="12" cy="16" rx="5" ry="6" fill="#E0F4E0"/><ellipse cx="10" cy="14" rx="2.5" ry="2" fill="rgba(255,255,255,.25)"/></svg>',
  dead:'<svg viewBox="0 0 26 32" width="1em" height="1.1em" style="vertical-align:middle;display:inline-block"><rect x="11" y="20" width="4" height="10" rx="1.5" fill="#A0785A"/><path d="M13 20Q6 15 9 8Q13 12 13 20" fill="#D4C0A0" opacity=".7"/><path d="M13 20Q20 15 17 8Q13 12 13 20" fill="#C4B090" opacity=".6"/></svg>',
};
// Dark/normal green versions for light backgrounds
const SP_D={
  tree:'<svg viewBox="0 0 40 46" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="17" y="30" width="6" height="14" rx="2" fill="#8B6542"/><ellipse cx="20" cy="24" rx="16" ry="14" fill="#3D4A2B"/><ellipse cx="20" cy="20" rx="13" ry="12" fill="#5D7040"/><ellipse cx="20" cy="17" rx="9" ry="9" fill="#7B9253"/><ellipse cx="15" cy="14" rx="4" ry="3" fill="rgba(255,255,255,.12)"/><circle cx="12" cy="22" r="2.5" fill="#F472B6" opacity=".7"/><circle cx="27" cy="19" r="2" fill="#FBBF24" opacity=".7"/><circle cx="20" cy="28" r="1.5" fill="#FB7185" opacity=".5"/></svg>',
  vine:'<svg viewBox="0 0 36 42" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="15" y="28" width="5" height="12" rx="2" fill="#8B6542"/><path d="M18 28Q8 22 12 10Q16 2 22 8Q28 14 18 28" fill="#5D7040"/><path d="M18 28Q28 24 26 12Q24 4 18 8Q12 14 18 28" fill="#3D4A2B"/><ellipse cx="14" cy="12" rx="3" ry="2" fill="rgba(255,255,255,.12)"/></svg>',
  thorn:'<svg viewBox="0 0 36 40" width="1em" height="1.1em" style="vertical-align:middle;display:inline-block"><rect x="15" y="26" width="5" height="12" rx="2" fill="#8B6542"/><path d="M18 26Q10 20 8 10Q12 4 18 9Q24 4 28 10Q26 20 18 26" fill="#6B8F4A"/><path d="M18 9Q15 16 18 22Q21 16 18 9" fill="#5A7F3A" opacity=".4"/><line x1="8" y1="16" x2="3" y2="13" stroke="#6B8F4A" stroke-width="2.5" stroke-linecap="round"/><line x1="28" y1="16" x2="33" y2="13" stroke="#6B8F4A" stroke-width="2.5" stroke-linecap="round"/><line x1="10" y1="22" x2="6" y2="22" stroke="#6B8F4A" stroke-width="2" stroke-linecap="round"/><line x1="26" y1="22" x2="30" y2="22" stroke="#6B8F4A" stroke-width="2" stroke-linecap="round"/></svg>',
  weed:'<svg viewBox="0 0 30 38" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="13" y="24" width="4" height="12" rx="1.5" fill="#8B6542"/><path d="M15 24Q8 18 10 8Q14 2 15 10Q16 2 20 8Q22 18 15 24" fill="#7B9253"/><ellipse cx="12" cy="10" rx="2.5" ry="2" fill="rgba(255,255,255,.1)"/></svg>',
  seed:'<svg viewBox="0 0 24 34" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block"><rect x="10" y="22" width="4" height="10" rx="1.5" fill="#A0785A"/><ellipse cx="12" cy="20" rx="7" ry="8" fill="#7BC77B"/><ellipse cx="12" cy="16" rx="5" ry="6" fill="#8FD88F"/><ellipse cx="10" cy="14" rx="2.5" ry="2" fill="rgba(255,255,255,.15)"/></svg>',
  dead:'<svg viewBox="0 0 26 32" width="1em" height="1.1em" style="vertical-align:middle;display:inline-block"><rect x="11" y="20" width="4" height="10" rx="1.5" fill="#A0785A"/><path d="M13 20Q6 15 9 8Q13 12 13 20" fill="#C4956B" opacity=".6"/><path d="M13 20Q20 15 17 8Q13 12 13 20" fill="#B8845A" opacity=".5"/></svg>',
};
// SVG icons for UI and celebrations
const IC={
  check:'<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block"><path d="M5 12l5 5L20 7"/></svg>',
  chevL:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  chevR:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  butterfly:'<svg viewBox="0 0 24 20" width="1em" height=".85em" style="vertical-align:middle;display:inline-block"><ellipse cx="12" cy="10" rx="2" ry="6" fill="#8B6542"/><ellipse cx="6" cy="7" rx="5" ry="5" fill="#E879F9" opacity=".8"/><ellipse cx="18" cy="7" rx="5" ry="5" fill="#C084FC" opacity=".8"/><ellipse cx="6" cy="13" rx="4" ry="4" fill="#F9A8D4" opacity=".7"/><ellipse cx="18" cy="13" rx="4" ry="4" fill="#D8B4FE" opacity=".7"/></svg>',
  bee:'<svg viewBox="0 0 22 18" width="1em" height=".8em" style="vertical-align:middle;display:inline-block"><ellipse cx="11" cy="10" rx="7" ry="6" fill="#FBBF24"/><rect x="7" y="8" width="8" height="2" rx="1" fill="#1C1917"/><rect x="7" y="12" width="8" height="2" rx="1" fill="#1C1917"/><ellipse cx="7" cy="6" rx="4" ry="3" fill="rgba(255,255,255,.5)"/><ellipse cx="15" cy="6" rx="4" ry="3" fill="rgba(255,255,255,.5)"/></svg>',
  ladybug:'<svg viewBox="0 0 20 18" width="1em" height=".9em" style="vertical-align:middle;display:inline-block"><ellipse cx="10" cy="10" rx="8" ry="7" fill="#EF4444"/><line x1="10" y1="3" x2="10" y2="17" stroke="#1C1917" stroke-width="1.5"/><circle cx="6" cy="8" r="1.5" fill="#1C1917"/><circle cx="14" cy="8" r="1.5" fill="#1C1917"/><circle cx="8" cy="13" r="1.5" fill="#1C1917"/><circle cx="12" cy="13" r="1.5" fill="#1C1917"/><circle cx="10" cy="4" r="3" fill="#1C1917"/></svg>',
  hedgehog:'<svg viewBox="0 0 28 22" width="1em" height=".8em" style="vertical-align:middle;display:inline-block"><ellipse cx="14" cy="14" rx="12" ry="7" fill="#A0785A"/><ellipse cx="14" cy="12" rx="10" ry="6" fill="#C4956B"/><path d="M6 8L4 3M9 6L8 1M12 5L12 0M15 5L16 0M18 6L20 1M21 8L24 3" stroke="#8B6542" stroke-width="1.5" stroke-linecap="round"/><circle cx="20" cy="13" r="2.5" fill="#F5E6C8"/><circle cx="21" cy="12.5" r="1.5" fill="#1C1917"/><circle cx="23" cy="14" r="1.5" fill="#1C1917"/></svg>',
  caterpillar:'<svg viewBox="0 0 30 14" width="1.2em" height=".6em" style="vertical-align:middle;display:inline-block"><circle cx="5" cy="8" r="4" fill="#4ADE80"/><circle cx="12" cy="7" r="4" fill="#86EFAC"/><circle cx="19" cy="8" r="4" fill="#4ADE80"/><circle cx="26" cy="7" r="4.5" fill="#86EFAC"/><circle cx="27" cy="5" r="1.5" fill="white"/><circle cx="27.5" cy="5" r=".8" fill="#1C1917"/></svg>',
  trophy:'<svg viewBox="0 0 20 22" width="1em" height="1.1em" style="vertical-align:middle;display:inline-block"><path d="M5 2h10v8c0 3-2 5-5 5s-5-2-5-5V2z" fill="#FBBF24"/><path d="M5 4H2c0 3 1 5 3 5" fill="#B9882E"/><path d="M15 4h3c0 3-1 5-3 5" fill="#B9882E"/><rect x="8" y="15" width="4" height="3" fill="#8C6422"/><rect x="6" y="18" width="8" height="2" rx="1" fill="#B45309"/></svg>',
  crown:'<svg viewBox="0 0 22 18" width="1em" height=".85em" style="vertical-align:middle;display:inline-block"><path d="M2 14L4 4L8 10L11 2L14 10L18 4L20 14Z" fill="#FBBF24"/><rect x="2" y="14" width="18" height="3" rx="1" fill="#8C6422"/></svg>',
  star:'<svg viewBox="0 0 20 20" width="1em" height="1em" style="vertical-align:middle;display:inline-block"><path d="M10 1L12.5 7.5L19 8L14 12.5L15.5 19L10 15.5L4.5 19L6 12.5L1 8L7.5 7.5Z" fill="#FBBF24"/></svg>',
  fire:'<svg viewBox="0 0 16 20" width=".8em" height="1em" style="vertical-align:middle;display:inline-block"><path d="M8 0C8 0 2 6 2 12c0 4 2.5 7 6 7s6-3 6-7C14 6 8 0 8 0z" fill="#F97316"/><path d="M8 6C8 6 5 10 5 14c0 2 1.3 4 3 4s3-2 3-4C11 10 8 6 8 6z" fill="#FBBF24"/></svg>',
  sparkle:'<svg viewBox="0 0 16 16" width=".8em" height=".8em" style="vertical-align:middle;display:inline-block"><path d="M8 0L9.5 6.5L16 8L9.5 9.5L8 16L6.5 9.5L0 8L6.5 6.5Z" fill="#FBBF24"/></svg>',
  heart:'<svg viewBox="0 0 18 16" width=".9em" height=".85em" style="vertical-align:middle;display:inline-block"><path d="M9 14s-7-4.5-7-8.5C2 3 4 1 6.5 1 8 1 9 2 9 2s1-1 2.5-1C14 1 16 3 16 5.5 16 9.5 9 14 9 14z" fill="#4ADE80"/></svg>',
  scissors:'<svg viewBox="0 0 18 18" width=".9em" height=".9em" style="vertical-align:middle;display:inline-block"><circle cx="5" cy="5" r="3" fill="none" stroke="#78716C" stroke-width="1.5"/><circle cx="5" cy="13" r="3" fill="none" stroke="#78716C" stroke-width="1.5"/><path d="M7.5 7L15 2M7.5 11L15 16" stroke="#78716C" stroke-width="1.5" stroke-linecap="round"/></svg>',
  party:'<svg viewBox="0 0 18 20" width=".9em" height="1em" style="vertical-align:middle;display:inline-block"><path d="M2 18L6 2L16 12Z" fill="#A855F7"/><circle cx="8" cy="4" r="1.5" fill="#FB7185"/><circle cx="14" cy="8" r="1.5" fill="#FBBF24"/><circle cx="12" cy="3" r="1" fill="#8FA45E"/></svg>',
  muscle:'<svg viewBox="0 0 20 18" width="1em" height=".9em" style="vertical-align:middle;display:inline-block"><path d="M3 14Q1 10 3 6Q5 2 8 4L10 8L12 4Q15 2 17 6Q19 10 17 14" fill="#F4A261"/></svg>',
  droplet:'<svg viewBox="0 0 14 18" width=".7em" height=".9em" style="vertical-align:middle;display:inline-block"><path d="M7 1C7 1 1 8 1 12c0 3 2.5 5 6 5s6-2 6-5C13 8 7 1 7 1z" fill="#60A5FA"/><ellipse cx="5" cy="11" rx="1.5" ry="2" fill="white" opacity=".3"/></svg>',
  leaf:'<svg viewBox="0 0 16 18" width=".8em" height=".9em" style="vertical-align:middle;display:inline-block"><path d="M8 16C8 16 2 12 2 6C2 2 5 0 8 0C11 0 14 2 14 6C14 12 8 16 8 16z" fill="#4ADE80"/><path d="M8 4V14" stroke="#8FA45E" stroke-width="1" opacity=".5"/></svg>',
  house:'<svg viewBox="0 0 18 18" width=".9em" height=".9em" style="vertical-align:middle;display:inline-block"><path d="M9 1L1 8h3v8h4v-5h2v5h4V8h3z" fill="#8B6542"/><rect x="7" y="11" width="4" height="5" fill="#7B9253"/></svg>',
  shield:'<svg viewBox="0 0 16 18" width=".8em" height=".9em" style="vertical-align:middle;display:inline-block"><path d="M8 1L2 4v5c0 4 3 7 6 8 3-1 6-4 6-8V4z" fill="#7B9253"/><path d="M8 4L5 6v3c0 2 1.5 3.5 3 4 1.5-.5 3-2 3-4V6z" fill="#8FD88F" opacity=".5"/></svg>',
  chart:'<svg viewBox="0 0 18 16" width=".9em" height=".85em" style="vertical-align:middle;display:inline-block"><rect x="1" y="10" width="4" height="5" rx="1" fill="#7B9253"/><rect x="7" y="6" width="4" height="9" rx="1" fill="#5D7040"/><rect x="13" y="2" width="4" height="13" rx="1" fill="#3D4A2B"/></svg>',
  phone:'<svg viewBox="0 0 14 18" width=".7em" height=".9em" style="vertical-align:middle;display:inline-block"><rect x="2" y="1" width="10" height="16" rx="2" fill="#78716C"/><rect x="3" y="3" width="8" height="10" rx="1" fill="#A8A29E"/><circle cx="7" cy="15" r="1" fill="#A8A29E"/></svg>',
  box:'<svg viewBox="0 0 18 16" width=".9em" height=".85em" style="vertical-align:middle;display:inline-block"><rect x="1" y="5" width="16" height="10" rx="2" fill="#D4956B"/><rect x="1" y="5" width="16" height="4" rx="2" fill="#C48B5C"/></svg>',
};
// Large plant SVGs for main weed card (80x90px, detailed)
const SP_LG={
  tree:'<svg viewBox="0 0 80 90" width="80" height="90"><rect x="34" y="58" width="12" height="28" rx="4" fill="#A0785A"/><ellipse cx="40" cy="48" rx="32" ry="28" fill="#C8E6C8" stroke="rgba(255,255,255,.5)" stroke-width="1"/><ellipse cx="40" cy="40" rx="26" ry="24" fill="#D8F0D8"/><ellipse cx="40" cy="34" rx="18" ry="18" fill="#E8F8E8"/><ellipse cx="30" cy="28" rx="7" ry="5" fill="rgba(255,255,255,.25)"/><circle cx="22" cy="44" r="4" fill="#F472B6" opacity=".7"/><circle cx="54" cy="38" r="3.5" fill="#FBBF24" opacity=".7"/><circle cx="36" cy="54" r="3" fill="#FB7185" opacity=".5"/><circle cx="48" cy="30" r="2.5" fill="#E879F9" opacity=".5"/><circle cx="28" cy="52" r="2" fill="#FBBF24" opacity=".4"/></svg>',
  vine:'<svg viewBox="0 0 72 90" width="72" height="90"><rect x="30" y="56" width="10" height="28" rx="3" fill="#A0785A"/><path d="M36 56Q14 44 22 18Q30 2 42 14Q54 2 62 18Q54 44 36 56" fill="#D8F0D8" stroke="rgba(255,255,255,.4)" stroke-width="1"/><path d="M36 56Q58 48 52 22Q48 6 36 14Q24 6 20 22Q14 48 36 56" fill="#C8E6C8"/><ellipse cx="28" cy="22" rx="5" ry="3.5" fill="rgba(255,255,255,.2)"/><circle cx="44" cy="26" r="3.5" fill="#B8C690" opacity=".5"/><circle cx="28" cy="40" r="2.5" fill="#F472B6" opacity=".5"/></svg>',
  thorn:'<svg viewBox="0 0 76 90" width="76" height="90"><rect x="32" y="54" width="10" height="28" rx="3" fill="#A0785A"/><path d="M38 54Q20 42 16 20Q24 6 38 16Q52 6 60 20Q56 42 38 54" fill="#C8DFC0" stroke="rgba(255,255,255,.4)" stroke-width="1"/><path d="M38 16Q32 32 38 46Q44 32 38 16" fill="#B8D0A8" opacity=".4"/><line x1="16" y1="32" x2="6" y2="26" stroke="#C8DFC0" stroke-width="4" stroke-linecap="round"/><line x1="60" y1="32" x2="70" y2="26" stroke="#C8DFC0" stroke-width="4" stroke-linecap="round"/><line x1="20" y1="44" x2="10" y2="44" stroke="#C8DFC0" stroke-width="3.5" stroke-linecap="round"/><line x1="56" y1="44" x2="66" y2="44" stroke="#C8DFC0" stroke-width="3.5" stroke-linecap="round"/><line x1="22" y1="22" x2="14" y2="16" stroke="#C8DFC0" stroke-width="3" stroke-linecap="round"/><line x1="54" y1="22" x2="62" y2="16" stroke="#C8DFC0" stroke-width="3" stroke-linecap="round"/></svg>',
  weed:'<svg viewBox="0 0 60 90" width="60" height="90"><rect x="26" y="52" width="8" height="28" rx="3" fill="#A0785A"/><path d="M30 52Q14 38 18 14Q26 2 30 18Q34 2 42 14Q46 38 30 52" fill="#D0ECD0" stroke="rgba(255,255,255,.4)" stroke-width="1"/><ellipse cx="22" cy="18" rx="5" ry="3.5" fill="rgba(255,255,255,.2)"/><circle cx="36" cy="24" r="2.5" fill="#B8C690" opacity=".5"/></svg>',
  seed:'<svg viewBox="0 0 50 90" width="50" height="90"><rect x="20" y="50" width="8" height="28" rx="3" fill="#A0785A"/><ellipse cx="24" cy="44" rx="14" ry="18" fill="#C8E6C8" stroke="rgba(255,255,255,.4)" stroke-width="1"/><ellipse cx="24" cy="36" rx="10" ry="14" fill="#E0F4E0"/><ellipse cx="20" cy="30" rx="4" ry="3" fill="rgba(255,255,255,.25)"/></svg>',
  dead:'<svg viewBox="0 0 52 80" width="52" height="80"><rect x="22" y="44" width="8" height="28" rx="3" fill="#A0785A"/><path d="M26 44Q12 34 18 16Q26 24 26 44" fill="#D4C0A0" opacity=".7"/><path d="M26 44Q40 34 34 16Q26 24 26 44" fill="#C4B090" opacity=".6"/></svg>',
};
// ── Main plant growth stages ─────────────────────────────────────────────────
// The hero card's art grows with watering % using the same bands as the
// garden legend: 0 / 5%+ / 25%+ / 50%+ / 75%+ / 100%. Bloom hue comes from
// the bill's tier so the flagship plant still reads as "the big one".
const MW_BLOOM={
  tree:{a:'#F472B6',b:'#F9A8D4'},
  vine:{a:'#C084FC',b:'#D8B4FE'},
  thorn:{a:'#FB923C',b:'#FDBA74'},
  weed:{a:'#38BDF8',b:'#7DD3FC'},
  seed:{a:'#FB7185',b:'#FDA4AF'},
};
const MW_STAGE_LABELS=['Seed','Sprout','Leafing','Budding','Blooming','Full bloom'];
function mwStage(pct,done){
  if(done||pct>=100)return 5;
  if(pct>=75)return 4;
  if(pct>=50)return 3;
  if(pct>=25)return 2;
  if(pct>=5)return 1;
  return 0;
}
const MW_GROUND='<ellipse cx="40" cy="80" rx="23" ry="8" fill="#8B6542"/><ellipse cx="40" cy="78" rx="19" ry="6.5" fill="#A0785A"/><ellipse cx="33" cy="75.5" rx="6" ry="2" fill="rgba(255,255,255,.18)"/>';
function mwSparkle(x,y,s,o){
  return '<path class="mw-sparkle" d="M'+x+' '+(y-s)+'L'+(x+s*.35)+' '+(y-s*.35)+'L'+(x+s)+' '+y+'L'+(x+s*.35)+' '+(y+s*.35)+'L'+x+' '+(y+s)+'L'+(x-s*.35)+' '+(y+s*.35)+'L'+(x-s)+' '+y+'L'+(x-s*.35)+' '+(y-s*.35)+'Z" fill="#FDE68A" opacity="'+o+'"/>';
}
function mwPetals(cx,cy,dist,r,c1,c2,n){
  let s='';
  for(let i=0;i<n;i++){
    const ang=-Math.PI/2+i*(Math.PI*2/n);
    const px=(cx+Math.cos(ang)*dist).toFixed(1),py=(cy+Math.sin(ang)*dist).toFixed(1);
    s+='<circle cx="'+px+'" cy="'+py+'" r="'+r+'" fill="'+(i%2?c2:c1)+'" opacity=".92"/>';
  }
  return s;
}
function mwLeafPair(y,w){
  return '<path d="M40 '+y+'Q'+(40-w)+' '+(y+1)+' '+(40-w-5)+' '+(y-9)+'Q'+(40-w+3)+' '+(y-11)+' 40 '+(y-4)+'Z" fill="#78A862"/>'
       +'<path d="M40 '+y+'Q'+(40+w)+' '+(y+1)+' '+(40+w+5)+' '+(y-9)+'Q'+(40+w-3)+' '+(y-11)+' 40 '+(y-4)+'Z" fill="#4E8A45"/>';
}
function mwStageArt(tierKey,pct,done){
  const st=mwStage(pct,done);
  const c=MW_BLOOM[tierKey]||MW_BLOOM.weed;
  const sway=st>=2?' class="mw-sway"':'';
  const open='<svg viewBox="0 0 80 90" width="80" height="90"'+sway+' style="overflow:visible">';
  const close='</svg>';
  if(st===0){
    return open
      +'<ellipse cx="40" cy="72" rx="24" ry="12" fill="#8B6542"/>'
      +'<ellipse cx="40" cy="69" rx="20" ry="10" fill="#A0785A"/>'
      +'<ellipse cx="32" cy="65" rx="7" ry="3" fill="rgba(255,255,255,.2)"/>'
      +'<ellipse cx="40" cy="60" rx="7" ry="9" fill="#F5E6C8" stroke="rgba(255,255,255,.5)" stroke-width="1"/>'
      +'<path d="M36.5 58Q40 61.5 43.5 58" stroke="#C4956B" stroke-width="1.5" fill="none" stroke-linecap="round"/>'
      +mwSparkle(22,42,4,.85)+mwSparkle(57,34,3,.7)
      +close;
  }
  if(st===1){
    return open+MW_GROUND
      +'<path d="M40 77Q39.5 68 40 60" stroke="#4E8A45" stroke-width="4.5" stroke-linecap="round" fill="none"/>'
      +'<path d="M40 60Q30 60 25 50Q35 47 40 56Z" fill="#78A862"/>'
      +'<path d="M40 60Q50 60 55 50Q45 47 40 56Z" fill="#4E8A45"/>'
      +'<ellipse cx="30" cy="53" rx="2.5" ry="1.5" fill="rgba(255,255,255,.45)"/>'
      +mwSparkle(58,36,3,.7)
      +close;
  }
  if(st===2){
    return open+MW_GROUND
      +'<path d="M40 77Q39 60 40 42" stroke="#4E8A45" stroke-width="5" stroke-linecap="round" fill="none"/>'
      +mwLeafPair(66,13)+mwLeafPair(54,10)
      +'<ellipse cx="40" cy="40" rx="6" ry="8" fill="#78A862"/>'
      +'<ellipse cx="40" cy="38" rx="4" ry="5.5" fill="#A5CC8E"/>'
      +mwSparkle(58,30,3,.7)
      +close;
  }
  if(st===3){
    return open+MW_GROUND
      +'<path d="M40 77Q39 58 40 36" stroke="#4E8A45" stroke-width="5" stroke-linecap="round" fill="none"/>'
      +mwLeafPair(66,13)+mwLeafPair(52,10)
      +'<ellipse cx="40" cy="26" rx="8.5" ry="11" fill="'+c.b+'"/>'
      +'<ellipse cx="40" cy="27.5" rx="6" ry="9" fill="'+c.a+'" opacity=".85"/>'
      +'<ellipse cx="37" cy="20" rx="2.5" ry="3.5" fill="rgba(255,255,255,.5)"/>'
      +'<path d="M40 37Q31 35 30 26Q36 28 40 34Z" fill="#4E8A45"/>'
      +'<path d="M40 37Q49 35 50 26Q44 28 40 34Z" fill="#78A862"/>'
      +mwSparkle(59,40,3,.7)
      +close;
  }
  if(st===4){
    return open+MW_GROUND
      +'<path d="M40 77Q39 58 40 38" stroke="#4E8A45" stroke-width="5" stroke-linecap="round" fill="none"/>'
      +mwLeafPair(66,13)+mwLeafPair(52,10)
      +mwPetals(40,26,10,8,c.a,c.b,6)
      +'<circle cx="40" cy="26" r="6" fill="#FBBF24"/>'
      +'<circle cx="40" cy="26" r="2.5" fill="#FDE68A"/>'
      +mwSparkle(62,44,3.5,.8)
      +close;
  }
  return open+MW_GROUND
    +'<path d="M40 76Q28 70 22 59" stroke="#4E8A45" stroke-width="3.5" stroke-linecap="round" fill="none"/>'
    +'<path d="M40 76Q52 70 58 63" stroke="#4E8A45" stroke-width="3.5" stroke-linecap="round" fill="none"/>'
    +'<path d="M40 77Q39 56 40 36" stroke="#4E8A45" stroke-width="5" stroke-linecap="round" fill="none"/>'
    +mwLeafPair(64,12)
    +mwPetals(21,54,4.5,3.8,c.b,c.a,5)
    +'<circle cx="21" cy="54" r="2.4" fill="#FBBF24"/>'
    +mwPetals(59,58,4.5,3.8,c.b,c.a,5)
    +'<circle cx="59" cy="58" r="2.4" fill="#FBBF24"/>'
    +mwPetals(40,24,12,9.5,c.a,c.b,6)
    +'<circle cx="40" cy="24" r="7" fill="#FBBF24"/>'
    +'<circle cx="40" cy="24" r="3.5" fill="#FDE68A"/>'
    +mwSparkle(66,32,4,.85)+mwSparkle(12,34,3,.7)+mwSparkle(64,72,3,.6)
    +close;
}
let _prevMwStage=null; // {id,st} — used to pop the sprite when a stage is reached

// ── Small-plant growth stages (compact, 3 bands) ────────────────────────────
// List rows and the Growth-tab garden scene grow through sprout / bud / bloom
// using the same geometry family as mwStageArt, shrunk to list size. Bloom hue
// comes from the bill's tier (MW_BLOOM) so small plants match the hero card.
// Bands: <50% sprout · 50–99% bud · 100% bloom.
function smStage(pct,done){
  if(done||pct>=100)return 2;
  if(pct>=50)return 1;
  return 0;
}
const SM_STAGE_LABELS=['Sprout','Bud','Bloom'];
function smStageArt(tierKey,pct,done){
  const st=smStage(pct,done);
  const c=MW_BLOOM[tierKey]||MW_BLOOM.weed;
  const open='<svg viewBox="0 0 32 38" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block;overflow:visible">';
  const close='</svg>';
  const ground='<ellipse cx="16" cy="34" rx="9" ry="3" fill="#8B6542"/><ellipse cx="16" cy="33.2" rx="7" ry="2.2" fill="#A0785A"/>';
  if(st===0){
    // sprout — short stem, two young leaves (dark greens for light backgrounds)
    return open+ground
      +'<path d="M16 33Q15.8 28 16 23" stroke="#5D7040" stroke-width="2.2" stroke-linecap="round" fill="none"/>'
      +'<path d="M16 23Q10 23 7 17Q13 15.5 16 21Z" fill="#7B9253"/>'
      +'<path d="M16 23Q22 23 25 17Q19 15.5 16 21Z" fill="#3D4A2B"/>'
      +close;
  }
  if(st===1){
    // bud — taller stem, leaf pair, closed tier-colored bud
    return open+ground
      +'<path d="M16 33Q15.6 25 16 17" stroke="#5D7040" stroke-width="2.4" stroke-linecap="round" fill="none"/>'
      +'<path d="M16 28Q10.5 28 8 22.5Q13.5 21.5 16 26Z" fill="#7B9253"/>'
      +'<path d="M16 28Q21.5 28 24 22.5Q18.5 21.5 16 26Z" fill="#3D4A2B"/>'
      +'<ellipse cx="16" cy="12.5" rx="4.4" ry="5.6" fill="'+c.b+'"/>'
      +'<ellipse cx="16" cy="13.4" rx="2.9" ry="4.1" fill="'+c.a+'" opacity=".85"/>'
      +close;
  }
  // bloom — open tier-colored flower with gold center
  return open+ground
    +'<path d="M16 33Q15.6 24 16 16" stroke="#5D7040" stroke-width="2.4" stroke-linecap="round" fill="none"/>'
    +'<path d="M16 27Q10.5 27 8 21.5Q13.5 20.5 16 25Z" fill="#7B9253"/>'
    +'<path d="M16 27Q21.5 27 24 21.5Q18.5 20.5 16 25Z" fill="#3D4A2B"/>'
    +mwPetals(16,11,5.2,4.3,c.a,c.b,6)
    +'<circle cx="16" cy="11" r="3.1" fill="#FBBF24"/>'
    +'<circle cx="16" cy="11" r="1.4" fill="#FDE68A"/>'
    +close;
}

function getTier(amt){
  if(amt>=1000)return{key:'tree',label:'Queen of the Night',sprite:smStageArt('tree',100,true),spriteD:smStageArt('tree',100,true),sway:true};
  if(amt>=400)return{key:'vine',label:'Moonflower',sprite:smStageArt('vine',100,true),spriteD:smStageArt('vine',100,true),sway:true};
  if(amt>=150)return{key:'thorn',label:'Night Phlox',sprite:smStageArt('thorn',100,true),spriteD:smStageArt('thorn',100,true),sway:false};
  if(amt>=50)return{key:'weed',label:'Evening Primrose',sprite:smStageArt('weed',100,true),spriteD:smStageArt('weed',100,true),sway:false};
  return{key:'seed',label:'Four O’Clock',sprite:smStageArt('seed',100,true),spriteD:smStageArt('seed',100,true),sway:false};
}

// Celebration content per tier
function pick(arr){return arr[Math.floor(Math.random()*arr.length)]}

function getCelebration(bill,tier){
  // The message is set with innerHTML (it carries the IC.* SVG icons), so the
  // bill name is escaped here; every other name in the app goes through esc()
  // at the render site.
  const n=esc(bill.name);
  const pools={
    tree:[
      {emoji:IC.trophy,title:'Queen of the Night in Bloom!',msg:`The mighty ${n} has reached full bloom. That was a BIG one. Your garden is flourishing. ${IC.butterfly}`},
      {emoji:IC.crown,title:'Tallest Plant Blooming!',msg:`${n} is in full bloom thanks to your hustle energy this month. You absolute powerhouse. ${IC.party}`},
      {emoji:IC.star,title:'The Big One is Blooming!',msg:`${n} fully watered. That's the one that takes the most out of you, and you handled it. ${IC.sparkle}`},
      {emoji:IC.party,title:'Queen of the Night Bloomed!',msg:`${n} is in full bloom! Your biggest plant is done for the month. Take a breath. You earned it. ${IC.muscle}`},
    ],
    vine:[
      {emoji:IC.butterfly,title:'Moonflower in Bloom!',msg:`${n} is blooming in your garden this month. Look at those flowers! ${IC.party}`},
      {emoji:IC.heart,title:'Moonflower Bloomed!',msg:`${n} is fully watered and thriving. Your hustle made it happen! ${IC.leaf}`},
      {emoji:IC.star,title:'Moonflower Handled!',msg:`${n} is taken care of for the month. One more plant thriving. ${IC.leaf}`},
    ],
    thorn:[
      {emoji:IC.fire,title:'Night Phlox in Bloom!',msg:`${n} has bloomed this month. That's a tough one handled! Keep going. ${IC.muscle}`},
      {emoji:IC.star,title:'Night Phlox Bloomed!',msg:`${n} is done! Your hustle is working. ${IC.sparkle}`},
      {emoji:IC.muscle,title:'Night Phlox Handled!',msg:`${n} couldn't stand up to your side income. In full bloom! ${IC.leaf}`},
    ],
    weed:[
      {emoji:IC.butterfly,title:'Evening Primrose Blooming!',msg:`${n} is blooming this month. Your garden is thriving! ${IC.butterfly}`},
      {emoji:IC.heart,title:'Another One Blooming!',msg:`${n} handled! You're on a roll. Keep those payments coming. ${IC.heart}`},
      {emoji:IC.star,title:'In Full Bloom!',msg:`${n} is fully watered for the month. Small wins add up to big freedom. ${IC.sparkle}`},
      {emoji:IC.party,title:'Bloomed!',msg:`${n} is fully watered. That's how it's done! ${IC.leaf}`},
    ],
    seed:[
      {emoji:IC.butterfly,title:'Four O’Clock Bloomed!',msg:`${n} handled! The small ones add up. Every payment matters. ${IC.sparkle}`},
      {emoji:IC.star,title:'Tiny Bloom!',msg:`${n} is done! Even the little ones feel good to check off. ${IC.ladybug}`},
      {emoji:IC.heart,title:'Four O’Clock Flourishing!',msg:`${n} is fully watered this month. Your garden is growing! ${IC.heart}`},
    ],
  };
  return pick(pools[tier.key]||pools.seed);
}

let bills=[],payments=[],monthlyAmounts={},confettiRAF=null,currentUser=null,userGoal=0;
let billsLoaded=false; // true once loadAll() has fetched this account's bills
let authMode='login';
let viewMonth=null; // null = current month

// ── ONBOARDING ─────────────────────────────────────────────────────────────────
// Two steps: the intro, then (only for an account with no bills yet) "What's
// your biggest monthly bill?", which plants it through the same addBill() path
// the Bills tab uses. Each step owns one history entry, tagged `onboard`, so
// Back from the question returns to the intro and Back from the intro closes
// the pop-up. The question is gated on billsLoaded so
// an existing account on a new device (no localStorage flag) is never asked.
let shgOnboardPlanted=false;
function maybeShowOnboard(){
  const seen=localStorage.getItem('garden_onboard_seen');
  if(!seen){
    showOnboardStep('intro');
    document.getElementById('onboard-overlay').style.display='flex';
    pushOverlayState();
    history.replaceState({...history.state,onboard:'intro'},'',location.pathname+location.search);
  }
  // Already past onboarding: the tour has the screen to itself.
  else setTimeout(maybeOfferTour, 400);
}
function onboardStep(){
  const b=document.getElementById('onboard-bill');
  return b&&b.style.display!=='none'?'bill':'intro';
}
function showOnboardStep(step){
  const intro=document.getElementById('onboard-intro'),bill=document.getElementById('onboard-bill');
  if(!intro||!bill)return;
  intro.style.display=step==='bill'?'none':'';
  bill.style.display=step==='bill'?'':'none';
  if(step==='bill'){const h=document.getElementById('onboard-bill-h');if(h)h.focus();}
  else{const g=document.getElementById('onboard-go');if(g)g.focus();}
}
// "Let's grow!": move on to the bill question, or close when there's nothing
// to ask (bills already planted, or the account hasn't finished loading).
function onboardNext(){
  const activeBills=bills.filter(b=>!b.archived);
  if(!billsLoaded||activeBills.length){closeOnboard();return}
  sgOverlayDepth++;
  history.pushState({...(history.state||{}),view:currentTab,month:viewMonth,sgOverlay:sgOverlayDepth,onboard:'bill'},'',location.pathname+location.search);
  showOnboardStep('bill');
}
async function onboardPlant(){
  const planted=await addBill({nameId:'ob-name',amtId:'ob-amt',btnId:'ob-plant-btn',btnLabel:'Plant it',type:'other',repeats:true});
  if(planted){shgOnboardPlanted=true;closeOnboard();}
}
function closeOnboard(fromHistory){
  if (fromHistory !== true) {
    // From the question step two entries belong to the pop-up (intro +
    // question); unwind both so Back afterwards doesn't reopen it.
    if (onboardStep()==='bill' && (history.state||{}).onboard==='bill') { history.go(-2); return; }
    if (closeOverlayViaHistory()) return;
  }
  document.getElementById('onboard-overlay').style.display='none';
  showOnboardStep('intro');
  localStorage.setItem('garden_onboard_seen','1');
  setTimeout(maybeOfferTour, 350);
}

// ── HELP PANEL ─────────────────────────────────────────────────────────────────
// Re-openable forever from the ? in the header. Routes through the overlay
// history helpers so Back and Escape close it instead of leaving the app.
function openHelp(){
  const m = document.getElementById('help-modal');
  if (!m) return;
  const body = m.querySelector('.help-body');
  if (body) body.scrollTop = 0;
  m.style.display = 'flex';
  pushOverlayState();
  const done = m.querySelector('.help-done');
  if (done) done.focus();
}
// fromHistory=true means popstate is already unwinding the entry — hide
// directly, or calling history.back() again would loop.
function closeHelp(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  const m = document.getElementById('help-modal');
  if (m) m.style.display = 'none';
}

// ── GUIDED TOUR ────────────────────────────────────────────────────────────────
// Each stop highlights a real element with a ring and pins an explainer to the
// bottom. Takes exactly ONE history entry for the whole run, so Back ends the
// tour and leaves you on the app; per-stop entries would replay it backwards.
const TOUR_STOPS = [
  { tab: null, sel: null, text: "new here? let me show you around the garden. five quick stops, or skip any time." },
  { tab: 'garden', sel: '#tab-garden', text: "this is the garden. every plant is one of your bills, and how grown it is shows how much of that bill your income has covered this month." },
  { tab: 'bills', sel: '#tab-bills', text: "plant your bills here. name, monthly amount, and what the plant looks like. start with your smallest one, it blooms soonest." },
  { tab: 'water', sel: '#tab-water', text: "when money comes in, water the garden. it goes to the smallest bill first, and you see the order before you commit." },
  { tab: 'growth', sel: '#tab-growth', text: "growth is the history: how much of your bills your side hustle has covered, month over month." },
  { tab: 'forecast', sel: '#tab-forecast', text: "forecast projects the next 6 months. that one's Pro. the ? up top reopens this any time." },
];
function tourSeen(){ try { return localStorage.getItem('garden_tour_done') === '1'; } catch { return false; } }
function tourMarkSeen(){ try { localStorage.setItem('garden_tour_done','1'); } catch {} }
let shgTourStep;
function startTour(){
  endTour();
  shgTourStep = 0;
  pushOverlayState();
  renderTourStep();
}
function endTour(fromHistory){
  if (shgTourStep === undefined) return;
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  shgTourStep = undefined;
  tourMarkSeen();
  const b = document.getElementById('tourbox'); if (b) b.remove();
  const r = document.getElementById('tourring'); if (r) r.remove();
}
function renderTourStep(){
  const n = shgTourStep, stop = TOUR_STOPS[n];
  if (!stop) return endTour();
  const show = () => {
    const ob = document.getElementById('tourbox'); if (ob) ob.remove();
    const or = document.getElementById('tourring'); if (or) or.remove();
    if (stop.sel) {
      const el = document.querySelector(stop.sel);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const ring = document.createElement('div');
        ring.id = 'tourring';
        ring.style.cssText = `left:${r.left-6}px;top:${r.top-6}px;width:${r.width+12}px;height:${r.height+12}px;`;
        document.body.appendChild(ring);
      }
    }
    const last = n === TOUR_STOPS.length - 1;
    const box = document.createElement('div');
    box.id = 'tourbox';
    box.setAttribute('role','dialog');
    box.setAttribute('aria-label','App tour');
    box.innerHTML = `<p>${esc(stop.text)}</p><div class="tourrow">`+
      `<span class="tourcount">${n===0?'':`${n} of ${TOUR_STOPS.length-1}`}</span>`+
      `<button type="button" class="tourbtn ghost" id="tour-skip">${last?'Done':n===0?'No thanks':'Skip'}</button>`+
      (last?'':`<button type="button" class="tourbtn" id="tour-next">${n===0?'Show me':'Next'}</button>`)+
      `</div>`;
    document.body.appendChild(box);
    document.getElementById('tour-skip').onclick = () => endTour();
    const next = document.getElementById('tour-next');
    if (next) { next.onclick = () => { shgTourStep = n + 1; renderTourStep(); }; next.focus(); }
  };
  // Switch tab first; the highlight target renders with the tab. fromHistory=true
  // so tab moves never stack entries on top of the tour's single overlay entry.
  if (stop.tab && currentTab !== stop.tab) { goTab(stop.tab, true); setTimeout(show, 80); }
  else show();
}
// Offered once, and only to an account with nothing planted yet.
function maybeOfferTour(){
  if (tourSeen()) return;
  // A bill planted from the welcome question doesn't count: that account is
  // still brand new and gets the tour.
  if (!shgOnboardPlanted && (typeof bills !== 'undefined' && bills && bills.length)) { tourMarkSeen(); return; }
  startTour();
}

// ── MONTH SWITCHER ─────────────────────────────────────────────────────────────
// setViewMonth() is the single choke point for the garden/growth month
// filter view — same pushState/popstate pattern as goTab(). `fromHistory` is
// set only by the popstate handler below (loop guard); every other caller
// (prevMonth/nextMonth/backToCurrentMonth/viewHarvestMonth) pushes.
function getViewMonth(){return viewMonth||CM();}
function setViewMonth(month,fromHistory){
  if(!fromHistory&&month===viewMonth)return; // no-op: already on this month
  viewMonth=month;
  renderGarden();renderGrowth();renderBillList();
  if(!fromHistory)pushViewState();
}
function prevMonth(){
  const[y,m]=getViewMonth().split('-').map(Number);
  const d=new Date(y,m-2,1);
  const earliest=payments.length?payments.reduce((min,p)=>p.month<min?p.month:min,payments[0].month):CM();
  if(ym(d)<earliest)return;
  setViewMonth(ym(d));
}
function nextMonth(){
  const[y,m]=getViewMonth().split('-').map(Number);
  const next=new Date(y,m,1);
  if(ym(next)>CM())return;
  setViewMonth(ym(next));
}
function backToCurrentMonth(){setViewMonth(null);}
// The month switcher shared by the Garden and Growth tabs. Arrows that cannot
// go anywhere are real disabled buttons (not pointer-events:none), so a
// keyboard or screen-reader user is told instead of pressing a dead control.
function monthSwitcherHtml(vm){
  const[y,m]=vm.split('-').map(Number);
  const earliest=payments.length?payments.reduce((min,p)=>p.month<min?p.month:min,payments[0].month):CM();
  const canPrev=ym(new Date(y,m-2,1))>=earliest;
  const canNext=vm<CM();
  const btn=(act,ch,on,lbl)=>`<button type="button" data-action="${act}" aria-label="${lbl}" ${on?'':'disabled aria-disabled="true"'} style="background:none;border:none;font-size:16px;cursor:${on?'pointer':'default'};padding:4px 8px;${on?'':'opacity:.3'}">${ch}</button>`;
  return `<div class="month-switcher">${btn('prevMonth','‹',canPrev,'Previous month')}<span style="font-family:var(--serif);font-size:14px;font-weight:600;color:var(--sage-d)">${ymLabel(vm)}</span>${btn('nextMonth','›',canNext,'Next month')}</div>`
    +(vm!==CM()?'<div style="text-align:center;margin-bottom:8px"><button type="button" class="btn btn-sm" style="background:var(--bg2);color:var(--sage-d);border:1px solid var(--sage);font-size:10px;padding:4px 12px" data-action="backToCurrentMonth">↩ back to current month</button></div>':'');
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
// Pre-auth screen has real steps (login<->signup tabs, forgot-password
// reveal, verify-code box) — each one pushes so Back walks back through
// them; only the final Back (past the initial replaceState landing) leaves
// the site. Mirrors goTab()/pushViewState()'s choke-point pattern exactly.
let currentAuthView='login';
function pushAuthView(view,replace){
  const state={authView:view,mode:authMode,email:verifyPendingEmail};
  const url=location.pathname+location.search;
  if(replace)history.replaceState(state,'',url);else history.pushState(state,'',url);
}
function switchAuthTab(mode,fromHistory){
  if(!fromHistory&&mode===currentAuthView)return; // no-op: already on this tab
  currentAuthView=mode;
  authMode=mode;
  document.querySelectorAll('.auth-tab').forEach((t,i)=>t.classList.toggle('active',['login','signup'][i]===mode));
  document.getElementById('auth-btn').textContent=mode==='login'?'Enter the garden':'Create my garden';
  document.getElementById('auth-err').style.display='none';
  document.getElementById('auth-suc').style.display='none';
  document.getElementById('forgot-wrap').style.display=mode==='login'?'block':'none';
  document.getElementById('forgot-form').style.display='none';
  document.getElementById('signup-privacy-note').style.display=mode==='signup'?'block':'none';
  const pwHint=document.getElementById('auth-pw-hint');
  if(pwHint)pwHint.style.display=mode==='signup'?'block':'none';
  // Confirm-password only matters on sign up. Hide + clear it on login so a
  // stale value can't block a later sign up.
  const pw2Wrap=document.getElementById('auth-pw2-wrap');
  if(pw2Wrap)pw2Wrap.style.display=mode==='signup'?'block':'none';
  const pw2=document.getElementById('auth-pw2');
  if(pw2&&mode==='login')pw2.value='';
  document.getElementById('auth-pw').autocomplete=mode==='login'?'current-password':'new-password';
  // move login gnome: login tab = left quarter, signup tab = right quarter
  const gnome=document.getElementById('login-gnome');
  if(gnome)gnome.style.left=mode==='login'?'calc(25% - 32px)':'calc(75% - 32px)';
  if(!fromHistory)pushAuthView(mode);
}

// reuseEntry=true: swapping one modal for another (closeDeleteAndOpenPrivacy)
// reuses the entry the first modal already pushed, so the pair costs one Back
// press, not two.
function openPrivacy(reuseEntry){
  const m=document.getElementById('privacy-modal');
  m.style.display='flex';
  m.scrollTop=0;
  // Show the data-export button only when the user is signed in.
  const row=document.getElementById('export-row');
  if(row)row.style.display=currentUser?'flex':'none';
  const st=document.getElementById('export-status');if(st)st.textContent='';
  if(reuseEntry!==true)pushOverlayState();
}
function closePrivacy(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  document.getElementById('privacy-modal').style.display='none';
}
function openPrivacyDoNotSell(){
  openPrivacy();
  setTimeout(()=>{
    const e=document.getElementById('do-not-sell');
    if(e)e.scrollIntoView({behavior:'smooth'});
  },80);
}
// Deleting an account asks for the current password.
async function openDeleteAccount(){
  const m=document.getElementById('delete-modal');
  m.style.display='flex';
  document.getElementById('delete-pw').value='';
  document.getElementById('delete-err').style.display='none';
  pushOverlayState();
  const f=document.getElementById('delete-pw');
  if(f&&m.style.display!=='none')f.focus();
}
function closeDeleteAccount(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  document.getElementById('delete-modal').style.display='none';
}
// Swap, not a close-then-open: hide directly (fromHistory=true) and let the
// privacy modal inherit the entry the delete modal already pushed.
function closeDeleteAndOpenPrivacy(){closeDeleteAccount(true);openPrivacy(true);}

async function downloadMyData(){
  const btn=document.getElementById('export-btn'),st=document.getElementById('export-status');
  if(!btn)return;
  btn.disabled=true;st.textContent='Preparing…';
  try{
    const r=await fetch('/api/account/export',{credentials:'same-origin'});
    if(!r.ok){st.textContent='Export failed (HTTP '+r.status+').';btn.disabled=false;return;}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download='garden-export-'+todayStr()+'.json';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    st.textContent='Downloaded.';
  }catch(e){st.textContent='Export failed.';}
  btn.disabled=false;
}

async function submitDeleteAccount(){
  const errEl=document.getElementById('delete-err');
  errEl.style.display='none';
  const pw=document.getElementById('delete-pw').value;
  if(!pw){errEl.textContent='Please enter your current password.';errEl.style.display='block';return;}
  const body={current_password:pw};
  const btn=document.getElementById('delete-confirm-btn');
  btn.disabled=true;btn.textContent='Deleting…';
  try{
    const r=await fetch('/api/me',{
      method:'DELETE',
      credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),
    });
    const d=await r.json().catch(()=>null);
    if(!r.ok){
      errEl.textContent=(d&&d.error)||'Could not delete account.';
      errEl.style.display='block';
      btn.disabled=false;btn.textContent='Delete forever';
      return;
    }
    // Success — the Worker cleared the session cookie. Clear the rest and
    // reload to the auth screen.
    try{localStorage.removeItem('garden_token');}catch(e){}
    closeDeleteAccount();
    location.replace('/');
  }catch(e){
    errEl.textContent='Network error. Try again.';errEl.style.display='block';
    btn.disabled=false;btn.textContent='Delete forever';
  }
}

function showForgot(fromHistory){
  if(!fromHistory&&currentAuthView==='forgot')return; // no-op: already showing forgot
  currentAuthView='forgot';
  document.getElementById('forgot-form').style.display='block';
  document.getElementById('forgot-wrap').style.display='none';
  const email=document.getElementById('auth-email').value;
  if(email)document.getElementById('reset-email').value=email;
  if(!fromHistory)pushAuthView('forgot');
}

async function sendReset(){
  const email=document.getElementById('reset-email').value.trim();
  if(!email)return;
  const{error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin});
  const sucEl=document.getElementById('auth-suc');
  if(error){
    const errEl=document.getElementById('auth-err');errEl.textContent=error.message;errEl.style.display='block';
  }else{
    sucEl.textContent='Reset email sent! Check your inbox.';sucEl.style.display='block';
    document.getElementById('forgot-form').style.display='none';
  }
}

async function authSubmit(){
  const email=document.getElementById('auth-email').value.trim();
  const pw=document.getElementById('auth-pw').value;
  const errEl=document.getElementById('auth-err'),sucEl=document.getElementById('auth-suc'),btn=document.getElementById('auth-btn');
  errEl.style.display='none';sucEl.style.display='none';
  if(!email||!pw){errEl.textContent='Please enter your email and password.';errEl.style.display='block';return}
  if(authMode==='signup'&&(pw.length<10||pw.length>200)){
    errEl.textContent='Password must be 10–200 characters.';errEl.style.display='block';return;
  }
  if(authMode==='signup'&&pw!==(document.getElementById('auth-pw2')||{}).value){
    errEl.textContent='Passwords do not match. Please re-type them.';errEl.style.display='block';return;
  }
  btn.disabled=true;btn.textContent='...';
  if(authMode==='signup'){
    const{data,error}=await sb.auth.signUp({email,password:pw});
    if(error){errEl.textContent=error.message;errEl.style.display='block';}
    else{
      // New signups always need a code. Show the code box prefilled to this email.
      // The password rides along in memory only, sent with the code.
      showVerifyCodeBox(email,false,pw);
      // email_sent is false only when the mail provider refused the code; say
      // so instead of promising an inbox that has nothing in it.
      if(data&&data.email_sent===false){errEl.textContent=MAIL_FAIL_MSG;errEl.style.display='block';sucEl.style.display='none';}
      else{sucEl.textContent=(data&&data.message)||'Check your inbox for a 6-digit code.';sucEl.style.display='block';}
    }
  }else{
    const{data,error}=await sb.auth.signInWithPassword({email,password:pw});
    if(error){
      if(error.code==='email_not_verified'){
        errEl.textContent='Please verify your email to continue.';errEl.style.display='block';
        showVerifyCodeBox(error.email||email,false,pw);
      }else{errEl.textContent=error.message;errEl.style.display='block';}
    }
    else{currentUser=data.user;showApp();}
  }
  btn.disabled=false;btn.textContent=authMode==='login'?'Enter the garden':'Create my garden';
}

// Reveal the 6-digit code entry box for `email`, hiding the password fields.
// verifyPendingPw holds the password typed at signup/login in memory only
// (never storage). The Worker needs it with the code. If the code box is
// reached without one (Back/Forward after a reload), a password field shows.
let verifyPendingEmail='';
let verifyPendingPw='';
const MAIL_FAIL_MSG="We couldn't send your code right now. Try Resend code in a minute, or contact support.";
function showVerifyCodeBox(email,fromHistory,pw){
  if(!fromHistory&&currentAuthView==='verify')return; // no-op: already showing verify
  currentAuthView='verify';
  verifyPendingEmail=(email||'').trim().toLowerCase();
  verifyPendingPw=typeof pw==='string'?pw:'';
  const set=(id,disp)=>{const e=document.getElementById(id);if(e)e.style.display=disp;};
  document.getElementById('verify-code-email').textContent=verifyPendingEmail;
  set('verify-code-box','block');
  const vpw=document.getElementById('verify-pw-input');if(vpw)vpw.value='';
  set('verify-pw-wrap',verifyPendingPw?'none':'block');
  // Hide the password-based controls while the user enters their code.
  set('auth-pw','none');
  const pwLabel=document.querySelector('label[for="auth-pw"]');if(pwLabel&&pwLabel.parentElement)pwLabel.parentElement.style.display='none';
  set('auth-btn','none');
  set('forgot-wrap','none');
  set('signup-privacy-note','none');
  document.querySelector('.auth-tabs')&&(document.querySelector('.auth-tabs').style.display='none');
  const input=document.getElementById('verify-code-input');if(input){input.value='';input.focus();}
  if(!fromHistory)pushAuthView('verify');
}

// DOM-only reversal of showVerifyCodeBox — no history side effects. Shared by
// hideVerifyCodeBox() (a real user action, which then hands off to whatever
// pushes next) and restoreAuthView() (popstate baseline reset) so the two
// never fight over history entries.
function hideVerifyCodeBoxDom(){
  verifyPendingEmail='';
  verifyPendingPw='';
  const vpw=document.getElementById('verify-pw-input');if(vpw)vpw.value='';
  const set=(id,disp)=>{const e=document.getElementById(id);if(e)e.style.display=disp;};
  set('verify-code-box','none');
  const pwLabel=document.querySelector('label[for="auth-pw"]');if(pwLabel&&pwLabel.parentElement)pwLabel.parentElement.style.display='block';
  set('auth-pw','block');
  set('auth-btn','block');
  document.querySelector('.auth-tabs')&&(document.querySelector('.auth-tabs').style.display='flex');
}
function hideVerifyCodeBox(){
  hideVerifyCodeBoxDom();
  // Silent: this is a DOM sync back to the current tab, not a real
  // navigation. Callers (tabTo(), submitVerifyCode()) always follow up with
  // their own real (pushing) transition — switchAuthTab() or showApp().
  switchAuthTab(authMode,true);
}

async function submitVerifyCode(){
  const code=document.getElementById('verify-code-input').value.replace(/\D/g,'');
  const errEl=document.getElementById('auth-err'),sucEl=document.getElementById('auth-suc'),btn=document.getElementById('verify-code-btn');
  errEl.style.display='none';
  if(code.length!==6){errEl.textContent='Enter the 6-digit code from your email.';errEl.style.display='block';return;}
  const vpw=document.getElementById('verify-pw-input');
  const pw=verifyPendingPw||(vpw?vpw.value:'');
  if(!pw){
    const w=document.getElementById('verify-pw-wrap');if(w)w.style.display='block';
    errEl.textContent='Enter your password along with the code.';errEl.style.display='block';if(vpw)vpw.focus();return;
  }
  btn.disabled=true;btn.textContent='Verifying...';
  const{data,error}=await sb.auth.verifyCode(verifyPendingEmail,code,pw);
  if(error){
    // A password mismatch means the one in memory is wrong for this account,
    // so drop it and show the field to retype.
    if(/password/i.test(error.message||'')){verifyPendingPw='';const w=document.getElementById('verify-pw-wrap');if(w)w.style.display='block';}
    errEl.textContent=error.message;errEl.style.display='block';
    btn.disabled=false;btn.textContent='Verify and enter';
    return;
  }
  // Verified + session issued — boot straight into the app, same as login.
  sucEl.style.display='none';
  currentUser=data.user;
  hideVerifyCodeBox();
  showApp();
}

async function resendVerifyEmail(email){
  const{data,error}=await sb.auth.resendVerification(email||verifyPendingEmail);
  const sucEl=document.getElementById('auth-suc'),errEl=document.getElementById('auth-err');
  if(error){errEl.textContent=error.message;errEl.style.display='block';}
  else if(data&&data.email_sent===false){errEl.textContent=MAIL_FAIL_MSG;errEl.style.display='block';sucEl.style.display='none';}
  else{sucEl.textContent='A new code is on its way. Check your inbox.';sucEl.style.display='block';errEl.style.display='none';}
}

// Shared by logout() and sessionEnded(): hide the garden, show the login
// screen in place, and collapse history to a clean auth landing state.
// Without the replaceState, the tab entries pushed during the session are
// still on top of the stack; a Back press would pop one of them and, with the
// app DOM hidden, that's a dead click.
function showLoginScreen(){
  currentUser=null;bills=[];payments=[];monthlyAmounts={};billsLoaded=false;
  sgOverlayDepth=0;
  showLoadBanner('');
  document.getElementById('app-screen').classList.remove('visible');
  document.getElementById('auth-screen').style.display='flex';
  document.getElementById('auth-pw').value='';
  hideFeedbackWidget();
  hideVerifyCodeBoxDom();
  switchAuthTab('login',true);
  pushAuthView('login',true);
}
async function logout(){
  await sb.auth.signOut();
  showLoginScreen();
}
// A session that is no longer good (expired, or revoked by a sign-out on
// another device) ends in place: every overlay closed, the login screen shown,
// one plain message. No reload, so the message survives and a token the server
// already rejected is never replayed. garden-api.js emits SESSION_ENDED on the
// first 401 from a non-auth route.
const SESSION_ENDED_MSG='Your session ended. Log in again.';
function sessionEnded(){
  if(!currentUser)return; // not in the app (boot-time check); the login screen is already up
  try{closeAllOverlays();}catch(e){/* nothing open */}
  showLoginScreen();
  const el=document.getElementById('auth-err');el.textContent=SESSION_ENDED_MSG;el.style.display='block';
  document.getElementById('auth-suc').style.display='none';
}
// The load-failure banner above the tabs. Shown by loadAll() when the first
// data load fails, on every tab, with a Retry; hidden again on success.
function showLoadBanner(msg){
  const b=document.getElementById('load-banner'),t=document.getElementById('load-banner-msg');
  if(!b||!t)return;
  t.textContent=msg;b.style.display=msg?'flex':'none';
}

// ── FEEDBACK WIDGET (logged-in only) ────────────────────────────────────────
// No static script tag: the widget loads lazily the first
// time the user enters the logged-in app, and hides on logout. Logged-out
// pages have no feedback button at all.
let _fbLoaded=false;
function loadFeedbackWidget(){
  if(_fbLoaded){
    const b=document.querySelector('.fbw-btn');
    if(b)b.style.display='';
    return;
  }
  _fbLoaded=true;
  const s=document.createElement('script');
  s.src='/feedback-widget.js?v=' + '20261002b';
  document.body.appendChild(s);
}
function hideFeedbackWidget(){
  const b=document.querySelector('.fbw-btn');
  if(b)b.style.display='none';
  const o=document.querySelector('.fbw-overlay');
  if(o)o.classList.remove('fbw-open');
}

function showApp(){
  hideBootScreen();
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('app-screen').classList.add('visible');
  const acctEmail=document.getElementById('acct-email');
  if(acctEmail)acctEmail.textContent=(currentUser&&currentUser.email)||'';
  viewMonth=null;
  // Landing tab is always Garden (static HTML default) — replaceState (not
  // pushState) so this doesn't consume a Back press; the very first Back
  // from here correctly leaves the app. This also collapses whatever
  // pre-auth step entry (login/signup/forgot/verify) was on top, so a
  // just-logged-in user's Back doesn't land on a stale auth-flow screen.
  // A refresh must leave you on the tab you were looking at. Browsers keep
  // history.state across a reload of the same entry, so the pushState from the
  // last tab switch is still readable here — read it before defaulting.
  // Without this, refreshing anywhere but the first tab bounced the user back
  // to it.
  // A FRESH LOGIN has no `view` in state — the top entry is the auth step — so
  // it still lands on the default, and the replaceState below still collapses
  // that auth entry, which is what this block was always protecting.
  // goTab(x, true) is the existing choke point: it does the DOM work and skips
  // the push. currentTab is nulled first so its no-op guard can't swallow it.
  currentTab=null;
  goTab(BOOT_VIEW||'garden',true);
  pushViewState(true);
  loadAll();
  maybeShowOnboard();
  // Feedback button only when FEEDBACK_WEBHOOK_URL is set on the server.
  SITE_CONFIG_READY.then(()=>{if(feedbackAvailable)loadFeedbackWidget();});
  if(window.Gnome){Gnome.mount(document.getElementById('garden-gnome'),{interactive:true,main:true});}
  const st=document.getElementById('sound-toggle');
  if(st&&!st.dataset.wired){st.dataset.wired='1';try{st.checked=localStorage.getItem('garden_sound')==='1';}catch{} st.addEventListener('change',()=>{try{localStorage.setItem('garden_sound',st.checked?'1':'0');}catch{} if(st.checked&&window.FX)FX.sound('plink');});}
}

let inRecovery=false;

sb.auth.onAuthStateChange((event,session)=>{
  if(event==='PASSWORD_RECOVERY'){
    inRecovery=true;
    hideBootScreen();
    document.getElementById('auth-screen').style.display='none';
    document.getElementById('reset-screen').style.display='flex';
  }else if(event==='SIGNED_IN'&&!inRecovery){
    currentUser=session.user;showApp();
  }else if(event==='SESSION_ENDED'){
    sessionEnded();
  }
});

// Boot: one GET /api/me (via getSession) decides "logged in?". When the
// server cannot be reached at all, say so on the login screen instead of
// leaving a silent form.
(async function boot(){
  await Promise.resolve(); // let PASSWORD_RECOVERY land first
  if(inRecovery)return;
  try{
    const {data:{session}}=await sb.auth.getSession();
    if(inRecovery)return;
    if(session){
      currentUser=session.user;
      showApp();return;
    }
    if(!currentUser&&!inRecovery){
      showAuthScreen();
    }
  }catch(e){
    if(inRecovery)return;
    showAuthScreen();
    const el=document.getElementById('auth-err');
    if(el){el.textContent=(e&&e.network)?e.message:"Can't reach the server. Check your connection and try again.";el.style.display='block';}
  }
})();

async function setNewPassword(){
  const pw=document.getElementById('new-pw').value;
  const errEl=document.getElementById('reset-err'),sucEl=document.getElementById('reset-suc'),btn=document.getElementById('reset-btn');
  errEl.style.display='none';sucEl.style.display='none';
  if(pw.length<10||pw.length>200){errEl.textContent='Password must be 10–200 characters.';errEl.style.display='block';return;}
  btn.disabled=true;btn.textContent='Saving...';
  const{error}=await sb.auth.updateUser({password:pw});
  if(error){errEl.textContent=error.message;errEl.style.display='block';}
  else{
    inRecovery=false;
    sucEl.textContent='Password updated! Taking you to your garden...';sucEl.style.display='block';
    setTimeout(()=>{
      document.getElementById('reset-screen').style.display='none';
      sb.auth.getSession().then(({data:{session}})=>{if(session){currentUser=session.user;showApp();}});
    },1500);
  }
  btn.disabled=false;btn.textContent='Update Password';
}

// ── RESOURCES ──────────────────────────────────────────────────────────────────
let resOpen=false;
function toggleResources(fromHistory){
  // Closing is an overlay dismissal like any other — route it through history
  // so the drawer's own close control and the browser Back button agree.
  if(resOpen&&fromHistory!==true&&closeOverlayViaHistory())return;
  resOpen=!resOpen;
  document.getElementById('res-drawer').classList.toggle('open',resOpen);
  document.getElementById('res-backdrop').style.display=resOpen?'block':'none';
  document.getElementById('res-tab').style.display=resOpen?'none':'flex';
  const sbTools=document.getElementById('sb-tab-tools');
  if(sbTools)sbTools.classList.toggle('active',resOpen);
  if(resOpen)pushOverlayState();
}

// ---------------------------------------------------------------------------
// TIPS and NUDGES are deliberately SEPARATE. Help with the app
// is not a promo and must never take a promo's slot, or the promo surface just
// isn't one that day. TIPS teach the app. NUDGES sell something.
// ---------------------------------------------------------------------------
// App help. Rotates daily on the Garden tab, above the promo tip card.
// No links, no labels, nothing to disclose. `act` runs a small in-app action.
const TIPS = [
  { text: 'Water is applied smallest bill first, so a whole plant blooms early instead of everything creeping up at once.', cta: 'Log a payment', act: 'go-water' },
  { text: 'Coverage is per month. A new month is fresh soil and the plants start again, but the history stays in Growth.', cta: 'See my growth', act: 'go-growth' },
  { text: 'Plants move through six stages: seed, sprout, leafing, budding, blooming, full bloom. Full bloom means that bill is paid for this month.', cta: 'Open the garden', act: 'go-garden' },
  { text: 'Turn on fixed monthly for anything that costs the same every month. Leave it off for the ones that move around and set those per month.', cta: 'Open bills', act: 'go-bills' },
  { text: 'Plant your smallest bill first. It is the one you will see bloom soonest, and that is the part that keeps you going.', cta: 'Plant a bill', act: 'go-bills' },
  { text: 'Water more than you owe and the extra shows up as surplus rather than disappearing.', cta: 'Log a payment', act: 'go-water' },
  { text: 'Everything in the app is explained in one place, with pictures.', cta: 'Open how it works', act: 'open-help' },
];
// The CTA on an app-help tip. Never navigates off-site; that is what a promo does.
function runTipAction(act){
  switch(act){
    case 'go-garden': goTab('garden'); break;
    case 'go-water':  goTab('water'); break;
    case 'go-bills':  goTab('bills'); break;
    case 'go-growth': goTab('growth'); break;
    case 'open-help': openHelp(); break;
  }
}

// Promos only: Jen Built It's own apps and posts, plus three labeled affiliate links. Swap in your own.
const NUDGES=[
  {text:'Want to increase your Creator Connections income? OINK automates your Amazon tasks. Use code JENNIFER to save 10%.',link:'https://oinkforinfluencers.com/extension/?via=jennifer',cta:'Try OINK →'},
  {text:'Did you know you can connect with brands and receive product samples through Levanta?',link:'https://app.levanta.io/auth/refer/creator/6f09ce62-f84b-466a-8fde-d71742a1f425/sign-up',cta:'Check out Levanta →'},
  {text:'Logie gives you access to product info and brand samples as a creator.',link:'https://mylogie.com/signup?invitationCode=jensolt178',cta:'Try Logie →'},
  {text:'Cancelling subscriptions you don\'t use? Track how much you\'re saving with the Subscription Graveyard.',link:'https://subscriptiongraveyard.app',cta:'Try Subscription Graveyard →'},
  {text:'Building an emergency fund? Watch your savings come alive as adorable sea creatures.',link:'https://emergencyfundaquarium.com',cta:'Try Emergency Fund Aquarium →'},
  {text:'Track your daily energy to find when you\'re most productive. Earn more during your peak hours.',link:'https://energybattery.app',cta:'Try Energy Battery →'},
  {text:'Build daily habits that stick. The Dopamine Dealer makes it fun to stay consistent.',link:'https://dopaminedealerhabits.com/',cta:'Try Dopamine Dealer →'},
  {text:'Reviewing Amazon products is one of Jen Built It\'s own side income streams, so she built Porch Pile to track the products, videos, and brand deals behind it.',link:'https://porchpile.com',cta:'Try Porch Pile →'},
  {text:'Updating your resume for a side gig or a full-time pivot? Resume Prune trims a long resume down to a tight one.',link:'https://resumeprune.com/',cta:'Try Resume Prune →'},
  {text:'Jen Built It, the app\'s maker, made a free one-page log of every place that pays you, and which ones send a 1099 in January.',link:'https://adminarcade.com/printable-side-hustle-income-log/',cta:'Get the income log →'},
  {text:'Garden counts money once it lands. The app\'s maker built a tracker that counts it the day you earn it, so you can see your pace before the payouts show up.',link:'https://jen8n.com/irregular-income-tracker/',cta:'Read: track it before it\'s paid →'},
  {text:'Reselling as a side hustle? Check the real profit before you list. Sticker price lies.',link:'https://seedingserendipity.com/reselling-profit-calculator/',cta:'Read: reselling profit →'},
  {text:'Want to build your own side hustle tools? Here\'s how the app\'s maker built a link-in-bio that lives on her own site.',link:'https://jen8n.com/link-in-bio-on-your-own-blog/',cta:'Read on Jen8n →'},
  {text:'Every side hustle needs one link that holds all of it. The app\'s maker built one you can use.',link:'https://buildabio.com',cta:'Try Build a Bio →'},
  {text:'Grow the audience that buys from you. The app\'s maker built a giveaway widget that embeds on any blog with a line of HTML.',link:'https://giveawaywidget.com',cta:'Try Giveaway Widget →'},
];
function isAff(url){if(!url)return false;const own=['dopaminedealerhabits.com','sidehustlegarden.com','subscriptiongraveyard.app','emergencyfundaquarium.com','energybattery.app','jen8ndirectory.com','resumeprune.com','jenbuiltit.com','jen8n.com','seedingserendipity.com','jentriedit.com','buildabio.com','giveawaywidget.com','porchpile.com','adminarcade.com','recipecolumncards.com','questmytasks.com'];return !own.some(d=>url.includes(d));}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let lastNudgeIdx=-1;
let nudgeTimer=null;

function showNudge(){
  let idx;
  do{idx=Math.floor(Math.random()*NUDGES.length);}while(idx===lastNudgeIdx);
  lastNudgeIdx=idx;
  const n=NUDGES[idx];
  document.getElementById('nudge-text').textContent=n.text;
  const link=document.getElementById('nudge-link');
  link.href=n.link;link.textContent=n.cta;
  document.getElementById('nudge-aff').textContent=isAff(n.link)?'affiliate link':'';
  const el=document.getElementById('water-nudge');
  el.style.display='block';
  if(nudgeTimer)clearTimeout(nudgeTimer);
  nudgeTimer=setTimeout(closeNudge,7000);
}
function closeNudge(){
  document.getElementById('water-nudge').style.display='none';
  if(nudgeTimer)clearTimeout(nudgeTimer);
}
function spawnButterfly(){
  const el=document.createElement('div');
  el.className='butterfly';
  el.innerHTML=IC.butterfly;
  el.style.top=Math.random()*40+20+'%';
  el.style.left='0px';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),2900);
}

function spawnCaterpillar(){
  // attach to the progress bar strip
  const strip=document.querySelector('.progress-strip');
  if(!strip)return;
  strip.style.position='relative';
  const existing=strip.querySelector('.caterpillar');
  if(existing)existing.remove();
  const el=document.createElement('div');
  el.className='caterpillar';
  el.innerHTML=IC.caterpillar;
  strip.appendChild(el);
  setTimeout(()=>el.remove(),4100);
}

let beeEl=null;
function spawnBee(){
  const mainWeed=document.getElementById('weed-main');
  if(!mainWeed||beeEl)return;
  mainWeed.style.position='relative';
  beeEl=document.createElement('div');
  beeEl.className='bee';
  beeEl.innerHTML=IC.bee;
  beeEl.style.cssText='top:10px;right:60px';
  mainWeed.appendChild(beeEl);
}
function removeBee(){if(beeEl){beeEl.remove();beeEl=null;}}

let hedgehogTimer=null;
function showHedgehog(){
  const el=document.getElementById('hedgehog');
  if(!el)return;
  el.style.display='block';
  el.className='hedgehog';
  if(hedgehogTimer)clearTimeout(hedgehogTimer);
  hedgehogTimer=setTimeout(hideHedgehog,5000);
}
function hideHedgehog(){
  const el=document.getElementById('hedgehog');
  if(!el)return;
  el.classList.add('hedgehog-hide');
  setTimeout(()=>{el.style.display='none';el.className='hedgehog';},500);
}

function showFrogInCelebration(show){
  const frog=document.getElementById('ov-frog');
  if(frog)frog.style.display=show?'block':'none';
}
function setSyncStatus(s){
  const cls='sync-dot'+(s==='syncing'?' syncing':s==='error'?' error':'');
  const txt=s==='syncing'?'saving...':s==='error'?'sync error':'synced ✓';
  const dot=document.getElementById('sync-dot'),lbl=document.getElementById('sync-lbl');
  if(dot)dot.className=cls;if(lbl)lbl.textContent=txt;
  const sbDot=document.getElementById('sb-sync-dot'),sbLbl=document.getElementById('sb-sync-lbl');
  if(sbDot)sbDot.className=cls;if(sbLbl)sbLbl.textContent=txt;
}

// ── DATA ──────────────────────────────────────────────────────────────────────
async function loadAll(){
  setSyncStatus('syncing');
  showLoadBanner('');
  try{
    const uid=currentUser.id;
    const{data:bRows,error:bErr}=await sb.from('bills').select('*').eq('user_id',uid).order('created_at');
    if(bErr)throw bErr;
    bills=bRows.map(r=>({id:r.id,name:r.name,amount:r.amount,type:r.type||'other',isFinal:r.is_final,repeats:r.repeats,archived:r.archived||false,startMonth:r.start_month||null,endMonth:r.end_month||null}));
    billsLoaded=true;
    const{data:pRows,error:pErr}=await sb.from('payments').select('*').eq('user_id',uid).order('created_at');
    if(pErr)throw pErr;
    payments=pRows.map(r=>({id:r.id,source:r.source,amount:r.amount,month:r.month,targets:r.targets||[],created_at:r.created_at,pay_date:r.pay_date||r.created_at}));
    const{data:mRows,error:mErr}=await sb.from('monthly_amounts').select('*').eq('user_id',uid);
    if(mErr)throw mErr;
    monthlyAmounts={};mRows.forEach(r=>{monthlyAmounts[r.bill_id+'__'+r.month]={id:r.id,amount:r.amount};});
    const{data:sRow}=await sb.from('user_settings').select('monthly_goal').eq('user_id',uid).maybeSingle();
    userGoal=sRow?parseFloat(sRow.monthly_goal||0):0;
    setSyncStatus('synced');
    await checkAutoReset();
    renderGarden();
    // The boot tab was already drawn — synchronously, by showApp()'s
    // goTab(BOOT_VIEW) — BEFORE any of the fetches above resolved, so it drew
    // against bills=[]/payments=[]. Only Garden was re-rendered here, which
    // meant landing on any other tab left its empty state on screen for a full
    // account until the user switched tabs and back. For example, clicking the
    // logo while on Water showed "Add some bills first!" on an account full of bills.
    renderCurrentTab();
  }catch(e){
    // A 401 already ended the session in place (SESSION_ENDED); nothing to draw.
    if(!currentUser)return;
    setSyncStatus('error');
    const msg=(e&&e.message)||'Something went wrong. Try again.';
    // The banner sits above the tabs so the Retry is visible whichever tab the
    // user landed on; the garden panel repeats it where the plants would be.
    showLoadBanner("Your garden didn't load. "+msg);
    document.getElementById('tab-garden').innerHTML=`<div class="empty-state"><div class="empty-icon"></div><p style="color:var(--red-text)">Your garden didn't load</p><p style="font-size:11px;margin-top:8px;color:var(--muted)">${esc(msg)}</p><button type="button" class="btn btn-sage" style="width:auto;padding:8px 18px;margin-top:14px" data-action="loadAll">Try Again</button></div>`;
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function ym(d){d=d||new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')}
function ymFromDate(dateStr){if(!dateStr)return ym();const d=new Date(dateStr+'T12:00:00');return ym(d)}
function ymLabel(k){const[y,m]=k.split('-');return MNAMES[+m-1]+' '+y}
function fmt(n){return'$'+parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtShort(n){return n>=1000?'$'+(n/1000).toFixed(1)+'k':fmt(n)}
function todayStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
const CM=()=>ym();
// consecutive completed months (last month backwards) with at least one watering
const RANKS=[[0,'Seedling'],[1,'Sprout'],[5,'Gardener'],[15,'Green Thumb'],[40,'Head Gardener'],[100,'Master Gardener']];
function bloomedAllTime(){
  const months=new Set(payments.map(p=>p.month));
  let n=0;
  months.forEach(m=>{activeBillsFor(m).forEach(b=>{const a=billAmt(b,m);if(a>0&&billPaid(b,m)>=a)n++;});});
  return n;
}
function rankFor(n){
  let cur=RANKS[0],next=null;
  for(let i=0;i<RANKS.length;i++){if(n>=RANKS[i][0])cur=RANKS[i];else{next=RANKS[i];break;}}
  return {name:cur[1],next:next?next[1]:null,needed:next?next[0]-n:0};
}
function rankLine(){
  const r=rankFor(bloomedAllTime());
  return r.next?`Rank: ${r.name}. ${r.needed} more bloom${r.needed===1?'':'s'} to ${r.next}.`:`Rank: ${r.name}. Top of the garden.`;
}

// ── Scout badges ──────────────────────────────────────────────────────────────
// Scalloped patches. Colours come from CSS variables on .badge so an unearned badge
// is the same drawing in grey; earning it just switches the palette.
const BADGE_PATCH=(()=>{const pts=[];const n=14;for(let i=0;i<n*2;i++){const a=i*Math.PI/n-Math.PI/2;const r=i%2?31:34;pts.push((36+Math.cos(a)*r).toFixed(1)+','+(36+Math.sin(a)*r).toFixed(1));}return '<polygon points="'+pts.join(' ')+'" fill="var(--ring)"/><circle cx="36" cy="36" r="29" fill="var(--patch)"/><circle cx="36" cy="36" r="26" fill="none" stroke="var(--ring)" stroke-width="1.4" stroke-dasharray="2.5 2.5"/>';})();
function badgeFlower(cx,cy,r,petal,center){let s='';for(let i=0;i<6;i++){const a=i*Math.PI/3;s+=`<circle cx="${(cx+Math.cos(a)*r).toFixed(1)}" cy="${(cy+Math.sin(a)*r).toFixed(1)}" r="${(r*.62).toFixed(1)}" fill="${petal}"/>`;}return s+`<circle cx="${cx}" cy="${cy}" r="${(r*.55).toFixed(1)}" fill="${center}"/>`;}
const BADGE_ART={
  first:'<svg viewBox="0 0 72 72">'+BADGE_PATCH+'<path d="M36 52V34" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/><path d="M36 44c-6 0-10-4-10-9 5 0 10 3 10 9z" fill="var(--ink)"/>'+badgeFlower(36,28,6.5,'var(--accent)','var(--ink)')+'</svg>',
  full:'<svg viewBox="0 0 72 72">'+BADGE_PATCH+'<path d="M24 52V40M36 52V36M48 52V40" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="round"/><path d="M20 53h32" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="round"/>'+badgeFlower(24,36,4.2,'var(--accent)','var(--ink)')+badgeFlower(36,30,5,'var(--accent)','var(--ink)')+badgeFlower(48,36,4.2,'var(--accent)','var(--ink)')+'</svg>',
  streak:'<svg viewBox="0 0 72 72">'+BADGE_PATCH+'<path d="M26 24c-4 5-6 8-6 11a6 6 0 0 0 12 0c0-3-2-6-6-11z" fill="var(--accent)"/><path d="M36 30c-4 5-6 8-6 11a6 6 0 0 0 12 0c0-3-2-6-6-11z" fill="var(--accent)"/><path d="M46 24c-4 5-6 8-6 11a6 6 0 0 0 12 0c0-3-2-6-6-11z" fill="var(--accent)"/><path d="M22 50h28" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="round"/><path d="M27 50v-3M36 50v-5M45 50v-3" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="round"/></svg>',
  surplus:'<svg viewBox="0 0 72 72">'+BADGE_PATCH+'<rect x="22" y="33" width="20" height="15" rx="4" fill="var(--ink)"/><path d="M42 37h5l4-4" stroke="var(--ink)" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M27 33c0-5 3-8 5-8" stroke="var(--ink)" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="52" cy="26" r="3" fill="var(--accent)"/><circle cx="56" cy="34" r="2.2" fill="var(--accent)"/><circle cx="49" cy="20" r="1.8" fill="var(--accent)"/><path d="M30 30l-2-3M34 29l1-3" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>',
};
function badgesFor(){
  const months=[...new Set(payments.map(p=>p.month))];
  const full=months.some(m=>{const bs=activeBillsFor(m);return bs.length>0&&bs.every(b=>billPaid(b,m)>=billAmt(b,m));});
  // Earned more than the month's bills. (coveragePct only counts money placed
  // on bills, which can't pass their amounts, so it can't show a surplus.)
  const surplus=months.some(m=>activeBillsFor(m).length>0&&getSurplus(m)>0);
  return [
    {key:'first',name:'First Bloom',earned:bloomedAllTime()>=1,hint:'Water one bill to 100%.'},
    {key:'full',name:'Full Garden',earned:full,hint:'Bloom every bill in one month.'},
    {key:'streak',name:'Three in a Row',earned:computeStreak()>=3,hint:'Water something three months running.'},
    {key:'surplus',name:'Surplus',earned:surplus,hint:'Water past your total for a month.'},
  ];
}
function computeStreak(){
  const months=new Set(payments.map(p=>p.month));
  let s=0,d=new Date();
  d.setMonth(d.getMonth()-1);
  for(let i=0;i<36;i++){
    const mk=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if(months.has(mk))s++;else break;
    d.setMonth(d.getMonth()-1);
  }
  return s;
}
function coveragePct(month){
  const m=month||CM();
  const active=activeBillsFor(m);
  const totB=active.reduce((s,b)=>s+billAmt(b,m),0);
  const mPays=payments.filter(p=>p.month===m);
  // Only money on bills that count this month, so a bill left out of what's
  // owed can't still add to what's covered. Mirrored in src/worker.js recap.
  const ids=new Set(active.map(b=>b.id));
  const totP=mPays.reduce((s,p)=>s+(p.targets||[]).filter(t=>ids.has(t.billId)).reduce((a,t)=>a+t.applied,0),0);
  return{pct:totB>0?Math.round(totP/totB*100):0,totP,totB};
}

function getMonthRange(start,end){
  const result=[];let[y,m]=start.split('-').map(Number);const[ey,em]=end.split('-').map(Number);
  while(y<ey||(y===ey&&m<=em)){result.push(`${y}-${String(m).padStart(2,'0')}`);m++;if(m>12){m=1;y++;}}
  return result;
}
function billAmt(b,month){const k=b.id+'__'+(month||CM());return monthlyAmounts[k]?monthlyAmounts[k].amount:b.amount}
// A bill is "active" in a month only if it isn't archived AND it had started by
// that month. startMonth is "YYYY-MM" (lexical compare is safe, zero-padded).
// Legacy bills with no startMonth (null) are treated as always-existing so they
// keep showing in past months. New bills are stamped with their start month, so
// they never appear in months that already passed.
// An archived bill with an endMonth (the month it stopped being paid) still
// counts in the months before it, so its history and blooms stay true. One
// archived before endMonth existed has none and stays out of every month.
function billActiveInMonth(b,month){
  const m=month||CM();
  if(b.archived&&!(b.endMonth&&m<b.endMonth))return false;
  if(b.startMonth&&b.startMonth>m)return false;
  return true;
}
function activeBillsFor(month){return bills.filter(b=>billActiveInMonth(b,month));}
function billPaid(b,month){const m=month||CM();return payments.filter(p=>p.month===m).reduce((s,p)=>s+(p.targets||[]).filter(t=>t.billId===b.id).reduce((a,t)=>a+t.applied,0),0)}
function getSurplus(month){
  const m=month||CM();
  const totalPaid=payments.filter(p=>p.month===m).reduce((s,p)=>s+p.amount,0);
  const totalBills=activeBillsFor(m).reduce((s,b)=>s+billAmt(b,m),0);
  return Math.max(0,totalPaid-totalBills);
}
function snowballOrder(month){
  const m=month||CM();
  const activeBills=activeBillsFor(m);
  if(!activeBills.length)return[];
  const mainWeed=activeBills.reduce((a,b)=>billAmt(a,m)>=billAmt(b,m)?a:b);
  const alive=activeBills.filter(b=>billPaid(b,m)<billAmt(b,m));
  const fin=alive.find(b=>b.id===mainWeed.id);
  const others=alive.filter(b=>b.id!==mainWeed.id).sort((a,b)=>billAmt(a,m)-billAmt(b,m));
  return fin?[...others,fin]:others;
}

// ── TABS ──────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// PRO: Cash Flow Forecast
// ─────────────────────────────────────────────────────────────────────────────
// 6-month projection of income vs bills based on the last 3 months' avg.
// Calls /api/forecast (Pro-gated; returns 402 if not Pro). On 402 we render a
// friendly upsell since the tab should not normally be reachable for free.

// Pro gate with a blurred static mock of the forecast chart behind the card,
// so free users see what they are unlocking instead of an empty page.
function forecastGateHtml(renew) {
  const labels = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const income = [38, 46, 42, 58, 66, 80];
  const billsH = [52, 52, 54, 52, 56, 52];
  const groups = income.map((h, i) => {
    const x = 24 + i * 54;
    return `<rect x="${x}" y="${118 - billsH[i]}" width="17" height="${billsH[i]}" rx="3" fill="#FF9F8E" opacity=".45"/>`
      + `<rect x="${x + 20}" y="${118 - h}" width="17" height="${h}" rx="3" fill="#FFD24A" opacity=".85"/>`
      + `<text x="${x + 19}" y="132" font-size="9" fill="#C9B3BE" text-anchor="middle" font-family="Figtree,sans-serif">${labels[i]}</text>`;
  }).join('');
  const line = income.map((h, i) => `${24 + i * 54 + 28},${112 - h}`).join(' ');
  const msg = renew
    ? 'Your Pro pass has lapsed. Renew to keep your 6-month cash flow forecast and CSV export.'
    : 'See where your bills and side hustle income land over the next 6 months, plus CSV export of everything you have logged.';
  return `<div style="position:relative;max-width:440px;margin:20px auto 40px;padding:0 14px">
    <div aria-hidden="true" style="filter:blur(3px);opacity:.75;pointer-events:none;user-select:none;background:linear-gradient(160deg,rgba(254,251,245,.9),rgba(250,247,240,.78));border:1px solid rgba(255,255,255,.8);border-radius:16px;padding:14px 12px 8px">
      <div style="font-family:var(--serif);font-size:13px;color:var(--sage-d);margin-bottom:4px">Your 6-month forecast</div>
      <svg viewBox="0 0 356 140" width="100%" role="presentation">${groups}<polyline points="${line}" fill="none" stroke="#B9882E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div style="position:relative;margin-top:-44px;background:var(--card);border:1px solid var(--cream-d);border-radius:16px;padding:22px 20px;text-align:center;box-shadow:0 14px 44px rgba(61,74,43,.18)">
      <span class="pro-tag" style="margin-bottom:10px">★ Pro</span>
      <h2 style="font-family:var(--serif);color:var(--sage-d);font-size:18px;margin:8px 0 6px">See your next 6 months</h2>
      <p style="color:var(--muted);font-size:13px;line-height:1.6;margin:0 0 10px">${msg}</p>
      <p style="color:var(--muted);font-size:12px;line-height:1.5;margin:0 0 14px">Pro is part of the hosted version at sidehustlegarden.com.</p>
      <a href="https://sidehustlegarden.com" data-pro-cta="cash-flow-forecast" target="_blank" rel="noopener" style="display:inline-block;background:linear-gradient(135deg,#fbbf24,#d97706);color:var(--on-primary);padding:11px 24px;border-radius:9px;text-decoration:none;font-weight:700;font-family:var(--font)">Open sidehustlegarden.com</a>
    </div>
  </div>`;
}

async function renderForecast() {
  const el = document.getElementById('forecast-content');
  if (!el) return;
  el.innerHTML = '<div class="loading-screen" style="padding:32px"><div class="loading-spinner"></div><p>Forecasting your garden\'s weather...</p></div>';
  if (!currentUser) { el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted)">Sign in to see your forecast.</div>'; return; }
  if (!hasProAccess()) {
    el.innerHTML = forecastGateHtml();
    return;
  }
  try {
    const r = await fetch('/api/forecast', {
      credentials: 'same-origin',
    });
    if (r.status === 402) {
      el.innerHTML = forecastGateHtml();
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const fmt = n => { const v = Math.round(n || 0); return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US'); };
    const rows = (data.months || []).map(m => {
      const surplusColor = m.surplus >= 0 ? 'color:var(--money)' : 'color:var(--red-text)';
      const proj = m.income_is_projection ? '<span style="color:var(--muted);font-style:italic">(est)</span>' : '';
      return `<tr><td style="padding:8px 10px;border-bottom:1px solid var(--cream-d)">${m.label}</td><td style="padding:8px 10px;text-align:right;border-bottom:1px solid var(--cream-d)">${fmt(m.projected_income)} ${proj}</td><td style="padding:8px 10px;text-align:right;border-bottom:1px solid var(--cream-d)">${fmt(m.projected_bills)}</td><td style="padding:8px 10px;text-align:right;font-weight:700;border-bottom:1px solid var(--cream-d);${surplusColor}">${m.surplus >= 0 ? '+' : ''}${fmt(m.surplus)}</td><td style="padding:8px 10px;text-align:right;font-weight:600;border-bottom:1px solid var(--cream-d);${m.cumulative_surplus >= 0 ? 'color:var(--money)' : 'color:var(--red-text)'}">${m.cumulative_surplus >= 0 ? '+' : ''}${fmt(m.cumulative_surplus)}</td></tr>`;
    }).join('');
    const dataNote = data.months_of_data < 3
      ? `<div style="font-size:11px;color:var(--muted);margin-top:8px;font-style:italic">Forecast is based on ${data.months_of_data} month${data.months_of_data === 1 ? '' : 's'} of income history. Accuracy improves as you log more payments.</div>`
      : '';
    el.innerHTML = `<div style="padding:18px 18px 60px;max-width:780px;margin:0 auto">
      <h2 style="font-family:var(--serif);color:var(--sage-d);font-size:22px;margin-bottom:4px"><span class="pro-tag" style="vertical-align:middle;margin-right:8px">★ Pro</span>Your 6-month forecast</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:18px">Based on your trailing 3-month average of ${fmt(data.avg_monthly_income)} per month.</p>
      <div class="fc-card"><div class="fc-scroll">
        <table class="fc-table" style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:var(--cream)"><th style="padding:9px 10px;text-align:left;font-weight:600;color:var(--sage-d)">Month</th><th style="padding:9px 10px;text-align:right;font-weight:600;color:var(--sage-d)">Income</th><th style="padding:9px 10px;text-align:right;font-weight:600;color:var(--sage-d)">Bills</th><th style="padding:9px 10px;text-align:right;font-weight:600;color:var(--sage-d)">Surplus</th><th style="padding:9px 10px;text-align:right;font-weight:600;color:var(--sage-d)">Cumulative</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div></div>
      ${dataNote}
      <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" id="forecast-csv-btn" style="padding:9px 16px;background:var(--sage-d);color:var(--on-primary);border:none;border-radius:8px;font-family:var(--font);font-size:13px;font-weight:600;cursor:pointer">Download CSV (bills + payments)</button>
      </div>
    </div>`;
    const csvBtn = document.getElementById('forecast-csv-btn');
    if (csvBtn) csvBtn.addEventListener('click', downloadGardenCsv);
  } catch (e) {
    el.innerHTML = `<div style="padding:32px;text-align:center;color:var(--muted)">Could not load your forecast: ${e.message}</div>`;
  }
}

async function downloadGardenCsv() {
  if (!currentUser) return;
  try {
    const r = await fetch('/api/export/csv', {
      credentials: 'same-origin',
    });
    if (r.status === 402) {
      showProRequired('csv-export'); return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const csv = await r.text();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `garden-${todayStr()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    alert('CSV export failed: ' + e.message);
  }
}

// Single choke point for main-tab navigation. `fromHistory` is set only by
// the popstate handler below (restoring a prior tab) — it skips the
// pushState call so restoring never re-pushes (loop guard). showApp() does
// a one-time replaceState for the landing tab; every other call here that
// changes the tab pushes a new entry, so the browser Back button steps
// through tabs the user actually visited instead of exiting the app.
let currentTab='garden';
// Single history-state helper for the in-app tab + month combo. Both goTab()
// and setViewMonth() push through here so one popstate always restores a
// full, consistent snapshot (which tab AND which month) instead of the two
// dimensions drifting out of sync.
function pushViewState(replace){
  const state={view:currentTab,month:viewMonth};
  const url=location.pathname+location.search;
  if(replace)history.replaceState(state,'',url);else history.pushState(state,'',url);
}
// Re-draws whichever tab is currently on screen. goTab() renders on the way in,
// but a tab that was rendered before its data arrived (boot) or whose data
// changed elsewhere needs a redraw without a navigation. Garden is handled by
// its own renderGarden() calls, so this covers the other four.
function renderCurrentTab(){
  if(currentTab==='water')renderWater();
  else if(currentTab==='growth')renderGrowth();
  else if(currentTab==='bills')renderBillList();
  else if(currentTab==='forecast')renderForecast();
}

function goTab(name,fromHistory){
  if(!['garden','water','bills','growth','forecast'].includes(name))name='garden';
  if(!fromHistory&&name===currentTab)return; // no-op: already on this tab, don't push a duplicate entry
  currentTab=name;
  ['garden','water','bills','growth','forecast'].forEach(t=>{
    document.getElementById('tab-'+t).classList.toggle('active',t===name);
    const sb=document.getElementById('sb-tab-'+t);if(sb)sb.classList.toggle('active',t===name);
  });
  document.querySelectorAll('.tab[data-tab]').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===name));
  const gp=document.getElementById('gnome-panel'),gd=document.getElementById('garden-data');
  if(gp)gp.style.display=name==='garden'?'':'none';
  if(gd)gd.style.display=name==='garden'?'':'none';
  const gg=document.querySelector('.garden-grid'); if(gg)gg.classList.toggle('single',name!=='garden');
  if(name==='water')renderWater();
  if(name==='growth')renderGrowth();
  if(name==='bills')renderBillList();
  if(name==='forecast')renderForecast();
  if(!fromHistory)pushViewState();
  if(name!=='garden')window.scrollTo({top:0});
}

// The logo is a home link (aria-label "Side Hustle Garden home"). Logged out,
// href="/" is right. Logged IN you are already at "/", so that href is a full
// reload that lands you back on the tab you were already on (history.state
// survives a same-entry reload, and BOOT_VIEW restores it) — the logo appeared
// to do nothing, or worse, flashed an empty tab. Route it to the Garden tab
// through goTab() instead: one history entry, so Back returns to the tab the
// user came from.
document.addEventListener('click',(e)=>{
  if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  const brand=e.target&&e.target.closest&&e.target.closest('a.shg-brand');
  if(!brand)return;
  const app=document.getElementById('app-screen');
  if(!app||!app.classList.contains('visible'))return;
  e.preventDefault();
  goTab('garden');
  window.scrollTo({top:0,behavior:'smooth'});
});


// ── GARDEN TAB ────────────────────────────────────────────────────────────────
function renderGarden(){
  const el=document.getElementById('tab-garden');
  const vm=getViewMonth();
  const earned=payments.filter(p=>p.month===vm).reduce((s,p)=>s+p.amount,0);
  document.getElementById('hdr-month').textContent=ymLabel(vm);
  document.getElementById('hdr-total').textContent=fmt(earned)+' watered';
  const sbM=document.getElementById('sb-month');if(sbM)sbM.textContent=ymLabel(vm);
  const sbE=document.getElementById('sb-earned');if(sbE)sbE.textContent=fmt(earned)+' watered';

  const activeBills=activeBillsFor(vm);

  const witheredAll=activeBills.filter(b=>billAmt(b,vm)>0&&billPaid(b,vm)>=billAmt(b,vm));
  const dueCount=activeBills.filter(b=>billAmt(b,vm)>0).length;
  const target=snowballOrder(vm)[0];
  const _cov=coveragePct(vm);const oPct=_cov.pct,totP=_cov.totP,totB=_cov.totB;
  const allSorted=[...activeBills].sort((a,b)=>billAmt(a,vm)-billAmt(b,vm));
  const bloomedCount=witheredAll.length;
  const canNext=vm<CM();
  let html=`<div class="month-head"><div class="month-nav">
      <button type="button" class="month-btn" data-action="prevMonth" aria-label="Previous month">${IC.chevL}</button>
      <h1 class="month-title">${ymLabel(vm)}</h1>
      <button type="button" class="month-btn" data-action="nextMonth" aria-label="Next month" ${canNext?'':'disabled'}>${IC.chevR}</button>
    </div><span class="month-sub">${bloomedCount} of ${dueCount} bloomed</span></div>`;
  if(vm!==CM())html+=`<div style="margin:-8px 0 12px"><button type="button" class="linkbtn" data-action="backToCurrentMonth">Back to this month</button></div>`;
  html+=`<div class="garden-scene" id="garden-scene"></div>`;
  if(activeBills.length<3&&payments.length===0){
    const steps=[
      {t:`Plant 3 bills (${Math.min(3,activeBills.length)}/3)`,done:activeBills.length>=3},
      {t:'Log your first watering',done:payments.length>0},
      {t:'Bloom your first bill',done:bloomedAllTime()>=1},
    ];
    html+=`<div class="card quest-card"><div class="sec-lbl">Your first quest</div>
      <ol class="quest-steps">${steps.map(s=>`<li class="${s.done?'done':''}"><span class="quest-dot">${s.done?IC.check:''}</span>${s.t}</li>`).join('')}</ol>
      <button type="button" class="btn" data-action="goTab" data-arg="bills">Plant a bill</button></div>`;
  }
  html+=`<div class="plants-head"><span class="sec-lbl" style="margin:0">Your plants, smallest first</span><button type="button" class="linkbtn" data-action="goTab" data-arg="bills">Manage bills</button></div>`;
  allSorted.forEach(b=>{
    const bA=billAmt(b,vm),bP=Math.min(billPaid(b,vm),bA),pct=bA>0?Math.min(100,bP/bA*100):0;
    // $0 this month = not due: neither bloomed nor waiting for water.
    const done=bA>0&&bP>=bA,isT=!done&&target&&target.id===b.id,tier=getTier(bA);
    const unset=!b.repeats&&!monthlyAmounts[b.id+'__'+vm]?`<button type="button" class="wri-unset" data-action="goTab" data-arg="bills" title="This variable bill has no amount for this month yet">set amount</button>`:'';
    html+=`<div class="plant-row ${done?'is-done':''}" id="weed-${b.id}" data-bill="${esc(b.id)}">
      <div class="plant-ico">${smStageArt(tier.key,pct,done)}</div>
      <div class="plant-body">
        <div class="plant-top"><div style="display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap"><span class="plant-name">${esc(b.name)}</span>${bA===0?'<span class="pill">Not due</span>':done?'<span class="pill pill-done">Bloomed</span>':isT?'<span class="pill pill-next">Water next</span>':''}${unset}</div><span class="plant-amt">${fmt(bA)}/mo</span></div>
        <div class="plant-bar"><i style="width:${Math.round(pct)}%"></i></div>
      </div>
      <div class="plant-pct">${bA===0?'–':done?IC.check:Math.round(pct)+'%'}</div>
    </div>`;
  });
  if(!allSorted.length)html+=`<div class="card" style="text-align:center;color:var(--muted)">No plants yet. <button type="button" class="linkbtn" data-action="goTab" data-arg="bills">Plant your first bill</button></div>`;
  const doy=Math.floor((new Date()-new Date(new Date().getFullYear(),0,0))/86400000);
  const htip=TIPS[doy%TIPS.length];
  html+=`<button type="button" class="garden-help-card" data-action="tip-act" data-tip-act="${esc(htip.act)}"><div class="garden-tip-inner"><span class="garden-tip-icon">${IC.leaf}</span><div class="garden-tip-body"><div class="garden-tip-label">How it works</div><div class="garden-tip-text">${esc(htip.text)}</div><div class="garden-tip-cta">${esc(htip.cta)}</div></div></div></button>`;
  const tip=NUDGES[doy%NUDGES.length];
  const promoHtml=`<a href="${tip.link}" target="_blank" class="garden-tip-card" rel="noopener noreferrer"><div class="garden-tip-inner"><span class="garden-tip-icon">${IC.leaf}</span><div class="garden-tip-body"><div class="garden-tip-label">Today's tip</div><div class="garden-tip-text">${esc(tip.text)}</div><div class="garden-tip-cta">${esc(tip.cta)}${isAff(tip.link)?' <span class="garden-tip-aff">affiliate</span>':''}</div></div></div></a>`;
  el.innerHTML=html;
  if(window.Scene){
    Scene.render(document.getElementById('garden-scene'),allSorted.map(b=>{const bA=billAmt(b,vm),bP=Math.min(billPaid(b,vm),bA),pct=bA>0?Math.min(100,bP/bA*100):0,done=bA>0&&bP>=bA,tier=getTier(bA);return {id:b.id,name:b.name,amt:bA,pct,done,notDue:bA===0,tierKey:tier.key,art:mwStageArt(tier.key,pct,done)};}),{month:ymLabel(vm),coverage:oPct});
  }
  // ── Greenhouse: character panel + data column ──
  const cov=document.getElementById('coverage-card');
  if(cov){
    cov.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:baseline"><span class="sec-lbl" style="margin:0">Garden coverage</span><span class="disp num" style="color:var(--green-d)">${oPct}%</span></div>
      <div class="grow-bar-wrap" style="margin:10px 0 8px"><div class="grow-bar" style="width:${oPct}%"></div></div>
      <div style="font-size:13px;color:var(--muted)">${fmt(totP)} watered of ${fmt(totB)} this month${totP>totB?` · <span style="color:var(--marigold-d);font-weight:700">${fmt(totP-totB)} surplus</span>`:''}</div>
      <div id="rank-line" style="font-size:13px;color:var(--muted);margin-top:8px"></div>`;
  }
  const tiles=document.getElementById('gnome-tiles');
  if(tiles){
    const wCount=payments.filter(p=>p.month===vm).length,stk=computeStreak();
    tiles.innerHTML=`<div class="tile tile-sky"><span class="tile-lbl">Streak</span><span class="tile-val">${stk} month${stk===1?'':'s'}</span></div><div class="tile tile-leaf"><span class="tile-lbl">Waterings</span><span class="tile-val">${wCount}</span></div>`;
  }
  const dataCol=document.getElementById('garden-data');
  if(dataCol){
    const recent=[...payments.filter(p=>p.month===vm)].sort((a,b)=>b.created_at>a.created_at?1:-1).slice(0,4);
    const bloomedN=witheredAll.length;
    dataCol.innerHTML=`<div class="card"><div class="sec-lbl">This month</div><div class="stat-grid">
        <div><span class="disp num">${fmt(earned)}</span><span>earned</span></div>
        <div><span class="disp num">${fmt(Math.min(totP,totB))}</span><span>watered</span></div>
        <div><span class="disp num">${bloomedN}</span><span>bloomed</span></div>
        <div><span class="disp num">${fmt(Math.max(0,totB-totP))}</span><span>still to water</span></div></div></div>
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><span class="sec-lbl" style="margin:0">Recent waterings</span><button type="button" class="linkbtn" data-action="goTab" data-arg="growth">All</button></div>
        <div class="recent-list">${recent.length?recent.map(p=>`<div><span>${esc(p.source)}</span><strong>${fmt(p.amount)}</strong></div>`).join(''):'<div style="color:var(--dim)">Nothing watered yet this month.</div>'}</div></div>
      <div id="data-tips"></div>`;
    const dt=document.getElementById('data-tips'); if(dt)dt.innerHTML=promoHtml;
  }
  if(window.Gnome){
    const last=payments.length?Math.max(...payments.map(p=>new Date(p.created_at).getTime())):0;
    const daysSince=last?Math.floor((Date.now()-last)/86400000):0;
    const nextB=target&&!(billPaid(target,vm)>=billAmt(target,vm))?target:null;
    if(Gnome.progress)Gnome.progress(oPct);
    Gnome.stateLine({bills:activeBills.length,next:nextB?nextB.name:null,remaining:nextB?fmt(Math.max(0,billAmt(nextB,vm)-billPaid(nextB,vm))):null,coverage:oPct,allBloomed:dueCount>0&&witheredAll.length===dueCount,bloomedNames:witheredAll.map(b=>b.name),daysSince});
    const rl=document.getElementById('rank-line'); if(rl)rl.textContent=rankLine();
  }
  // the bee now lives in the scene (scene.js hoverBee)
  if(Math.random()<0.2)setTimeout(showHedgehog,1200);
}

// ── WATER TAB ────────────────────────────────────────────────────────────────
function renderWater(){
  if(!bills.length){document.getElementById('water-empty').style.display='block';document.getElementById('water-form').style.display='none';return}
  document.getElementById('water-empty').style.display='none';document.getElementById('water-form').style.display='block';
  if(!document.getElementById('pay-date').value)document.getElementById('pay-date').value=todayStr();
  updatePreview();
}

function updatePreview(){
  const amt=parseFloat(document.getElementById('amt').value)||0;
  const dateVal=document.getElementById('pay-date').value||todayStr();
  const month=ymFromDate(dateVal);
  const el=document.getElementById('sb-preview'),list=document.getElementById('sb-list');
  if(!amt){el.style.display='none';return}
  el.style.display='block';
  document.getElementById('sb-preview-lbl').textContent=`applying to ${ymLabel(month)} bills, smallest first`;
  const order=snowballOrder(month);
  if(!order.length){list.innerHTML=`<div style="font-size:11px;color:var(--sage-d)">All plants bloomed for ${ymLabel(month)}! ${IC.butterfly}</div>`;return}
  let rem=amt,html='';
  order.forEach(b=>{
    const needed=Math.max(0,billAmt(b,month)-billPaid(b,month)),applying=Math.min(rem,needed);
    if(applying<=0)return;
    const tier=getTier(billAmt(b,month));
    html+=`<div class="sp-row"><span>${tier.spriteD} ${esc(b.name)}</span><span style="color:var(--sage-d)">${fmt(applying)}</span></div>`;
    rem-=applying;
  });
  if(rem>0)html+=`<div style="font-size:10px;color:var(--muted);padding-top:3px">${fmt(rem)} surplus. All weeds watered! ${IC.butterfly}</div>`;
  list.innerHTML=html;
}

async function logPayment(){ if(logPayment.busy) return; logPayment.busy=true; try{ return await logPaymentRun(); } finally{ logPayment.busy=false; } }
async function logPaymentRun(){
  const src=document.getElementById('src').value.trim();
  const amt=parseFloat(document.getElementById('amt').value);
  const dateVal=document.getElementById('pay-date').value||todayStr();
  // An empty form is told what it needs instead of silently doing nothing.
  if(!src||!amt||amt<=0){showToast('Enter where the money came from and how much.');document.getElementById(!src?'src':'amt').focus();return}
  const btn=document.getElementById('water-btn');
  btn.textContent='Watering...';btn.disabled=true;
  const month=ymFromDate(dateVal);
  const order=snowballOrder(month);
  // stage-up detection: the main plant crosses budding (50%) and blooming
  // (75%); smaller plants bud at 50%. 100% (full bloom) stays with the
  // existing withered celebration below.
  const monthBills=activeBillsFor(month);
  const mainForMonth=monthBills.length?monthBills.reduce((a,b)=>billAmt(a,month)>=billAmt(b,month)?a:b):null;
  let rem=amt;const targets=[],withered=[],stageUps=[];
  order.forEach(b=>{
    if(rem<=0)return;
    const bAmt=billAmt(b,month),prePaid=billPaid(b,month);
    const needed=Math.max(0,bAmt-prePaid),applying=Math.min(rem,needed);
    if(applying<=0)return;
    targets.push({billId:b.id,billName:b.name,applied:applying});
    const postPaid=prePaid+applying;
    if(postPaid>=bAmt){
      withered.push(b);
    }else if(bAmt>0){
      const prePct=prePaid/bAmt*100,postPct=postPaid/bAmt*100;
      const isMainB=mainForMonth&&b.id===mainForMonth.id;
      if(isMainB&&prePct<75&&postPct>=75)stageUps.push({name:b.name,phase:'blooming'});
      else if(prePct<50&&postPct>=50)stageUps.push({name:b.name,phase:'budded'});
    }
    rem-=applying;
  });
  try{
    setSyncStatus('syncing');
    const{data,error}=await sb.from('payments').insert({source:src,amount:amt,month,targets,pay_date:dateVal,user_id:currentUser.id}).select();
    if(error)throw error;
    payments.push({id:data[0].id,source:src,amount:amt,month,targets,created_at:data[0].created_at,pay_date:dateVal});
    setSyncStatus('synced');
    document.getElementById('src').value='';document.getElementById('amt').value='';
    document.getElementById('sb-preview').style.display='none';
    document.getElementById('pay-date').value=todayStr();
    renderGarden();goTab('garden');
    showWaterFloat(amt);
    if(window.Gnome)Gnome.react('pleased');
    if(window.Scene){
      const firstRow=targets.length?document.querySelector(`#weed-${targets[0].billId} .plant-ico`):null;
      if(window.FX){FX.pour(firstRow);FX.sound('plink');}
      Scene.rain(1800);
      targets.forEach((t,i)=>{setTimeout(()=>{Scene.popPlant(t.billId);const row=document.querySelector(`#weed-${t.billId} .plant-bar`);if(row){row.classList.remove('wobble');void row.offsetWidth;row.classList.add('wobble');}},400+i*350);if(i>0)setTimeout(()=>Scene.trickle(targets[i-1].billId,t.billId),300+i*350);});
      withered.forEach(b=>setTimeout(()=>Scene.bloom(b.id),900));
    }
    spawnButterfly();
    setTimeout(spawnCaterpillar,600);
    if(withered.length){
      // Big celebration first; stage-up lines flush after the overlay closes.
      _pendingStageUps=stageUps;
      setTimeout(()=>showCelebration(withered),700);
    } else {
      showWateringPopup(amt,src,targets,month);
      // Queue stage-ups after the watering popup (it auto-dismisses at 5s).
      if(stageUps.length)setTimeout(()=>flushStageUps(stageUps),5300);
    }
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
  btn.textContent='Water the garden';btn.disabled=false;
}

// ── ANIMATIONS ────────────────────────────────────────────────────────────────
function showWaterFloat(amt){
  const el=document.createElement('div');el.className='water-float';
  el.textContent='+'+fmt(amt);
  el.style.cssText='top:35%;left:50%;transform:translateX(-50%)';
  document.body.appendChild(el);setTimeout(()=>el.remove(),1500);
  document.querySelectorAll('.main-weed,.cur-target').forEach(c=>{c.classList.remove('shake');void c.offsetWidth;c.classList.add('shake');setTimeout(()=>c.classList.remove('shake'),500);});
}
function showWateringPopup(amt,src,targets,month){
  document.querySelectorAll('.water-popup').forEach(el=>el.remove());
  const popup=document.createElement('div');
  popup.className='water-popup';
  // Build context-aware message
  const totalBills=activeBillsFor(month).length;
  const totalPaid=payments.filter(p=>p.month===month).reduce((s,p)=>s+p.amount,0);
  const totalOwed=activeBillsFor(month).reduce((s,b)=>s+billAmt(b,month),0);
  const pct=totalOwed>0?Math.min(100,Math.round(totalPaid/totalOwed*100)):0;
  const applied=targets.map(t=>t.billName).join(', ');
  const surplus=totalPaid>totalOwed?totalPaid-totalOwed:0;
  let icon,msg;
  if(pct>=100){
    icon=IC.crown;
    msg=`All bills covered this month! You're ahead of the game.`;
  } else if(pct>=90){
    icon=IC.star;
    msg=`Almost there! ${pct}% of your bills are covered this month.`;
  } else if(pct>=50){
    icon=IC.butterfly;
    msg=`Over halfway! ${pct}% of bills watered. Your garden is thriving.`;
  } else if(pct>=25){
    icon=IC.bee;
    msg=`Making progress: ${pct}% covered. Keep that hustle flowing.`;
  } else {
    icon=IC.droplet;
    msg=`Every drop counts. ${pct}% of bills watered so far.`;
  }
  popup.innerHTML=`
    <div class="wp-icon">${icon}</div>
    <div class="wp-amount">+${fmt(amt)}</div>
    <div class="wp-detail">from <strong>${esc(src)}</strong></div>
    <div class="wp-detail">${applied?'Applied to: '+esc(applied):''}</div>
    <div class="wp-detail" style="margin-top:6px;font-weight:600;color:var(--sage-d)">${msg}</div>
    <button type="button" class="wp-close" data-action="dismissWateringPopup">Nice!</button>
  `;
  document.body.appendChild(popup);
  setTimeout(()=>{if(popup.parentElement)popup.remove()},5000);
}

// ── STAGE-UP CELEBRATIONS ────────────────────────────────────────────────────
// A watering that pushes a plant across a stage boundary (budding / blooming)
// earns a small confetti burst + one celebration line. Full bloom (100%) keeps
// the big overlay celebration. Queued so they never stack over the watering
// popup or the celebration overlay.
let _pendingStageUps=[];
const STAGE_LINES={
  budded:(n)=>`${n} just budded! Halfway watered.`,
  blooming:(n)=>`${n} is blooming! 75% watered and climbing.`,
};
function flushStageUps(list){
  (list||[]).forEach((s,i)=>{
    setTimeout(()=>{
      showStageToast(s);
      if(i===0)stageBurst();
    },i*2700);
  });
}
function stageBurst(){
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  if(confettiRAF)return; // never stomp a celebration already running
  startConfetti(45);
  setTimeout(stopConfetti,1400);
}
function showStageToast(s){
  const line=(STAGE_LINES[s.phase]||STAGE_LINES.budded)(esc(s.name));
  const t=document.createElement('div');
  t.className='toast stage-toast';
  t.innerHTML=`${s.phase==='blooming'?IC.sparkle:IC.leaf} ${line}`;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),2500);
}

function showCelebration(withered){
  const mainWeedNow=bills.filter(b=>!b.archived).length?bills.filter(b=>!b.archived).reduce((a,b)=>billAmt(a)>=billAmt(b)?a:b):null;
  const isMain=mainWeedNow&&withered.some(b=>b.id===mainWeedNow.id);

  // sort by amount descending — biggest first drives the celebration tone
  const sorted=[...withered].sort((a,b)=>billAmt(b)-billAmt(a));
  const topBill=sorted[0];
  const topTier=getTier(billAmt(topBill));
  const cel=getCelebration(topBill,topTier);

  // total amount cleared this payment
  const totalCleared=withered.reduce((s,b)=>s+billAmt(b),0);

  // emoji headline
  document.getElementById('ov-emoji').innerHTML=nbCelebCreature(topTier.key)||cel.emoji;

  // title — if multiple bills, show count
  if(withered.length>1){
    document.getElementById('ov-title').textContent=`${withered.length} Plants Bloomed!`;
  }else{
    document.getElementById('ov-title').textContent=cel.title;
  }

  // tier badge — show highest tier
  document.getElementById('ov-tier').innerHTML=`${topTier.spriteD} ${topTier.label}${withered.length>1?' + more':''}`;

  // message — list all bills if multiple
  if(withered.length>1){
    const names=sorted.map(b=>`${getTier(billAmt(b)).spriteD} ${esc(b.name)}`).join(', ');
    document.getElementById('ov-sub').innerHTML=`${names}, all fully watered! ${fmt(totalCleared)} in bills handled in one shot.`;
  }else{
    document.getElementById('ov-sub').innerHTML=cel.msg;
  }

  document.getElementById('overlay').style.display='flex';
  if(window.Gnome)Gnome.react('celebrate');
  if(window.FX)FX.sound('chime');

  // intensity scales with total amount cleared
  if(totalCleared>=500||isMain){
    startConfetti(160); // massive
  }else if(totalCleared>=200||withered.length>1){
    startConfetti(100); // medium
  }else if(totalCleared>=100){
    startConfetti(60);  // light
  }else{
    stopConfetti(); // no confetti for tiny bills
  }

  // frog more likely for bigger celebrations
  const frogChance=totalCleared>=500?0.9:totalCleared>=200?0.6:totalCleared>=100?0.35:0.15;
  showFrogInCelebration(Math.random()<frogChance);

  // extra butterflies for big amounts
  if(totalCleared>=300){
    setTimeout(spawnButterfly,400);
    setTimeout(spawnButterfly,900);
  }

  // No promo here. Standing rule: promos never ride a celebration. This overlay
  // used to carry a rotating affiliate nudge, which put a sales pitch in the
  // moment a bill finished being paid.
  // The daily promo tip on the Garden tab is the surface that sells; this one
  // belongs to the person who just cleared a bill.
  pushOverlayState();
}

function closeOverlay(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  document.getElementById('overlay').style.display='none';
  stopConfetti();showFrogInCelebration(false);
  // Any stage-ups from the same watering fire after the overlay is dismissed.
  if(_pendingStageUps.length){
    const q=_pendingStageUps;_pendingStageUps=[];
    setTimeout(()=>flushStageUps(q),450);
  }
}

function startConfetti(count){
  count=count||110;
  const c=document.getElementById('confetti-c');c.style.display='block';c.width=window.innerWidth;c.height=window.innerHeight;
  const ctx=c.getContext('2d');
  const cols=['#FFD24A','#FFF3A0','#FF9F6E','#8FE8B8','#C9A2FF','#9FC2FF','#FFFFFF'];
  const ps=Array.from({length:count},()=>({x:Math.random()*c.width,y:Math.random()*c.height-c.height,r:Math.random()*7+3,col:cols[Math.floor(Math.random()*cols.length)],rot:Math.random()*360,rv:Math.random()*4-2,vx:Math.random()*3-1.5,vy:Math.random()*4+2,sq:Math.random()<.5}));
  function draw(){ctx.clearRect(0,0,c.width,c.height);ps.forEach(p=>{ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot*Math.PI/180);ctx.fillStyle=p.col;if(p.sq)ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r*1.5);else{ctx.beginPath();ctx.arc(0,0,p.r/2,0,Math.PI*2);ctx.fill();}ctx.restore();p.x+=p.vx;p.y+=p.vy;p.rot+=p.rv;if(p.y>c.height)p.y=-20;});confettiRAF=requestAnimationFrame(draw);}
  draw();
}
function stopConfetti(){if(confettiRAF){cancelAnimationFrame(confettiRAF);confettiRAF=null;}const c=document.getElementById('confetti-c');c.getContext('2d').clearRect(0,0,c.width,c.height);c.style.display='none';}

// ── BILLS TAB ─────────────────────────────────────────────────────────────────
// opts (optional) points the same code at another form: the welcome pop-up's
// bill question passes its own field ids plus a fixed type/repeats. Returns
// true when the bill was planted.
async function addBill(opts){ if(addBill.busy) return false; addBill.busy=true; try{ return await addBillRun(opts&&opts.nameId?opts:{}); } finally{ addBill.busy=false; } }
async function addBillRun(o){
  const nameId=o.nameId||'b-name',amtId=o.amtId||'b-amt';
  const name=document.getElementById(nameId).value.trim();
  const amount=parseFloat(document.getElementById(amtId).value);
  const type=o.type||document.getElementById('b-type').value;
  const repeats='repeats' in o?!!o.repeats:document.getElementById('b-repeat').value==='1';
  // An empty form is told what it needs instead of silently doing nothing.
  if(!name||!amount||amount<=0){showToast('Give the bill a name and a monthly amount.');document.getElementById(!name?nameId:amtId).focus();return false}
  const btn=document.getElementById(o.btnId||'add-bill-btn');btn.textContent='Planting...';btn.disabled=true;
  let planted=false;
  try{
    setSyncStatus('syncing');
    const startMonth=CM();
    const{data,error}=await sb.from('bills').insert({name,amount,type,is_final:false,repeats,start_month:startMonth,user_id:currentUser.id}).select();
    if(error)throw error;
    const bill={id:data[0].id,name,amount,type,isFinal:false,repeats,archived:false,startMonth};bills.push(bill);
    await sb.from('monthly_amounts').upsert({bill_id:data[0].id,month:CM(),amount,user_id:currentUser.id},{onConflict:'bill_id,month'});
    monthlyAmounts[data[0].id+'__'+CM()]={amount};
    // Auto-apply surplus to new bill
    const surplus=getSurplus(CM());
    if(surplus>0){
      const applying=Math.min(surplus,amount);
      const surplusTargets=[{billId:data[0].id,billName:name,applied:applying}];
      const{data:spData,error:spErr}=await sb.from('payments').insert({source:'Surplus rollover',amount:applying,month:CM(),targets:surplusTargets,pay_date:todayStr(),user_id:currentUser.id}).select();
      if(!spErr&&spData){
        payments.push({id:spData[0].id,source:'Surplus rollover',amount:applying,month:CM(),targets:surplusTargets,created_at:spData[0].created_at,pay_date:todayStr()});
        showToast(`Bill planted! ${fmt(applying)} surplus applied.`);
      } else {
        showToast('Bill planted!');
      }
    } else {
      showToast('Bill planted!');
    }
    setSyncStatus('synced');
    document.getElementById(nameId).value='';document.getElementById(amtId).value='';
    renderBillList();renderGarden();renderCurrentTab();
    planted=true;
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
  btn.textContent=o.btnLabel||'Plant this bill';btn.disabled=false;
  return planted;
}

async function editBillAmt(id){
  const b=bills.find(x=>x.id===id);if(!b)return;
  // The month the Bills tab is showing (shared with Garden/Growth), so a bill
  // can be set for last month, not only the current one.
  const cm=getViewMonth();
  // Variable bill already set this month: open the full month grid to edit any month.
  if(!b.repeats&&monthlyAmounts[b.id+'__'+cm]){showVarBillEditor(b);return}
  // Fixed bill, or variable bill with no amount yet this month: set this month directly.
  // A fixed bill asks: just this month, or this month and every month after
  // (a price increase). Forward also changes the bill's planted amount, which
  // is what each new month starts from.
  const mon=MNAMES[+cm.split('-')[1]-1];
  const scope=b.repeats?{once:`Just ${mon}`,forward:`${mon} and every month after`}:null;
  openAmtModal(`${b.repeats?'Update':'Set'} "${b.name}" for ${ymLabel(cm)}`,billAmt(b,cm),async(v,sc)=>{
    if(v<0)return;
    // $0 = not due this month (e.g. an every-other-month bill). Never pushed
    // forward: a $0 planted amount would zero every month after.
    if(v===0)sc='once';
    try{
      setSyncStatus('syncing');
      const uid=currentUser.id;
      const put=async(mk,amt)=>{const r=await sb.from('monthly_amounts').upsert({bill_id:id,month:mk,amount:amt,user_id:uid},{onConflict:'bill_id,month'});if(r&&r.error)throw new Error(r.error.message||'Could not save');monthlyAmounts[id+'__'+mk]={amount:amt};};
      if(b.repeats&&sc==='forward'&&v!==b.amount){
        // Months before cm with no saved amount fall back to the planted
        // amount. Lock the old number into them first so changing the
        // planted amount can't rewrite history.
        const earliestPay=payments.length?payments.reduce((m,p)=>p.month<m?p.month:m,payments[0].month):cm;
        const from=b.startMonth&&b.startMonth>earliestPay?b.startMonth:earliestPay;
        if(from<cm){
          for(const mk of getMonthRange(from,cm).slice(0,-1)){
            if(!monthlyAmounts[id+'__'+mk]&&billActiveInMonth(b,mk))await put(mk,b.amount);
          }
        }
        const r=await sb.from('bills').update({amount:v}).eq('id',id);
        if(r&&r.error)throw new Error(r.error.message||'Could not save');
        b.amount=v;
        for(const mk of getMonthRange(cm,CM()))await put(mk,v);
      }else{
        await put(cm,v);
      }
      setSyncStatus('synced');renderBillList();renderGarden();renderGrowth();
      if(v===0)showToast(`${b.name} marked not due for ${ymLabel(cm)}`);
      else if(b.repeats)showToast(sc==='forward'?`${b.name} is now ${fmt(v)} from ${ymLabel(cm)} on`:`${b.name} set to ${fmt(v)} for ${ymLabel(cm)} only`);
      // No icon here: showToast() renders with textContent (it prints
      // user-supplied bill names), so an IC.* SVG string would show as markup.
      else if(!b.repeats)showToast(`${b.name} locked in for ${ymLabel(cm)}`);
    }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
  },scope);
}

function showVarBillEditor(b){
  const[cy,cmo]=CM().split('-').map(Number);
  const months=getMonthRange(ym(new Date(cy,cmo-12,1)),CM());
  const existing=document.getElementById('var-editor');
  if(existing)existing.remove();
  const el=document.createElement('div');
  el.id='var-editor';
  el.style.cssText='position:fixed;inset:0;background:rgba(40,60,40,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  el.innerHTML=`<div style="background:var(--bg);border:2px solid var(--sage-d);border-radius:16px;padding:22px 20px;max-width:360px;width:100%">
    <div style="font-family:var(--serif);font-size:15px;font-weight:600;color:var(--sage-d);margin-bottom:4px">${esc(b.name)}</div>
    <div style="font-size:11px;color:var(--muted);font-style:italic;margin-bottom:14px">Variable bill. Tap any month to set its amount</div>
    <div class="var-month-grid" id="vmg"></div>
    <button type="button" class="btn btn-sage" style="margin-top:14px" data-action="closeVarEditor">Done ✓</button>
  </div>`;
  document.body.appendChild(el);
  pushOverlayState();
  const grid=document.getElementById('vmg');
  months.forEach(mk=>{
    const existing=monthlyAmounts[b.id+'__'+mk];
    const cell=document.createElement('div');
    cell.className='var-month-cell';
    cell.innerHTML=`<div class="vmc-name">${MNAMES[+mk.split('-')[1]-1]}${mk.split('-')[0]!==String(cy)?' '+mk.slice(2,4):''}</div><div class="vmc-amt ${existing?'':'empty'}">${existing?fmt(existing.amount):'not set'}</div>`;
    cell.addEventListener('click',()=>{
      openAmtModal(`${b.name} · ${ymLabel(mk)}`,existing?existing.amount:'',async(v)=>{
        if(v<0)return;
        setSyncStatus('syncing');
        await sb.from('monthly_amounts').upsert({bill_id:b.id,month:mk,amount:v,user_id:currentUser.id},{onConflict:'bill_id,month'});
        monthlyAmounts[b.id+'__'+mk]={amount:v};setSyncStatus('synced');
        cell.querySelector('.vmc-amt').textContent=fmt(v);cell.querySelector('.vmc-amt').classList.remove('empty');
        renderBillList();renderGarden();renderGrowth();
      });
    });
    grid.appendChild(cell);
  });
}
function closeVarEditor(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  const e=document.getElementById('var-editor');if(e)e.remove();
}

// Take the money already watered onto a bill and give it to the bills still
// owed, smallest first. The bill must already be out of the active set
// (archived or removed) so snowballOrder skips it. fromMonth limits this to
// that month and later; leave it off to cover every month. Returns how many
// waterings changed.
async function moveBillMoney(id,fromMonth){
  const affected=payments.filter(p=>(!fromMonth||p.month>=fromMonth)&&(p.targets||[]).some(t=>t.billId===id));
  // Process by month, oldest first
  const sorted=[...affected].sort((a,b)=>(a.pay_date||a.created_at).localeCompare(b.pay_date||b.created_at));
  for(const pay of sorted){
    let freed=pay.targets.filter(t=>t.billId===id).reduce((s,t)=>s+t.applied,0);
    pay.targets=pay.targets.filter(t=>t.billId!==id);
    if(freed>0){
      const order=snowballOrder(pay.month);
      order.forEach(b=>{
        if(freed<=0)return;
        const needed=Math.max(0,billAmt(b,pay.month)-billPaid(b,pay.month));
        const applying=Math.min(freed,needed);
        if(applying<=0)return;
        const existing=pay.targets.find(t=>t.billId===b.id);
        if(existing){existing.applied+=applying;}
        else{pay.targets.push({billId:b.id,billName:b.name,applied:applying});}
        freed-=applying;
      });
    }
    await sb.from('payments').update({targets:pay.targets}).eq('id',pay.id);
  }
  return affected.length;
}

// Archive asks which month the bill stopped being paid, then archives it
// from that month on.
function archiveBill(id){
  const b=bills.find(x=>x.id===id);if(!b)return;
  openStopModal(b);
}

// Months the stop picker offers, newest first: this month back to when the
// bill started (or the first logged month for older bills with no start).
function stopMonthChoices(b){
  const cm=CM();
  const first=b.startMonth||payments.reduce((lo,p)=>p.month<lo?p.month:lo,cm);
  return getMonthRange(first<cm?first:cm,cm).reverse().slice(0,36);
}

// endMonth is the first month the bill was NOT paid. Money watered onto it
// from then on moves to the bills still owed. Earlier months stay as logged.
async function archiveBillFrom(...a){ if(archiveBillFrom.busy) return; archiveBillFrom.busy=true; try{ return await archiveBillFromRun(...a); } finally{ archiveBillFrom.busy=false; } }
async function archiveBillFromRun(id,endMonth){
  const b=bills.find(x=>x.id===id);if(!b)return;
  const cm=CM();
  if(!endMonth||endMonth>cm)endMonth=cm;
  try{
    setSyncStatus('syncing');
    await sb.from('bills').update({archived:true,end_month:endMonth}).eq('id',id);
    b.archived=true;b.endMonth=endMonth;
    const moved=await moveBillMoney(id,endMonth);
    setSyncStatus('synced');renderBillList();renderGarden();
    showToast(!moved?'Bill archived. History preserved!'
      :endMonth===cm?'Bill archived. This month\'s money moved to your other bills.'
      :`Bill archived. Money from ${ymLabel(endMonth)} on moved to your other bills.`);
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
}

async function unarchiveBill(id){
  const b=bills.find(x=>x.id===id);if(!b)return;
  try{
    setSyncStatus('syncing');
    await sb.from('bills').update({archived:false}).eq('id',id);
    b.archived=false;b.endMonth=null;
    setSyncStatus('synced');renderBillList();renderGarden();
    showToast('Bill restored to garden!');
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
}

async function removeBill(id){
  if(!confirm('Permanently delete this bill?\n\nThis removes all history. Use Archive instead if you just no longer have this bill.'))return;
  try{
    setSyncStatus('syncing');
    // Remove bill from local array first so snowballOrder excludes it
    bills=bills.filter(b=>b.id!==id);
    const moved=await moveBillMoney(id);
    await sb.from('bills').delete().eq('id',id);
    setSyncStatus('synced');renderBillList();renderGarden();
    showToast(moved?'Bill deleted. Income redistributed to other bills':'Bill deleted');
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
}

function renderBillList(){
  const el=document.getElementById('bill-list');if(!el)return;
  if(!bills.length){el.innerHTML='';return}
  // Follows the month picked with the arrows (same month as Garden/Growth), so
  // last month's bill amounts can be set after the month rolls over.
  const cm=getViewMonth(),mon=MNAMES[+cm.split('-')[1]-1],isCur=cm===CM();
  // A variable bill with no monthly_amounts row for this month silently reuses
  // its last amount (billAmt fallback) — surface that state instead of hiding it.
  const needsSet=b=>!b.repeats&&!monthlyAmounts[b.id+'__'+cm];
  // Bills that count in the viewed month. For the current month this is every
  // non-archived bill; for a past month it also keeps a bill archived later
  // and drops one planted later.
  const activeAll=bills.filter(b=>isCur?!b.archived:billActiveInMonth(b,cm));
  const mainWeed=activeAll.length?activeAll.reduce((a,b)=>billAmt(a,cm)>=billAmt(b,cm)?a:b):null;
  const unsetBills=activeAll.filter(needsSet);
  const active=[...unsetBills,...activeAll.filter(b=>!needsSet(b))];
  const archived=bills.filter(b=>b.archived&&!activeAll.includes(b));

  const billCard=(b,isArchived)=>{
    const bA=billAmt(b,cm),bP=Math.min(billPaid(b,cm),bA),pct=bA>0?Math.min(100,bP/bA*100):0;
    const tier=getTier(bA);
    const bid=esc(b.id);
    const unset=!isArchived&&needsSet(b);
    const meta=isArchived?(b.endMonth?`archived · stopped ${ymLabel(b.endMonth)}`:'archived')
      :unset?`~${fmt(bA)} last amount · ${tier.label} · variable · ${Math.round(pct)}% watered`
      :`${fmt(bA)}/mo · ${tier.label} · ${b.repeats?'fixed':`variable · ✓ ${mon} set`} · ${Math.round(pct)}% watered`;
    const isMain=mainWeed&&b.id===mainWeed.id;
    const done=!isArchived&&bA>0&&bP>=bA;
    return`<div class="bill-row${unset?' bill-needs-set':''}${isArchived?' is-archived':''}${done?' is-done':''}">
      <div class="bill-ico">${isArchived?IC.box:tier.spriteD}</div>
      <div class="bill-body">
        <div class="bill-top">
          <div class="bill-name">${esc(b.name)}${isMain?' <span class="pill pill-main">Main plant</span>':''}${unset?` <span class="pill pill-next">Needs ${mon} amount</span>`:''}${done?' <span class="pill pill-done">Bloomed</span>':''}${!isArchived&&bA===0?' <span class="pill">Not due</span>':''}</div>
          <div class="bill-meta">${meta}</div>
        </div>
        ${!isArchived?`<div class="plant-bar"><i style="width:${pct}%"></i></div>`:''}
      </div>
      <div class="bill-actions">
        ${!isArchived?(unset
          ?`<button type="button" class="btn btn-sm btn-primary" title="Set this bill's amount for ${mon}" data-action="editBillAmt" data-arg="${bid}">Set ${mon}</button>`
          :`<button type="button" class="btn btn-sm" title="Edit amount for ${mon}" data-action="editBillAmt" data-arg="${bid}">Edit</button>`):''}
        ${!isArchived&&!b.archived?`<button type="button" class="btn btn-sm" title="No longer paying this bill? Archive it to keep your history." data-action="archiveBill" data-arg="${bid}">Archive</button>`:''}
        ${isArchived?`<button type="button" class="btn btn-sm" data-action="unarchiveBill" data-arg="${bid}">Restore</button>`:''}
        <button type="button" class="btn btn-sm btn-danger" title="${isArchived?'Permanently delete this bill':'Entered by mistake? Deletes everything permanently.'}" data-action="removeBill" data-arg="${bid}">Delete</button>
      </div>
    </div>`;
  };

  let html=monthSwitcherHtml(cm);
  if(unsetBills.length){
    const n=unsetBills.length;
    html+=`<div class="unset-banner">${IC.droplet} <strong>${n===1?'1 bill needs':n+' bills need'} a ${ymLabel(cm)} amount.</strong> Skipping a variable bill does not make it $0. It keeps using its last amount until you set ${n===1?'it':'each one'}. Tap <strong>set ${mon}</strong> to lock in ${isCur?"this month's":`${mon}'s`} number.</div>`;
  }
  html+=active.map(b=>billCard(b,false)).join('');

  if(archived.length){
    html+=`<div class="bill-archived-sec">
      <div class="sec-lbl">Archived bills</div>
      <div class="bill-archived-sub">Bills you no longer pay. History kept, removed from your garden.</div>
      ${archived.map(b=>billCard(b,true)).join('')}
    </div>`;
  }

  el.innerHTML=html;
}

// ── GROWTH TAB ────────────────────────────────────────────────────────────────
function renderGrowth(){
  const cm=getViewMonth(),yr=cm.split('-')[0];
  const mPays=payments.filter(p=>p.month===cm);
  const mEarned=mPays.reduce((s,p)=>s+p.amount,0);
  const mBT=activeBillsFor(cm).reduce((s,b)=>s+billAmt(b,cm),0);
  // mPaid = raw applied amounts (for "Bills watered" dollar stat)
  const mPaid=mPays.reduce((s,p)=>s+(p.targets||[]).reduce((a,t)=>a+t.applied,0),0);
  const withered=activeBillsFor(cm).filter(b=>billAmt(b,cm)>0&&billPaid(b,cm)>=billAmt(b,cm)).length;
  const yrPays=payments.filter(p=>p.month.startsWith(yr));
  const yrEarned=yrPays.reduce((s,p)=>s+p.amount,0);
  const {pct:oPct}=coveragePct(cm);
  const months=Array.from({length:12},(_,i)=>`${yr}-${String(i+1).padStart(2,'0')}`);
  const allYears=[...new Set(payments.map(p=>p.month.split('-')[0]))].sort().reverse();

  // streak — only count completed months (start from last month, not current)
  const streak=computeStreak();

  // goal
  const goal=userGoal||0;
  const goalPct=goal>0?Math.min(100,Math.round(mEarned/goal*100)):0;

  const logHtml=(()=>{
    const pays=[...mPays].sort((a,b)=>b.created_at>a.created_at?1:-1);
    if(!pays.length)return'<div class="log-entry" style="color:var(--dim);font-style:italic">No payments yet this month...</div>';
    return pays.map(p=>{
      const ds=p.pay_date?new Date(p.pay_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):new Date(p.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric'});
      const tgs=(p.targets||[]).map(t=>`<span class="log-weed">${esc(t.billName)}</span>`).join(', ');
      const pid=esc(p.id);
      return`<div class="log-entry" style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px"><div style="flex:1"><span style="color:var(--dim)">${ds}</span> · <span class="log-dmg">${fmt(p.amount)}</span> <span class="log-src">${esc(p.source)}</span>${tgs?' → '+tgs:''}</div><div style="display:flex;gap:2px;flex-shrink:0"><button type="button" data-action="editPayment" data-arg="${pid}" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--sage-d);padding:1px 3px;line-height:1" title="Edit">edit</button><button type="button" data-action="deletePayment" data-arg="${pid}" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--red-text);padding:1px 3px;line-height:1" title="Delete">✕</button></div></div>`;
    }).join('');
  })();

  const monthCells=months.map(mk=>{
    const e=payments.filter(p=>p.month===mk).reduce((s,p)=>s+p.amount,0);
    const has=payments.some(p=>p.month===mk);
    return`<div class="yr-cell ${has?'has-data':''}"><div class="mn">${MNAMES[+mk.split('-')[1]-1]}</div><div class="mv">${e>0?(e>=1000?'$'+(e/1000).toFixed(1)+'k':'$'+Math.round(e)):'·'}</div></div>`;
  }).join('');

  const allTimeHtml=allYears.length>1?`<div class="sec-lbl" style="margin-top:14px">All-time harvest</div><div class="card-light">${allYears.map(y=>{const yE=payments.filter(p=>p.month.startsWith(y)).reduce((s,p)=>s+p.amount,0),yP=payments.filter(p=>p.month.startsWith(y)).length;return`<div class="yr-all-row"><span style="color:var(--muted)">${y}</span><span><span style="color:var(--gold-d)">${fmtShort(yE)}</span> <span style="color:var(--dim);font-size:10px">(${yP} waterings)</span></span></div>`;}).join('')}</div>`:'';

  const activeBills=activeBillsFor(cm).sort((a,b)=>billAmt(b,cm)-billAmt(a,cm));

  const isCurrentMonth=cm===CM();

  // ── LAST MONTH'S HARVEST ────────────────────────────────────────────────────
  // Month rollover used to reset silently. This card sums up the previous
  // month from the persisted watering log (payments + per-month bill amounts —
  // the same data the month switcher reads), shown whenever the previous month
  // had any waterings. Always available at the top of the current-month view.
  let harvestHtml='';
  if(isCurrentMonth){
    const[hy,hm]=cm.split('-').map(Number);
    const pm=ym(new Date(hy,hm-2,1));
    const pmPays=payments.filter(p=>p.month===pm);
    if(pmPays.length){
      const pmBills=activeBillsFor(pm);
      const pmWatered=pmPays.reduce((s,p)=>s+p.amount,0);
      const pmBloomed=pmBills.filter(b=>billAmt(b,pm)>0&&billPaid(b,pm)>=billAmt(b,pm)).length;
      const pmCov=coveragePct(pm).pct;
      const stripHtml=[...pmBills].sort((a,b)=>billAmt(b,pm)-billAmt(a,pm)).map(b=>{
        const hA=billAmt(b,pm),hP=Math.min(billPaid(b,pm),hA);
        const hPct=hA>0?Math.min(100,hP/hA*100):0,hDone=hP>=hA;
        return`<span class="harvest-plant" title="${esc(b.name)} · ${Math.round(hPct)}% · ${SM_STAGE_LABELS[smStage(hPct,hDone)]}">${smStageArt(getTier(hA).key,hPct,hDone)}</span>`;
      }).join('');
      harvestHtml=`<div class="harvest-card">
        <div class="harvest-head"><span class="harvest-title">${MNAMES[hm-2<0?11:hm-2]} harvest</span><button type="button" class="btn btn-sm harvest-view" data-action="viewHarvestMonth" data-arg="${pm}">view month</button></div>
        <div class="harvest-line">${pmCov}% covered · ${fmt(pmWatered)} watered · ${pmBloomed} plant${pmBloomed===1?'':'s'} bloomed</div>
        <div class="harvest-strip">${stripHtml}</div>
      </div>`;
    }
  }

  document.getElementById('growth-content').innerHTML=`
  ${monthSwitcherHtml(cm)}
  ${harvestHtml}
  <div class="sec-lbl" style="margin-top:12px">${isCurrentMonth?'This month':'Summary'}, ${ymLabel(cm)}</div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-lbl">Side hustle earned</div><div class="stat-val gold">${fmt(mEarned)}</div></div>
    <div class="stat-card"><div class="stat-lbl">Bills watered</div><div class="stat-val">${fmt(mPaid)}</div></div>
    <div class="stat-card"><div class="stat-lbl">Plants bloomed</div><div class="stat-val green">${withered}</div></div>
    <div class="stat-card"><div class="stat-lbl">Waterings logged</div><div class="stat-val">${mPays.length}</div></div>
  </div>
  ${streak>=2?`<div class="streak-banner">${IC.fire} ${streak}-month streak! Keep growing!</div>`:''}
  <div class="card-light" style="margin-bottom:8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${goal>0?'8px':'0'}">
      <div><div style="font-size:12px;font-weight:600;color:var(--dark)">Monthly income goal</div><div style="font-size:10px;color:var(--muted);margin-top:2px">${goal>0?fmtShort(mEarned)+' of '+fmtShort(goal)+' earned this month':'No goal set yet'}</div></div>
      <button type="button" class="btn btn-sm" style="background:var(--bg3);color:var(--dark);border:1px solid var(--sage);width:auto" data-action="setGoal">${goal>0?'edit goal':'set goal'}</button>
    </div>
    ${goal>0?`<div class="grow-bar-wrap"><div class="grow-bar" style="width:${goalPct}%;background:linear-gradient(90deg,var(--gold),var(--gold-d))"></div></div><div style="font-size:10px;color:var(--muted);margin-top:3px;text-align:right">${goalPct}% of goal</div>`:''}
  </div>
  <div class="sec-lbl" style="margin-top:14px">${yr} harvest</div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-lbl">Total earned</div><div class="stat-val gold">${fmt(yrEarned)}</div></div>
    <div class="stat-card"><div class="stat-lbl">Waterings</div><div class="stat-val">${yrPays.length}</div></div>
  </div>
  <div class="card-light"><div class="sec-lbl" style="margin-bottom:6px">Monthly earnings, ${yr}</div><div class="yr-month-grid">${monthCells}</div></div>
  <div class="sec-lbl" style="margin-top:14px">Badges</div><div class="badges">${badgesFor().map(b=>`<div class="badge ${b.earned?'earned':''}" title="${esc(b.hint)}"><span class="badge-ring" aria-hidden="true">${BADGE_ART[b.key]||''}</span><span class="badge-name">${esc(b.name)}</span><span class="badge-hint">${b.earned?'Earned':esc(b.hint)}</span></div>`).join('')}</div>
  ${allTimeHtml}
  <div class="sec-lbl" style="margin-top:14px">Watering log, ${ymLabel(cm)}</div>
  <div class="log-scroll">${logHtml}</div>
  ${isCurrentMonth?`<details class="card-light reset-zone" style="margin-top:10px">
    <summary style="cursor:pointer;font-size:11px;color:var(--muted);list-style:none">Danger zone</summary>
    <div style="font-size:11px;color:var(--red-text);margin:8px 0">Manual reset permanently deletes this month's waterings. This cannot be undone.</div>
    <button type="button" class="btn btn-sm btn-danger" style="width:auto" data-action="manualReset">Reset ${ymLabel(cm)}</button>
  </details>`:''}`;
}

// ── AUTO RESET ────────────────────────────────────────────────────────────────
async function checkAutoReset(){
  const cm=CM(),uid=currentUser.id;
  const missing=bills.filter(b=>b.repeats&&!monthlyAmounts[b.id+'__'+cm]);
  for(const b of missing){
    try{await sb.from('monthly_amounts').upsert({bill_id:b.id,month:cm,amount:b.amount,user_id:uid},{onConflict:'bill_id,month'});monthlyAmounts[b.id+'__'+cm]={amount:b.amount};}catch(e){}
  }
  const variable=bills.filter(b=>!b.archived&&!b.repeats&&!monthlyAmounts[b.id+'__'+cm]);
  if(variable.length)setTimeout(()=>{showToast(`New month! ${variable.length} variable bill${variable.length===1?'':'s'} need${variable.length===1?'s':''} a ${MNAMES[+cm.split('-')[1]-1]} amount (Bills tab)`);},1500);
}

async function manualReset(){
  const cm=CM();if(!confirm(`Delete all waterings for ${ymLabel(cm)}?`))return;
  try{
    setSyncStatus('syncing');
    for(const p of payments.filter(p=>p.month===cm))await sb.from('payments').delete().eq('id',p.id);
    payments=payments.filter(p=>p.month!==cm);setSyncStatus('synced');renderGarden();renderGrowth();showToast('Month reset!');
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
}

function showToast(msg){
  const t=document.createElement('div');t.className='toast';t.textContent=msg;
  document.body.appendChild(t);setTimeout(()=>t.remove(),2500);
}

// ── PAYMENT EDIT/DELETE ────────────────────────────────────────────────────────
let _editPayId=null;
function editPayment(id){
  const p=payments.find(x=>x.id===id);if(!p)return;
  _editPayId=id;
  document.getElementById('pe-src').value=p.source||'';
  document.getElementById('pe-amt').value=p.amount||'';
  document.getElementById('pe-date').value=p.pay_date||todayStr();
  document.getElementById('pay-edit-modal').style.display='flex';
  pushOverlayState();
}
function closePayEdit(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  document.getElementById('pay-edit-modal').style.display='none';_editPayId=null;
}
async function confirmPayEdit(){ if(confirmPayEdit.busy) return; confirmPayEdit.busy=true; try{ return await confirmPayEditRun(); } finally{ confirmPayEdit.busy=false; } }
async function confirmPayEditRun(){
  const src=document.getElementById('pe-src').value.trim();
  const amt=parseFloat(document.getElementById('pe-amt').value);
  const dt=document.getElementById('pe-date').value;
  if(!src||isNaN(amt)||amt<=0){showToast('Fill in all fields');return;}
  try{
    setSyncStatus('syncing');
    await sb.from('payments').update({source:src,amount:amt,pay_date:dt}).eq('id',_editPayId);
    const p=payments.find(x=>x.id===_editPayId);
    if(p){p.source=src;p.amount=amt;p.pay_date=dt;}
    setSyncStatus('synced');closePayEdit();renderGarden();renderGrowth();
    showToast('Payment updated!');
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
}
async function deletePayment(id){
  if(!confirm('Delete this payment entry?'))return;
  try{
    setSyncStatus('syncing');
    await sb.from('payments').delete().eq('id',id);
    payments=payments.filter(p=>p.id!==id);
    setSyncStatus('synced');renderGarden();renderGrowth();
    showToast('Payment deleted');
  }catch(e){setSyncStatus('error');showToast('Error: '+e.message);}
}

// ── MONTHLY GOAL ───────────────────────────────────────────────────────────────
function setGoal(){
  openAmtModal('Monthly income goal ($)',userGoal||'',async v=>{
    const uid=currentUser.id;
    if(v>0){
      userGoal=v;
      await sb.from('user_settings').upsert({user_id:uid,monthly_goal:v,updated_at:new Date().toISOString()},{onConflict:'user_id'});
      renderGrowth();showToast('Goal set: '+fmtShort(v)+'/mo');
    } else {
      userGoal=0;
      await sb.from('user_settings').upsert({user_id:uid,monthly_goal:0,updated_at:new Date().toISOString()},{onConflict:'user_id'});
      renderGrowth();
    }
  });
}

// ── AMOUNT MODAL ───────────────────────────────────────────────────────────────
let _amtCallback=null;
// scope (optional): {once:'Just Oct', forward:'Oct and every month after'}
// shows a two-choice picker and the callback gets (value, 'once'|'forward').
function openAmtModal(label,defaultVal,cb,scope){
  document.getElementById('amt-modal-label').textContent=label;
  const input=document.getElementById('amt-modal-input');
  input.value=defaultVal||'';
  const fs=document.getElementById('amt-modal-scope');
  if(fs){
    fs.style.display=scope?'':'none';
    if(scope){
      document.getElementById('amt-scope-once').textContent=scope.once;
      document.getElementById('amt-scope-forward').textContent=scope.forward;
      fs.querySelector('input[value="forward"]').checked=true;
    }
  }
  _amtCallback=cb;
  document.getElementById('amt-modal').style.display='flex';
  pushOverlayState();
  setTimeout(()=>input.focus(),100);
}
function closeAmtModal(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  document.getElementById('amt-modal').style.display='none';_amtCallback=null;
}
function confirmAmtModal(){
  const v=parseFloat(document.getElementById('amt-modal-input').value);
  const fs=document.getElementById('amt-modal-scope');
  const scope=fs&&fs.style.display!=='none'?(fs.querySelector('input[name="amt-scope"]:checked')||{}).value||'forward':null;
  if(!isNaN(v)&&_amtCallback){_amtCallback(v,scope);closeAmtModal();}
}

// ── STOP-MONTH MODAL (archive) ───────────────────────────────────────────────
let _stopBillId=null;
function openStopModal(b){
  _stopBillId=b.id;
  document.getElementById('stop-modal-label').textContent=`When did you stop paying ${b.name}?`;
  const sel=document.getElementById('stop-modal-month');
  const cm=CM();
  sel.innerHTML=stopMonthChoices(b).map(m=>`<option value="${m}">${ymLabel(m)}${m===cm?' (this month)':''}</option>`).join('');
  sel.value=cm;
  document.getElementById('stop-modal').style.display='flex';
  pushOverlayState();
  setTimeout(()=>sel.focus(),100);
}
function closeStopModal(fromHistory){
  if (fromHistory !== true && closeOverlayViaHistory()) return;
  document.getElementById('stop-modal').style.display='none';_stopBillId=null;
}
function confirmStopModal(){
  const id=_stopBillId,m=document.getElementById('stop-modal-month').value;
  if(!id)return;
  closeStopModal();
  archiveBillFrom(id,m);
}

// ── EVENT WIRING (replaces inline handlers — required for CSP 'self' only) ──
//
// All inline onclick/onkeydown/oninput/onchange handlers from index.html have
// been replaced with addEventListener calls below + a delegated click handler
// for dynamically-injected `data-action` buttons.

// Map of data-action names to handler functions. Used by the delegated click
// listener for buttons rendered into innerHTML (renderGarden, renderBillList,
// renderGrowth, etc.).
const ACTIONS = {
  loadAll,
  goTab: (arg) => goTab(arg),
  prevMonth,
  nextMonth,
  backToCurrentMonth,
  editBillAmt: (arg) => editBillAmt(arg),
  archiveBill: (arg) => archiveBill(arg),
  unarchiveBill: (arg) => unarchiveBill(arg),
  removeBill: (arg) => removeBill(arg),
  editPayment: (arg) => editPayment(arg),
  deletePayment: (arg) => deletePayment(arg),
  setGoal,
  manualReset,
  closeVarEditor,
  viewHarvestMonth: (arg) => { if (arg && /^\d{4}-\d{2}$/.test(arg)) setViewMonth(arg); },
  dismissWateringPopup: (arg, ev) => {
    const p = ev.target.closest('.water-popup');
    if (p) p.remove();
  },
};

// ── ESC KEY ─────────────────────────────────────────────────────────────────
// Close the topmost open layer on Escape. Order matters: highest z-index /
// most transient first. Each press closes exactly one layer.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const isOpen = (id) => { const el = document.getElementById(id); return !!(el && el.style.display && el.style.display !== 'none'); };
  if (isOpen('help-modal')) { closeHelp(); return; }
  if (isOpen('pro-required-modal')) { closeProRequired(); return; }
  if (isOpen('pay-edit-modal')) { closePayEdit(); return; }
  if (isOpen('amt-modal')) { closeAmtModal(); return; }
  if (isOpen('stop-modal')) { closeStopModal(); return; }
  if (document.getElementById('var-editor')) { closeVarEditor(); return; }
  if (isOpen('overlay')) { closeOverlay(); return; }
  const pop = document.querySelector('.water-popup');
  if (pop) { pop.remove(); return; }
  if (isOpen('delete-modal')) { closeDeleteAccount(); return; }
  if (isOpen('privacy-modal')) { closePrivacy(); return; }
  if (resOpen) { toggleResources(); return; }
});

// ── BROWSER BACK/FORWARD (main tabs, month filter, auth steps) ──────────────
// Closes every open modal/panel (same layers the Escape key knows about,
// but all at once — a Back press means "leave what I opened", not "close
// one layer"), then restores whatever the popped history entry points at.
function closeAllOverlays() {
  const isOpen = (id) => { const el = document.getElementById(id); return !!(el && el.style.display && el.style.display !== 'none'); };
  if (document.getElementById('tourbox')) endTour(true);
  if (isOpen('help-modal')) closeHelp(true);
  // fromHistory=true: popstate is already unwinding the entry, so these must
  // hide directly — calling history.back() again from here would loop.
  if (isOpen('pro-required-modal')) closeProRequired(true);
  if (isOpen('pay-edit-modal')) closePayEdit(true);
  if (isOpen('amt-modal')) closeAmtModal(true);
  if (isOpen('stop-modal')) closeStopModal(true);
  if (document.getElementById('var-editor')) closeVarEditor(true);
  if (isOpen('overlay')) closeOverlay(true);
  const pop = document.querySelector('.water-popup');
  if (pop) pop.remove();
  if (isOpen('delete-modal')) closeDeleteAccount(true);
  if (isOpen('privacy-modal')) closePrivacy(true);
  if (isOpen('onboard-overlay')) closeOnboard(true);
  if (resOpen) toggleResources(true);
}

// Restores a pre-auth history entry (login/signup tab, forgot-password,
// verify-code box). Always resets from a clean baseline first, since the
// popped entry can be several steps away from the screen's current DOM state.
function restoreAuthView(state) {
  const view = (state && state.authView) || 'login';
  const mode = state && state.mode === 'signup' ? 'signup' : 'login';
  hideVerifyCodeBoxDom();
  switchAuthTab(mode, true);
  if (view === 'forgot') showForgot(true);
  else if (view === 'verify') showVerifyCodeBox((state && state.email) || '', true);
}

window.addEventListener('popstate', (ev) => {
  const state = ev.state || {};
  // Back/Forward between the welcome pop-up's intro and bill question.
  const ob = document.getElementById('onboard-overlay');
  if (currentUser && ob && ob.style.display !== 'none' && (state.onboard === 'intro' || state.onboard === 'bill')) {
    showOnboardStep(state.onboard);
    return;
  }
  closeAllOverlays();
  if (currentUser) {
    // Authenticated: restore in-app tab + month. A stale pre-auth entry (no
    // `view` — e.g. left over from before login, or from before logout
    // replaceState()'d a clean landing) defaults to the garden landing.
    setViewMonth('month' in state ? state.month : null, true);
    goTab(state.view || 'garden', true);
  } else {
    // Not authenticated (including just after logout): restore the
    // auth-screen step. A stale in-app tab entry (no `authView`) defaults to
    // the login landing.
    restoreAuthView(state);
  }
});

document.addEventListener('click', (ev) => {
  // Walk up from the click target looking for a data-action attribute.
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.getAttribute('data-action');
  const handler = ACTIONS[action];
  if (!handler) return;
  const arg = el.getAttribute('data-arg');
  try {
    handler(arg, ev);
  } catch (e) {
    console.error('Action failed:', action, e);
  }
});

function wireStaticHandlers() {
  // ── AUTH SCREEN ───────────────────────────────────────────────────────────
  // Landing view is always 'login' (static HTML default) — replaceState so
  // the very first Back leaves the site. If a session auto-logs the user in
  // moments later, showApp()'s own replaceState overwrites this.
  currentAuthView = 'login';
  pushAuthView('login', true);
  const authTabs = document.querySelectorAll('.auth-tab');
  const tabTo = (m) => { const vb = document.getElementById('verify-code-box'); if (vb && vb.style.display === 'block') { hideVerifyCodeBox(); } switchAuthTab(m); };
  if (authTabs[0]) authTabs[0].addEventListener('click', () => tabTo('login'));
  if (authTabs[1]) authTabs[1].addEventListener('click', () => tabTo('signup'));

  const authPw = document.getElementById('auth-pw');
  if (authPw) authPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') authSubmit(); });

  const authBtn = document.getElementById('auth-btn');
  if (authBtn) authBtn.addEventListener('click', authSubmit);

  // 6-digit verification code box
  const verifyBtn = document.getElementById('verify-code-btn');
  if (verifyBtn) verifyBtn.addEventListener('click', submitVerifyCode);
  const verifyInput = document.getElementById('verify-code-input');
  if (verifyInput) verifyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitVerifyCode(); });
  const verifyPwInput = document.getElementById('verify-pw-input');
  if (verifyPwInput) verifyPwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitVerifyCode(); });
  const verifyResend = document.getElementById('verify-code-resend');
  if (verifyResend) verifyResend.addEventListener('click', () => resendVerifyEmail(verifyPendingEmail));

  // Forgot password
  const forgotWrap = document.getElementById('forgot-wrap');
  if (forgotWrap) {
    const forgotBtn = forgotWrap.querySelector('button');
    if (forgotBtn) forgotBtn.addEventListener('click', () => showForgot()); // not `showForgot` directly — addEventListener passes the click Event as arg 1, which showForgot(fromHistory) would read as a truthy fromHistory and skip pushAuthView()
  }
  const forgotForm = document.getElementById('forgot-form');
  if (forgotForm) {
    const resetBtn = forgotForm.querySelector('button');
    if (resetBtn) resetBtn.addEventListener('click', sendReset);
  }

  // Signup privacy + newsletter consent inline links — Privacy Policy openers
  document.querySelectorAll('[data-open="privacy"]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); openPrivacy(); });
  });
  document.querySelectorAll('[data-open="privacy-dns"]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); openPrivacyDoNotSell(); });
  });

  // ── RESET-PASSWORD SCREEN ──────────────────────────────────────────────────
  const newPw = document.getElementById('new-pw');
  if (newPw) newPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') setNewPassword(); });
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', setNewPassword);

  // ── PRIVACY MODAL ──────────────────────────────────────────────────────────
  document.querySelectorAll('[data-action-static="closePrivacy"]').forEach((b) =>
    b.addEventListener('click', () => closePrivacy()));
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) exportBtn.addEventListener('click', downloadMyData);

  // ── DELETE ACCOUNT MODAL ──────────────────────────────────────────────────
  const delCancelBtn = document.getElementById('delete-cancel-btn');
  if (delCancelBtn) delCancelBtn.addEventListener('click', () => closeDeleteAccount());
  const delConfirmBtn = document.getElementById('delete-confirm-btn');
  if (delConfirmBtn) delConfirmBtn.addEventListener('click', submitDeleteAccount);
  const delTipBtn = document.getElementById('delete-tip-privacy');
  if (delTipBtn) delTipBtn.addEventListener('click', () => closeDeleteAndOpenPrivacy());

  // ── NAV (top bar pills + phone bottom bar share data-tab) ──────────────
  document.querySelectorAll('.sb-tab[data-tab], .tab[data-tab]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.tab)));
  const sbTools = document.getElementById('sb-tab-tools');
  if (sbTools) sbTools.addEventListener('click', () => toggleResources());
  const toolsMenu = document.getElementById('sb-tab-tools-menu');
  if (toolsMenu) toolsMenu.addEventListener('click', () => { const m = document.getElementById('acct-menu'); if (m) m.open = false; toggleResources(); });
  const waterCta = document.getElementById('water-cta');
  if (waterCta) waterCta.addEventListener('click', () => goTab('water'));
  const sbHelpBtn = document.getElementById('sb-help');
  if (sbHelpBtn) sbHelpBtn.addEventListener('click', () => openHelp());
  // Close the account menu on outside click / Escape.
  document.addEventListener('click', (e) => { const m = document.getElementById('acct-menu'); if (m && m.open && !m.contains(e.target)) m.open = false; });

  // ── WATER FORM ─────────────────────────────────────────────────────────────
  const amtInput = document.getElementById('amt');
  if (amtInput) amtInput.addEventListener('input', updatePreview);
  const payDate = document.getElementById('pay-date');
  if (payDate) payDate.addEventListener('change', updatePreview);
  const waterBtn = document.getElementById('water-btn');
  if (waterBtn) waterBtn.addEventListener('click', logPayment);

  // ── BILLS FORM ─────────────────────────────────────────────────────────────
  const addBillBtn = document.getElementById('add-bill-btn');
  if (addBillBtn) addBillBtn.addEventListener('click', () => addBill());

  // ── ONBOARDING ─────────────────────────────────────────────────────────────
  const onboardGoBtn = document.getElementById('onboard-go');
  if (onboardGoBtn) onboardGoBtn.addEventListener('click', () => onboardNext());
  const obPlantBtn = document.getElementById('ob-plant-btn');
  if (obPlantBtn) obPlantBtn.addEventListener('click', () => onboardPlant());
  const obSkipBtn = document.getElementById('ob-skip');
  if (obSkipBtn) obSkipBtn.addEventListener('click', () => closeOnboard());
  ['ob-name', 'ob-amt'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onboardPlant(); } }); });

  // ── HEDGEHOG ───────────────────────────────────────────────────────────────
  const hedgehog = document.getElementById('hedgehog');
  if (hedgehog) hedgehog.addEventListener('click', () => hideHedgehog());

  if (window.Gnome) { const pg = document.getElementById('promo-gnome'); if (pg) Gnome.mount(pg, { interactive: false, main: false }); }

  // ── RESOURCES DRAWER ───────────────────────────────────────────────────────
  const resTab = document.getElementById('res-tab');
  if (resTab) resTab.addEventListener('click', () => toggleResources());
  const resBackdrop = document.getElementById('res-backdrop');
  if (resBackdrop) resBackdrop.addEventListener('click', () => toggleResources());
  const resCloseBtn = document.querySelector('#res-drawer button');
  if (resCloseBtn) resCloseBtn.addEventListener('click', () => toggleResources());

  // ── WATER NUDGE ────────────────────────────────────────────────────────────
  const nudgeCloseBtn = document.querySelector('#water-nudge button');
  if (nudgeCloseBtn) nudgeCloseBtn.addEventListener('click', () => closeNudge());

  // ── CELEBRATION OVERLAY ────────────────────────────────────────────────────
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      // Only close when clicking the backdrop, not the inner content
      if (e.target === overlay) closeOverlay();
    });
    const closeBtn = overlay.querySelector('.cel-box .btn-sage');
    if (closeBtn) closeBtn.addEventListener('click', () => closeOverlay());
  }

  // ── AMOUNT MODAL ───────────────────────────────────────────────────────────
  const amtModal = document.getElementById('amt-modal');
  if (amtModal) {
    amtModal.addEventListener('click', (e) => { if (e.target === amtModal) closeAmtModal(); });
    const buttons = amtModal.querySelectorAll('button');
    if (buttons[0]) buttons[0].addEventListener('click', confirmAmtModal);
    if (buttons[1]) buttons[1].addEventListener('click', () => closeAmtModal());
  }

  // ── STOP-MONTH MODAL ───────────────────────────────────────────────────────
  const stopModal = document.getElementById('stop-modal');
  if (stopModal) {
    stopModal.addEventListener('click', (e) => { if (e.target === stopModal) closeStopModal(); });
    const buttons = stopModal.querySelectorAll('button');
    if (buttons[0]) buttons[0].addEventListener('click', confirmStopModal);
    if (buttons[1]) buttons[1].addEventListener('click', () => closeStopModal());
  }

  // ── PAYMENT EDIT MODAL ─────────────────────────────────────────────────────
  const payEditModal = document.getElementById('pay-edit-modal');
  if (payEditModal) {
    payEditModal.addEventListener('click', (e) => { if (e.target === payEditModal) closePayEdit(); });
    const buttons = payEditModal.querySelectorAll('button');
    if (buttons[0]) buttons[0].addEventListener('click', confirmPayEdit);
    if (buttons[1]) buttons[1].addEventListener('click', () => closePayEdit());
  }

  // ── SIDEBAR FOOTER BUTTONS (sign out / delete / privacy) ───────────────────
  const sbSignOut = document.querySelector('[data-action-static="sb-logout"]');
  if (sbSignOut) sbSignOut.addEventListener('click', logout);
  const sbDelete = document.querySelector('[data-action-static="sb-delete-account"]');
  if (sbDelete) sbDelete.addEventListener('click', openDeleteAccount);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireStaticHandlers);
} else {
  wireStaticHandlers();
}

// Expose key functions on window for any leftover references (defensive — the
// previous inline-handler globals like `goTab(...)` no longer fire, but any
// future code that uses window.foo() will still work).
Object.assign(window, {
  goTab, switchAuthTab, authSubmit, showForgot, sendReset, setNewPassword,
  openPrivacy, closePrivacy, openPrivacyDoNotSell,
  openDeleteAccount, closeDeleteAccount, submitDeleteAccount, downloadMyData,
  logout, toggleResources, closeNudge, closeOverlay,
  prevMonth, nextMonth, backToCurrentMonth,
  closeOnboard, hideHedgehog,
  logPayment, addBill, editBillAmt, archiveBill, unarchiveBill, removeBill,
  editPayment, deletePayment, confirmPayEdit, closePayEdit,
  setGoal, manualReset, loadAll,
  openAmtModal, closeAmtModal, confirmAmtModal,
  closeVarEditor, updatePreview, showProUpgrade,
});

// ── Show/hide password toggle ─────────
(function initPwEyes(){
  var EYE='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYEOFF='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  ['auth-pw','auth-pw2'].forEach(function(id){
    var input=document.getElementById(id);
    if(!input||input.dataset.eyeInit)return;
    input.dataset.eyeInit='1';
    var wrap=document.createElement('div');
    wrap.style.position='relative';
    input.parentNode.insertBefore(wrap,input);
    wrap.appendChild(input);
    input.style.paddingRight='40px';
    var btn=document.createElement('button');
    btn.type='button';
    btn.setAttribute('aria-label','Show password');
    btn.setAttribute('aria-pressed','false');
    btn.style.cssText='position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:8px;line-height:0;color:inherit;opacity:.55';
    btn.innerHTML=EYE;
    btn.addEventListener('click',function(){
      var show=input.type==='password';
      input.type=show?'text':'password';
      btn.innerHTML=show?EYEOFF:EYE;
      btn.setAttribute('aria-label',show?'Hide password':'Show password');
      btn.setAttribute('aria-pressed',String(show));
      input.focus();
    });
    wrap.appendChild(btn);
  });
})();


// ── Night Bloom art (scripts/art/nightflowers.js): one night-blooming flower per tier ──
// ── Night-blooming flowers (Magical Night Garden) ─────────────────────────────
// Appended after app.js, so these mwStageArt / smStageArt declarations replace
// the daisy versions. Same signatures, viewBoxes, stage bands (mwStage/smStage)
// and MW_GROUND. Each tier is a real night bloomer, drawn storybook-style:
//   seed  → four o'clock      weed → evening primrose   thorn → night phlox
//   vine  → moonflower        tree → queen of the night (night-blooming cereus)
// Buds sleep (closed eyes + z's), wake while opening, smile at full bloom.
const NF_INK='#4A2346',NF_BLUSH='#FF8FB8';
const NF_SEED_TINT={seed:'#F25DB8',weed:'#F3DF6A',thorn:'#C9A5FF',vine:'#E9E4FF',tree:'#FFE7B8'};
function nfN(v){return Math.round(v*10)/10}
function nfId(){return Math.random().toString(36).slice(2,8)}
// Stem: dark green core with a pale rim so it reads on a night background.
function nfStem(d,w){
  return '<path d="'+d+'" stroke="#A6E596" stroke-width="'+nfN(w+1.8)+'" stroke-linecap="round" fill="none" opacity=".5"/>'
    +'<path d="'+d+'" stroke="#3C8A4E" stroke-width="'+w+'" stroke-linecap="round" fill="none"/>';
}
// Pointed leaf. ang in degrees, 0 = pointing right, -90 = up.
function nfLeaf(x,y,len,wid,ang,dark){
  return '<g transform="translate('+x+' '+y+') rotate('+ang+')">'
    +'<path d="M0 0Q'+nfN(len*.42)+' '+nfN(-wid)+' '+len+' 0Q'+nfN(len*.42)+' '+wid+' 0 0Z" fill="'+(dark?'#3F8C4F':'#5CB062')+'" stroke="#B8F0A2" stroke-opacity=".55" stroke-width=".8"/>'
    +'<path d="M1.5 0Q'+nfN(len*.5)+' '+nfN(-wid*.1)+' '+nfN(len*.82)+' 0" stroke="#A9E596" stroke-width=".7" fill="none" opacity=".75"/>'
    +'</g>';
}
// Heart-shaped leaf (moonflower). Points along ang.
function nfHeartLeaf(x,y,s,ang,dark){
  return '<g transform="translate('+x+' '+y+') rotate('+ang+')">'
    +'<path d="M0 0C'+nfN(-s*.12)+' '+nfN(-s*.55)+' '+nfN(s*.42)+' '+nfN(-s*.72)+' '+nfN(s*.62)+' '+nfN(-s*.3)+'Q'+nfN(s*.8)+' '+nfN(-s*.1)+' '+s+' 0Q'+nfN(s*.8)+' '+nfN(s*.1)+' '+nfN(s*.62)+' '+nfN(s*.3)+'C'+nfN(s*.42)+' '+nfN(s*.72)+' '+nfN(-s*.12)+' '+nfN(s*.55)+' 0 0Z" fill="'+(dark?'#3F8C4F':'#5CB062')+'" stroke="#B8F0A2" stroke-opacity=".55" stroke-width=".8"/>'
    +'<path d="M1 0L'+nfN(s*.85)+' 0" stroke="#A9E596" stroke-width=".7" opacity=".75"/>'
    +'</g>';
}
// Flat, scalloped cactus leaf (queen of the night). Points along ang.
function nfCactusLeaf(x,y,len,wid,ang,dark){
  const k=6;let top='',bot='';
  for(let i=0;i<k;i++){
    const x0=len*i/k,x1=len*(i+1)/k,xm=(x0+x1)/2;
    top+='Q'+nfN(xm)+' '+nfN(-nfEnv(xm,len,wid)*1.12)+' '+nfN(x1)+' '+nfN(-nfEnv(x1,len,wid)*.9);
  }
  for(let i=k;i>0;i--){
    const x0=len*i/k,x1=len*(i-1)/k,xm=(x0+x1)/2;
    bot+='Q'+nfN(xm)+' '+nfN(nfEnv(xm,len,wid)*1.12)+' '+nfN(x1)+' '+nfN(x1===0?0:nfEnv(x1,len,wid)*.9);
  }
  return '<g transform="translate('+x+' '+y+') rotate('+ang+')">'
    +'<path d="M0 0'+top+'Q'+nfN(len+wid*.9)+' 0 '+len+' '+nfN(nfEnv(len,len,wid)*.9)+bot+'Z" fill="'+(dark?'#3A7F5E':'#4F9C74')+'" stroke="#B8F0A2" stroke-opacity=".55" stroke-width=".8" stroke-linejoin="round"/>'
    +'<path d="M1 0L'+nfN(len*.94)+' 0" stroke="#A9E596" stroke-width="1.1" opacity=".8" stroke-linecap="round"/>'
    +'</g>';
}
function nfEnv(t,len,wid){return t<=0?0:Math.pow(Math.sin(Math.PI*.5*Math.min(1,t/(len*.35))),.7)*wid*(1-.45*Math.max(0,(t-len*.35)/(len*.65)))}
// Tiny face. mood: sleep | wake | happy.
function nfFace(x,y,s,mood){
  const w=s*.55,ex1=x-s*.95,ex2=x+s*.95,sw=nfN(Math.max(.5,s*.3));
  let o='<ellipse cx="'+nfN(x-s*1.7)+'" cy="'+nfN(y+s*.7)+'" rx="'+nfN(s*.5)+'" ry="'+nfN(s*.32)+'" fill="'+NF_BLUSH+'" opacity=".6"/>'
    +'<ellipse cx="'+nfN(x+s*1.7)+'" cy="'+nfN(y+s*.7)+'" rx="'+nfN(s*.5)+'" ry="'+nfN(s*.32)+'" fill="'+NF_BLUSH+'" opacity=".6"/>';
  const eye=(ex,up)=>'<path d="M'+nfN(ex-w)+' '+nfN(y)+'Q'+nfN(ex)+' '+nfN(y+(up?-w*1.1:w*1.1))+' '+nfN(ex+w)+' '+nfN(y)+'" stroke="'+NF_INK+'" stroke-width="'+sw+'" fill="none" stroke-linecap="round"/>';
  if(mood==='sleep'){
    o+=eye(ex1,false)+eye(ex2,false)
      +'<ellipse cx="'+nfN(x)+'" cy="'+nfN(y+s*.95)+'" rx="'+nfN(s*.22)+'" ry="'+nfN(s*.17)+'" fill="'+NF_INK+'" opacity=".75"/>';
  }else if(mood==='wake'){
    o+='<circle cx="'+nfN(ex1)+'" cy="'+nfN(y)+'" r="'+nfN(s*.32)+'" fill="'+NF_INK+'"/>'
      +'<circle cx="'+nfN(ex1+s*.1)+'" cy="'+nfN(y-s*.1)+'" r="'+nfN(s*.1)+'" fill="#fff"/>'
      +eye(ex2,false)
      +'<ellipse cx="'+nfN(x)+'" cy="'+nfN(y+s*1)+'" rx="'+nfN(s*.26)+'" ry="'+nfN(s*.32)+'" fill="'+NF_INK+'" opacity=".8"/>';
  }else{
    o+=eye(ex1,true)+eye(ex2,true)
      +'<path d="M'+nfN(x-s*.5)+' '+nfN(y+s*.7)+'Q'+nfN(x)+' '+nfN(y+s*1.3)+' '+nfN(x+s*.5)+' '+nfN(y+s*.7)+'" stroke="'+NF_INK+'" stroke-width="'+sw+'" fill="none" stroke-linecap="round"/>';
  }
  return o;
}
function nfZ(x,y,s,o){
  const p=(zx,zy,zs)=>'<path d="M'+nfN(zx)+' '+nfN(zy)+'h'+nfN(zs)+'l'+nfN(-zs)+' '+nfN(zs)+'h'+nfN(zs)+'" stroke="#D8CCFF" stroke-width="'+nfN(zs*.24)+'" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity="'+o+'"/>';
  return p(x,y,s)+p(x+s*1.3,y-s*1.5,s*.7);
}
function nfDefs(id){
  return '<defs>'
    +'<radialGradient id="nfHalo'+id+'"><stop offset="0" stop-color="#FFF6D6" stop-opacity=".55"/><stop offset=".5" stop-color="#E6DBFF" stop-opacity=".18"/><stop offset="1" stop-color="#E6DBFF" stop-opacity="0"/></radialGradient>'
    +'<radialGradient id="nfThroat'+id+'"><stop offset="0" stop-color="#FFF8C8" stop-opacity="1"/><stop offset=".55" stop-color="#FFE68A" stop-opacity=".55"/><stop offset="1" stop-color="#FFE68A" stop-opacity="0"/></radialGradient>'
    +'<radialGradient id="nfFly'+id+'"><stop offset="0" stop-color="#F4FFB0" stop-opacity=".95"/><stop offset=".4" stop-color="#D8FF7A" stop-opacity=".35"/><stop offset="1" stop-color="#D8FF7A" stop-opacity="0"/></radialGradient>'
    +'</defs>';
}
function nfHalo(id,x,y,r){return '<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="url(#nfHalo'+id+')"/>'}
function nfThroat(id,x,y,r){return '<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="url(#nfThroat'+id+')"/>'}
function nfFirefly(id,x,y){
  return '<g class="mw-sparkle"><circle cx="'+x+'" cy="'+y+'" r="6" fill="url(#nfFly'+id+')"/>'
    +'<ellipse cx="'+(x-1.6)+'" cy="'+(y-1.6)+'" rx="1.7" ry="1" fill="#E8F0FF" opacity=".7" transform="rotate(-30 '+(x-1.6)+' '+(y-1.6)+')"/>'
    +'<ellipse cx="'+(x+.4)+'" cy="'+(y-2)+'" rx="1.7" ry="1" fill="#E8F0FF" opacity=".7" transform="rotate(30 '+(x+.4)+' '+(y-2)+')"/>'
    +'<ellipse cx="'+(x-.6)+'" cy="'+y+'" rx="1.5" ry="1.1" fill="#3A3354"/>'
    +'<circle cx="'+(x+.9)+'" cy="'+(y+.6)+'" r="1.1" fill="#F2FF9A"/></g>';
}
function nfMoth(x,y,rot){
  return '<g transform="translate('+x+' '+y+') rotate('+rot+')">'
    +'<path d="M0 0C-3 -5 -9 -6 -9 -2C-9 1 -4 1.5 0 .5Z" fill="#E7DDFF" stroke="#B9A8EE" stroke-width=".5"/>'
    +'<path d="M0 0C3 -5 9 -6 9 -2C9 1 4 1.5 0 .5Z" fill="#E7DDFF" stroke="#B9A8EE" stroke-width=".5"/>'
    +'<path d="M0 .6C-2 2 -6 4.5 -5.5 5.5C-4.5 6.5 -1.5 3.5 0 1.4Z" fill="#D2C4FA"/>'
    +'<path d="M0 .6C2 2 6 4.5 5.5 5.5C4.5 6.5 1.5 3.5 0 1.4Z" fill="#D2C4FA"/>'
    +'<circle cx="-5.4" cy="-2.6" r="1" fill="#B79AF0"/><circle cx="5.4" cy="-2.6" r="1" fill="#B79AF0"/>'
    +'<ellipse cx="0" cy="1" rx=".9" ry="2.8" fill="#9C8BC9"/>'
    +'<path d="M-.3 -1.6Q-1.5 -4.5 -3 -4.8M.3 -1.6Q1.5 -4.5 3 -4.8" stroke="#9C8BC9" stroke-width=".5" fill="none" stroke-linecap="round"/>'
    +'</g>';
}
function nfDot(x,y,r,o){return '<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="#FFF3B8" opacity="'+o+'"/>'}
// Scalloped / lobed round flower outline. sy squashes it for a tilted view.
function nfLobed(cx,cy,r,n,dep,rot,sy){
  sy=sy||1;const P=(a,R)=>nfN(cx+Math.cos(a)*R)+' '+nfN(cy+Math.sin(a)*R*sy);
  const st=Math.PI*2/n;let a=rot-st/2,d='M'+P(a,r*dep);
  for(let i=0;i<n;i++){
    const t=rot+i*st;
    d+='C'+P(t-st*.42,r*1.08)+' '+P(t-st*.18,r*1.12)+' '+P(t,r)+'C'+P(t+st*.18,r*1.12)+' '+P(t+st*.42,r*1.08)+' '+P(t+st/2,r*dep);
  }
  return d+'Z';
}
// Five-point star path (moonflower crease).
function nfStar(cx,cy,r,ri,n,rot){
  let d='';for(let i=0;i<n*2;i++){const a=rot+i*Math.PI/n,R=i%2?ri:r;d+=(i?'L':'M')+nfN(cx+Math.cos(a)*R)+' '+nfN(cy+Math.sin(a)*R)}
  return d+'Z';
}
// A furled, spiral-twisted bud pointing up from (x,y), rotated by ang.
function nfBud(x,y,w,h,ang,fill,twist,sepal){
  const T='<g transform="translate('+x+' '+y+') rotate('+ang+')">';
  return T
    +'<path d="M'+(-w)+' 0C'+(-w)+' '+nfN(-h*.5)+' '+nfN(-w*.45)+' '+nfN(-h*.82)+' 0 '+(-h)+'C'+nfN(w*.45)+' '+nfN(-h*.82)+' '+w+' '+nfN(-h*.5)+' '+w+' 0Q0 '+nfN(h*.14)+' '+(-w)+' 0Z" fill="'+fill+'" stroke="#FFFFFF" stroke-opacity=".35" stroke-width=".6"/>'
    +'<path d="M'+nfN(-w*.85)+' '+nfN(-h*.18)+'Q'+nfN(w*.1)+' '+nfN(-h*.3)+' '+nfN(w*.72)+' '+nfN(-h*.56)+'" stroke="'+twist+'" stroke-width="'+nfN(Math.max(.6,w*.16))+'" fill="none" stroke-linecap="round" opacity=".85"/>'
    +'<path d="M'+nfN(-w*.6)+' '+nfN(-h*.5)+'Q'+nfN(w*.05)+' '+nfN(-h*.6)+' '+nfN(w*.3)+' '+nfN(-h*.85)+'" stroke="'+twist+'" stroke-width="'+nfN(Math.max(.5,w*.13))+'" fill="none" stroke-linecap="round" opacity=".7"/>'
    +'<path d="M'+nfN(-w*.95)+' 0Q'+nfN(-w*.9)+' '+nfN(-h*.22)+' '+nfN(-w*.35)+' '+nfN(-h*.3)+'Q'+nfN(-w*.2)+' '+nfN(-h*.1)+' 0 '+nfN(-h*.06)+'Q'+nfN(w*.2)+' '+nfN(-h*.1)+' '+nfN(w*.35)+' '+nfN(-h*.3)+'Q'+nfN(w*.9)+' '+nfN(-h*.22)+' '+nfN(w*.95)+' 0Q0 '+nfN(h*.16)+' '+nfN(-w*.95)+' 0Z" fill="'+(sepal||'#4E9E57')+'"/>'
    +'</g>';
}
// Profile trumpet (four o'clock / moonflower half-open), pointing up from (x,y).
function nfTrumpet(x,y,len,fl,ang,fill,mouth,edge,mr){
  mr=mr||.34;
  return '<g transform="translate('+x+' '+y+') rotate('+ang+')">'
    +'<path d="M-1.4 0L-1.2 '+nfN(-len*.4)+'C'+nfN(-fl*.18)+' '+nfN(-len*.72)+' '+nfN(-fl*.7)+' '+nfN(-len*.9)+' '+(-fl)+' '+(-len)+'L'+fl+' '+(-len)+'C'+nfN(fl*.7)+' '+nfN(-len*.9)+' '+nfN(fl*.18)+' '+nfN(-len*.72)+' 1.2 '+nfN(-len*.4)+'L1.4 0Z" fill="'+fill+'" stroke="'+(edge||'#fff')+'" stroke-opacity=".4" stroke-width=".6"/>'
    +'<ellipse cx="0" cy="'+(-len)+'" rx="'+fl+'" ry="'+nfN(fl*mr)+'" fill="'+mouth+'" stroke="'+fill+'" stroke-width=".8"/>'
    +'<ellipse cx="0" cy="'+nfN(-len+fl*.05)+'" rx="'+nfN(fl*.4)+'" ry="'+nfN(fl*mr*.4)+'" fill="#FFF3B0" opacity=".9"/>'
    +'<path d="M-2.4 1Q-1.6 -1.6 0 -1.6Q1.6 -1.6 2.4 1Z" fill="#4E9E57"/>'
    +'</g>';
}

// ── SEED · Four o'clock ─────────────────────────────────────────────────────
function nfFourOClock(st,id){
  let s='';
  if(st===2){
    return s+nfStem('M40 77Q39 62 40 46',3.6)
      +nfLeaf(40,67,15,5.5,-165,true)+nfLeaf(40,67,15,5.5,-15)
      +nfLeaf(40,56,12,4.6,-145)+nfLeaf(40,56,12,4.6,-35,true)
      +nfLeaf(40,47,7,3,-120)+nfLeaf(40,47,7,3,-60,true);
  }
  s+=nfStem('M40 77Q39 60 40 40',3.8)+nfStem('M40 54Q31 49 26 42',2.4)+nfStem('M40 52Q50 47 55 40',2.4)
    +nfLeaf(40,68,15,5.5,-165,true)+nfLeaf(40,68,15,5.5,-15)
    +nfLeaf(40,60,12,4.6,-150)+nfLeaf(40,60,12,4.6,-30,true);
  if(st===3){
    return s+nfBud(26,43,2.2,11,-25,'#E0529F','#FF9AD5')+nfBud(55,41,2.2,11,22,'#F2C94C','#FFF0A8')
      +nfBud(40,41,5.6,21,0,'#EE4FB5','#FFA3DC')
      +nfFace(40,29,1.7,'sleep')+nfZ(49,15,3.4,.85);
  }
  if(st===4){
    return s+nfHalo(id,40,24,18)
      +nfBud(26,43,2.2,11,-25,'#E0529F','#FF9AD5')+nfBud(55,41,2.2,11,22,'#F2C94C','#FFF0A8')
      +nfTrumpet(40,41,15,9.5,0,'#EE4FB5','#FF8AD2','#FFC2E8',.62)
      +'<ellipse cx="40" cy="26.5" rx="6" ry="4" fill="url(#nfThroat'+id+')"/>'
      +nfFace(40,25.3,1.45,'wake')
      +mwSparkle(60,26,3,.8);
  }
  // full bloom: yellow + striped trumpets in profile, magenta face-on bloom
  return s+nfHalo(id,40,24,24)
    +nfTrumpet(26,43,14,6.8,-28,'#FFD84A','#FFF1A6','#FFF6C8')
    +nfTrumpet(55,41,14,6.8,26,'#F25DB8','#FF9AD8')
    +nfStem('M40 42L40 33',2.2)
    +'<path d="'+nfLobed(40,22,13,5,.78,-Math.PI/2)+'" fill="#EE4FB5" stroke="#FFC2E8" stroke-width=".8"/>'
    +'<path d="'+nfLobed(40,22,9,5,.8,-Math.PI/2)+'" fill="#FF7CCB"/>'
    +[0,1,2,3,4].map(i=>{const a=-Math.PI/2+i*Math.PI*2/5;return '<path d="M'+nfN(40+Math.cos(a)*5.5)+' '+nfN(22+Math.sin(a)*5.5)+'L'+nfN(40+Math.cos(a)*12)+' '+nfN(22+Math.sin(a)*12)+'" stroke="#FFC2E8" stroke-width=".7" opacity=".8"/>'}).join('')
    +nfThroat(id,40,22,7.5)
    +'<path d="M43 25Q49 29 50 34M44 24Q51 26 53.5 30M42 26Q45 32 44 36" stroke="#FFF1A6" stroke-width=".7" fill="none" stroke-linecap="round"/>'
    +'<circle cx="50" cy="34" r="1" fill="#FFE36B"/><circle cx="53.5" cy="30" r="1" fill="#FFE36B"/><circle cx="44" cy="36" r="1" fill="#FFE36B"/>'
    +nfFace(40,21,1.9,'happy')
    +nfFirefly(id,66,16)+mwSparkle(14,24,3,.75)+mwSparkle(64,60,2.6,.6)+nfDot(20,14,.9,.8)+nfDot(59,12,.7,.7);
}

// ── WEED · Evening primrose ─────────────────────────────────────────────────
function nfHeartPetal(ang,cx,cy,s,fill,edge){
  return '<g transform="translate('+cx+' '+cy+') rotate('+ang+') scale('+s+')">'
    +'<path d="M0 0C-5 -1.5 -11 -7 -10 -12.5C-9 -17.5 -3.5 -18 0 -15.6C3.5 -18 9 -17.5 10 -12.5C11 -7 5 -1.5 0 0Z" fill="'+fill+'" stroke="'+edge+'" stroke-width="'+nfN(.8/s)+'"/>'
    +'<path d="M0 -1L0 -12M0 -3Q-4 -7 -6 -12M0 -3Q4 -7 6 -12" stroke="#FFFBE0" stroke-width="'+nfN(.6/s)+'" fill="none" opacity=".8"/>'
    +'</g>';
}
function nfPrimroseFlower(id,cx,cy,s,mood){
  let o='';
  for(const a of [-8,82,172,262])o+=nfHeartPetal(a,cx,cy,s,'#FFF2A0','#E9C33E');
  o+=nfThroat(id,cx,cy,7*s);
  for(let i=0;i<8;i++){const a=i*Math.PI/4+.2;o+='<path d="M'+cx+' '+cy+'L'+nfN(cx+Math.cos(a)*5.4*s)+' '+nfN(cy+Math.sin(a)*5.4*s)+'" stroke="#F2E27A" stroke-width="'+nfN(.6*s)+'"/><ellipse cx="'+nfN(cx+Math.cos(a)*5.6*s)+'" cy="'+nfN(cy+Math.sin(a)*5.6*s)+'" rx="'+nfN(.9*s)+'" ry="'+nfN(.55*s)+'" fill="#F5C842"/>'}
  // cross-shaped stigma
  for(const a of [45,135,225,315]){const r=a*Math.PI/180;o+='<path d="M'+cx+' '+cy+'L'+nfN(cx+Math.cos(r)*8.2*s)+' '+nfN(cy+Math.sin(r)*8.2*s)+'" stroke="#E3C95A" stroke-width="'+nfN(2.4*s)+'" stroke-linecap="round"/><path d="M'+cx+' '+cy+'L'+nfN(cx+Math.cos(r)*8.2*s)+' '+nfN(cy+Math.sin(r)*8.2*s)+'" stroke="#FFF9DA" stroke-width="'+nfN(1.4*s)+'" stroke-linecap="round"/>'}
  o+='<circle cx="'+cx+'" cy="'+cy+'" r="'+nfN(4.6*s)+'" fill="#D8E86C" stroke="#FFFDF2" stroke-width="'+nfN(.6*s)+'"/>';
  if(mood)o+=nfFace(cx,cy-.7*s,1.25*s,mood);
  return o;
}
function nfPrimrose(st,id){
  let s=nfLeaf(40,76,17,3.8,-172,true)+nfLeaf(40,76,17,3.8,-8)+nfLeaf(40,75,14,3.4,-145)+nfLeaf(40,75,14,3.4,-35,true);
  if(st===2){
    return s+nfStem('M40 76Q40 62 40 48',3.2)
      +nfLeaf(40,63,12,3,-150,true)+nfLeaf(40,57,12,3,-30)+nfLeaf(40,50,8,2.4,-125)+nfLeaf(40,49,8,2.4,-55,true);
  }
  s+=nfStem('M40 76Q40 58 40 40',3.2)+nfLeaf(40,64,12,3,-150,true)+nfLeaf(40,58,12,3,-30)+nfLeaf(40,51,10,2.6,-150)
    +nfStem('M40 50Q34 46 32 40',2);
  if(st===3){
    return s+nfBud(32,41,2.4,11,-18,'#EFE38A','#E5B94C','#8FA64A')
      +nfBud(40,41,5.4,22,0,'#F6ECA0','#E4BE55','#8FA64A')
      +'<path d="M37 41Q36.5 30 39 21M43 41Q43.5 30 41 21" stroke="#D2604E" stroke-width=".9" fill="none" opacity=".8"/>'
      +nfFace(40,29,1.6,'sleep')+nfZ(49,14,3.4,.85);
  }
  if(st===4){
    return s+nfBud(32,41,2.4,11,-18,'#EFE38A','#E5B94C','#8FA64A')
      +nfHalo(id,40,27,18)
      +nfStem('M40 42L40 33',2.4)
      +nfHeartPetal(-50,40,35,.78,'#F7E78C','#E0B838')+nfHeartPetal(50,40,35,.78,'#F7E78C','#E0B838')
      +nfHeartPetal(0,40,35,.9,'#FFF2A0','#E9C33E')
      +nfBud(40,37,3,4,0,'#8FA64A','#8FA64A','#6F8A3A')
      +nfFace(40,29.5,1.35,'wake')
      +mwSparkle(60,22,3,.8);
  }
  return s+nfHalo(id,40,25,25)
    +nfBud(32,41,2.2,10,-24,'#EFE38A','#E5B94C','#8FA64A')
    +nfFace(nfN(32-Math.sin(24*Math.PI/180)*5.5),nfN(41-5.4),.7,'sleep')
    +nfStem('M40 42L40 33',2.4)
    +nfPrimroseFlower(id,40,25,1.08,'happy')
    +nfFirefly(id,66,52)+mwSparkle(64,16,3.2,.8)+mwSparkle(13,30,2.6,.65)+nfDot(18,18,.9,.8)+nfDot(60,34,.7,.7);
}

// ── THORN · Night phlox ─────────────────────────────────────────────────────
// White notched-petal stars with maroon backs: red buds by day, white at night.
function nfPhloxFloret(cx,cy,s,rot){
  let o='';
  for(let i=0;i<5;i++){
    const a=rot+i*72;
    o+='<path transform="translate('+cx+' '+cy+') rotate('+a+') scale('+s+')" d="M0 0C-2.6 -1.5 -4.2 -5.5 -3.3 -8.6L0 -6.6L3.3 -8.6C4.2 -5.5 2.6 -1.5 0 0Z" fill="#FDFBFF" stroke="#C9B3F7" stroke-width="'+nfN(.55/s)+'" stroke-linejoin="round"/>';
  }
  return o+'<circle cx="'+cx+'" cy="'+cy+'" r="'+nfN(1.5*s)+'" fill="#FFB547"/><circle cx="'+cx+'" cy="'+cy+'" r="'+nfN(.7*s)+'" fill="#FFE8A6"/>';
}
function nfPhloxBud(x,y,s,ang){return nfBud(x,y,1.7*s,7*s,ang,'#B8386A','#E47AA4','#4E9E57')}
function nfPhlox(st,id){
  let s=nfStem('M40 77Q39 62 40 44',2.6)+nfStem('M40 76Q33 64 29 51',2)+nfStem('M40 76Q47 64 51 49',2);
  const leaves=nfLeaf(40,69,11,2.3,-160,true)+nfLeaf(40,66,11,2.3,-20)+nfLeaf(35,64,9,2,-165)+nfLeaf(45,62,9,2,-15,true)
    +nfLeaf(40,57,9,2,-150)+nfLeaf(40,54,9,2,-30,true)+nfLeaf(31,56,7,1.8,-140,true)+nfLeaf(49,55,7,1.8,-40);
  if(st===2)return s+leaves+nfLeaf(40,45,6,2,-115)+nfLeaf(40,45,6,2,-65,true);
  s+=leaves+nfStem('M40 46L40 38',2.2);
  if(st===3){
    return s+nfPhloxBud(27,50,1,-25)+nfPhloxBud(31,50,.9,5)+nfPhloxBud(49,48,1,-5)+nfPhloxBud(53,49,.9,25)
      +nfPhloxBud(35,38,1,-28)+nfPhloxBud(45,38,1,28)+nfBud(40,39,5,16,0,'#C24477','#EE8EB5')
      +nfFace(40,29.5,1.5,'sleep')+nfZ(49,15,3.4,.85);
  }
  if(st===4){
    return s+nfHalo(id,40,30,18)+nfPhloxBud(27,50,1,-25)+nfPhloxFloret(51,45,.8,10)+nfPhloxBud(53,49,.9,25)
      +nfPhloxBud(35,38,1,-28)+nfPhloxBud(46,38,1,28)
      +nfPhloxFloret(40,30,1.5,0)+'<circle cx="40" cy="30" r="3.3" fill="#FFE8A6"/>'+nfFace(40,29.6,1.15,'wake')
      +mwSparkle(62,24,3,.8);
  }
  return s+nfHalo(id,40,30,26)
    +nfPhloxFloret(27,44,.85,20)+nfPhloxFloret(24,50,.7,50)+nfPhloxBud(31,50,.8,10)
    +nfPhloxFloret(53,42,.85,-10)+nfPhloxFloret(56,49,.7,30)
    +nfPhloxFloret(32,30,.95,15)+nfPhloxFloret(48,29,.95,-15)+nfPhloxFloret(35,20,.85,30)+nfPhloxFloret(46,19,.85,-20)
    +nfPhloxFloret(40,28,1.6,0)+'<circle cx="40" cy="28" r="3.5" fill="#FFE8A6"/>'+nfFace(40,27.6,1.2,'happy')
    +nfFirefly(id,64,20)+mwSparkle(14,30,3,.75)+mwSparkle(63,62,2.6,.6)+nfDot(22,16,.9,.8)+nfDot(56,12,.7,.7);
}

// ── VINE · Moonflower ───────────────────────────────────────────────────────
function nfMoonBud(x,y,w,h,ang){return nfBud(x,y,w,h,ang,'#F4F1FF','#9D8BE3','#4E9E57')}
function nfMoonflower(st,id){
  const twine='M40 77C30 71 50 64 41 57C33 51 47 46 42 40';
  let s=nfStem(twine,2.6)
    +'<path d="M36 72Q30 70 31 66Q32.5 63.5 34.5 65.5Q35.5 67.5 33.5 67.5" stroke="#8FD17A" stroke-width="1" fill="none" stroke-linecap="round"/>'
    +nfHeartLeaf(37,70,13,-160,true)+nfHeartLeaf(45,62,12,-25)+nfHeartLeaf(36,53,11,-150);
  if(st===2)return s+nfHeartLeaf(44,45,8,-40,true)
    +'<path d="M42 40Q46 36 44 33Q42 31 41 33.5" stroke="#8FD17A" stroke-width="1" fill="none" stroke-linecap="round"/>';
  s+=nfStem('M42 40C38 35 45 31 42 27',2.4)+nfHeartLeaf(44,46,10,-30,true)
    +'<path d="M46 49Q53 48 53 43Q52.5 40 50 41Q48.5 42.5 50.5 43.5" stroke="#8FD17A" stroke-width="1" fill="none" stroke-linecap="round"/>';
  if(st===3){
    return s+nfMoonBud(42,28,5.6,25,4)+nfFace(43,17,1.6,'sleep')+nfZ(52,5,3.4,.85)
      +'<path d="M42 28Q37 28 34 32" stroke="#4E9E57" stroke-width="1.4" fill="none" stroke-linecap="round"/>'+nfMoonBud(34,33,1.8,9,-40);
  }
  if(st===4){
    return s+nfHalo(id,42,18,18)
      +'<path d="M42 28Q37 28 34 32" stroke="#4E9E57" stroke-width="1.4" fill="none" stroke-linecap="round"/>'+nfMoonBud(34,33,1.8,9,-40)
      +nfTrumpet(42,29,17,12,0,'#E6E0FA','#FFFFFF','#C9BEF2',.55)
      +'<path d="M40.8 27Q43.5 22 47.5 16.5M41 22Q38 18 34 15.5" stroke="#A898E6" stroke-width=".9" fill="none" stroke-linecap="round" opacity=".85"/>'
      +'<path d="'+nfStar(42,12,11,4,5,-Math.PI/2).replace(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g,(m,a,b)=>a+' '+nfN(12+(b-12)*.6))+'" fill="#EAF6D4" opacity=".8"/>'
      +'<ellipse cx="42" cy="12" rx="6" ry="4" fill="url(#nfThroat'+id+')"/>'
      +nfFace(42,11.3,1.5,'wake')
      +mwSparkle(62,20,3,.8);
  }
  // full bloom: big face-on white disc with a soft green star crease
  return s+nfHalo(id,42,22,28)
    +'<path d="M42 28Q35 29 31 34" stroke="#4E9E57" stroke-width="1.4" fill="none" stroke-linecap="round"/>'+nfMoonBud(31,35,2.4,12,-48)
    +nfFace(nfN(31-Math.sin(48*Math.PI/180)*6.5),nfN(35-Math.cos(48*Math.PI/180)*5.5),.6,'sleep')
    +'<path d="'+nfLobed(42,21,17.5,5,.93,-Math.PI/2)+'" fill="#FBFAFF" stroke="#D9D0FA" stroke-width=".9"/>'
    +'<path d="'+nfStar(42,21,15.5,6,5,-Math.PI/2)+'" fill="#EAF6D4" opacity=".75"/>'
    +[0,1,2,3,4].map(i=>{const a=-Math.PI/2+i*Math.PI*2/5;return '<path d="M42 21L'+nfN(42+Math.cos(a)*16.5)+' '+nfN(21+Math.sin(a)*16.5)+'" stroke="#BFE39A" stroke-width=".9" opacity=".9"/>'}).join('')
    +nfThroat(id,42,21,8)
    +nfFace(42,20.5,2,'happy')
    +'<path d="M64 38Q69 35 67.5 31Q66 29 64.5 31Q64 33 66 32.5" stroke="#8FD17A" stroke-width="1" fill="none" stroke-linecap="round"/>'
    +nfFirefly(id,66,10)+mwSparkle(15,18,3,.75)+mwSparkle(64,56,2.6,.6)+nfDot(20,8,.9,.8)+nfDot(62,24,.7,.7);
}

// ── TREE · Queen of the night (night-blooming cereus) ───────────────────────
function nfPointPetal(cx,cy,ang,len,w,fill,edge){
  return '<path transform="translate('+cx+' '+cy+') rotate('+nfN(ang)+')" d="M0 0C'+(-w)+' '+nfN(-len*.4)+' '+nfN(-w*.55)+' '+nfN(-len*.85)+' 0 '+(-len)+'C'+nfN(w*.55)+' '+nfN(-len*.85)+' '+w+' '+nfN(-len*.4)+' 0 0Z" fill="'+fill+'" stroke="'+edge+'" stroke-width=".6"/>';
}
function nfCereusLeaves(){
  return nfStem('M40 77L40 70',3.4)
    +nfCactusLeaf(38,73,25,6,-158,true)+nfCactusLeaf(42,69,24,6,-28)
    +nfCactusLeaf(40,76,36,6.6,-97)+nfCactusLeaf(39,55,15,4.4,-140,true);
}
function nfCereus(st,id){
  let s=nfCereusLeaves();
  if(st===2)return s;
  // arching flower tube springs from the notch of the right leaf
  if(st===3){
    return s+nfStem('M58 62Q68 54 60 44Q54 38 49 36',2.2)
      +'<g transform="translate(49 36) rotate(-30)">'
      +nfPointPetal(0,0,-32,12,1.8,'#D9825E','#F2B08E')+nfPointPetal(0,0,30,12,1.8,'#D9825E','#F2B08E')+nfPointPetal(0,0,-14,13,1.8,'#E9A06A','#F7C29A')
      +'</g>'
      +nfBud(49,36,6.6,25,-30,'#F8E6D6','#E3A98C','#9BBF7A')
      +nfFace(nfN(49-Math.sin(30*Math.PI/180)*12),nfN(36-Math.cos(30*Math.PI/180)*12),1.7,'sleep')
      +nfZ(52,6,3.4,.85);
  }
  if(st===4){
    let o=s+nfHalo(id,40,26,24)+nfStem('M58 62Q68 54 60 44Q52 36 40 36',2.2);
    for(let i=0;i<9;i++)o+=nfPointPetal(40,35,-75+i*18.75,19,1.5,'#D9825E','#F2B08E');
    for(let i=0;i<7;i++)o+=nfPointPetal(40,36,-54+i*18,20,6,'#FFF6E4','#E9D6B6');
    o+='<ellipse cx="40" cy="19" rx="10" ry="3.8" fill="url(#nfThroat'+id+')"/>';
    for(let i=0;i<5;i++)o+=nfPointPetal(40,36,-24+i*12,17,5.4,'#FFFCF4','#EBDCC0');
    return o+nfFace(40,28,1.6,'wake')+mwSparkle(64,22,3,.8);
  }
  // full bloom: sepal spray, two petal rings, glowing cup, golden stamen fountain
  let o=s+nfHalo(id,40,25,34)+nfStem('M58 62Q70 52 60 42Q52 36 42 36',2.2);
  for(let i=0;i<16;i++)o+=nfPointPetal(40,25,i*22.5+11,24,1.5,i%2?'#D9825E':'#E9A06A','#F7C29A');
  for(let i=0;i<12;i++)o+=nfPointPetal(40,25,i*30,20,5.4,'#FFF4DE','#E4CFA8');
  for(let i=0;i<10;i++)o+=nfPointPetal(40,25,i*36+18,15,5,'#FFFDF6','#EEDFC2');
  o+=nfThroat(id,40,25,11)+'<circle cx="40" cy="25" r="5.5" fill="#FFF8DC" opacity=".9"/>';
  for(let i=0;i<13;i++){
    const a=(-150+i*10)*Math.PI/180,r=9+(i%3)*1.4,mx=40+Math.cos(a)*r*.55,my=25+Math.sin(a)*r*.55-2;
    const ex=40+Math.cos(a)*r,ey=25+Math.sin(a)*r;
    o+='<path d="M40 26Q'+nfN(mx)+' '+nfN(my)+' '+nfN(ex)+' '+nfN(ey)+'" stroke="#FFF1C2" stroke-width=".55" fill="none"/><circle cx="'+nfN(ex)+'" cy="'+nfN(ey)+'" r=".95" fill="#FFCB3D"/>';
  }
  o+='<path d="M40 27L40 19" stroke="#FFFFFF" stroke-width="1"/>'
    +'<path d="'+nfStar(40,18.5,2.6,1,6,-Math.PI/2)+'" fill="#FFFFFF" stroke="#F3E6B8" stroke-width=".4"/>';
  return o+nfMoth(66,48,18)+mwSparkle(12,14,3.2,.8)+mwSparkle(68,14,2.8,.7)+mwSparkle(12,52,2.6,.6)
    +nfDot(24,6,.9,.8)+nfDot(58,4,.8,.7)+nfDot(70,30,.7,.7);
}

const NF_ART={seed:nfFourOClock,weed:nfPrimrose,thorn:nfPhlox,vine:nfMoonflower,tree:nfCereus};

function mwStageArt(tierKey,pct,done){
  const st=mwStage(pct,done);
  const id=nfId();
  const sway=st>=2?' class="mw-sway"':'';
  const open='<svg viewBox="0 0 80 90" width="80" height="90"'+sway+' style="overflow:visible">'+nfDefs(id);
  const close='</svg>';
  const tint=NF_SEED_TINT[tierKey]||NF_SEED_TINT.weed;
  if(st===0){
    // a sleepy seed tucked in the soil
    return open
      +'<ellipse cx="40" cy="72" rx="24" ry="12" fill="#8B6542"/>'
      +'<ellipse cx="40" cy="69" rx="20" ry="10" fill="#A0785A"/>'
      +'<ellipse cx="32" cy="65" rx="7" ry="3" fill="rgba(255,255,255,.2)"/>'
      +nfHalo(id,40,58,14)
      +'<ellipse cx="40" cy="60" rx="7.5" ry="9" fill="#F5E6C8" stroke="rgba(255,255,255,.55)" stroke-width="1"/>'
      +'<path d="M35 53.5Q40 50 45 53.5Q40 52.5 35 53.5Z" fill="'+tint+'" opacity=".9"/>'
      +nfFace(40,60,1.3,'sleep')
      +nfZ(49,44,3.6,.85)+mwSparkle(22,42,3.5,.8)
      +close;
  }
  if(st===1){
    return open+MW_GROUND
      +nfStem('M40 77Q39.5 68 40 60',3.6)
      +'<path d="M40 60Q30 60 25 50Q35 47 40 56Z" fill="#5CB062" stroke="#B8F0A2" stroke-opacity=".6" stroke-width=".8"/>'
      +'<path d="M40 60Q50 60 55 50Q45 47 40 56Z" fill="#3F8C4F" stroke="#B8F0A2" stroke-opacity=".6" stroke-width=".8"/>'
      +'<ellipse cx="30" cy="53" rx="2.5" ry="1.5" fill="rgba(255,255,255,.4)"/>'
      +'<circle cx="40" cy="56.5" r="1.6" fill="'+tint+'"/>'
      +mwSparkle(58,36,3,.7)
      +close;
  }
  const fn=NF_ART[tierKey]||NF_ART.weed;
  return open+MW_GROUND+fn(st,id)+close;
}

// ── Small icons (3 bands: sprout · bud · bloom), readable at ~18px ─────────
function nfSmFlower(tierKey){
  if(tierKey==='seed'){
    return '<circle cx="16" cy="11" r="10" fill="#FF7CCB" opacity=".18"/>'
      +'<path d="'+nfLobed(16,11,8.6,5,.76,-Math.PI/2)+'" fill="#F055B8" stroke="#FFC2E8" stroke-width=".6"/>'
      +'<path d="'+nfLobed(16,11,5.6,5,.8,-Math.PI/2)+'" fill="#FF8AD2"/>'
      +'<circle cx="16" cy="11" r="2.4" fill="#FFE98A"/>';
  }
  if(tierKey==='weed'){
    let o='<circle cx="16" cy="11" r="10.5" fill="#FFF2A0" opacity=".18"/>';
    for(const a of [-8,82,172,262])o+='<path transform="translate(16 11) rotate('+a+') scale(.62)" d="M0 0C-5 -1.5 -11 -7 -10 -12.5C-9 -17.5 -3.5 -18 0 -15.6C3.5 -18 9 -17.5 10 -12.5C11 -7 5 -1.5 0 0Z" fill="#FFF09A" stroke="#FFD84A" stroke-width="1"/>';
    return o+'<path d="M13 8L19 14M19 8L13 14" stroke="#FFFDF2" stroke-width="1.3" stroke-linecap="round"/><circle cx="16" cy="11" r="1.8" fill="#C9DC5A"/>';
  }
  if(tierKey==='thorn'){
    return '<circle cx="16" cy="12" r="11" fill="#E6DBFF" opacity=".16"/>'
      +nfPhloxFloret(10.5,14.5,.78,20)+nfPhloxFloret(21.5,14,.78,-15)+nfPhloxFloret(16,8.5,1.05,0);
  }
  if(tierKey==='vine'){
    return '<circle cx="16" cy="11" r="11" fill="#FFFFFF" opacity=".16"/>'
      +'<path d="'+nfLobed(16,11,9.6,5,.93,-Math.PI/2)+'" fill="#FBFAFF" stroke="#C9BEF2" stroke-width=".7"/>'
      +'<path d="'+nfStar(16,11,8.6,3.2,5,-Math.PI/2)+'" fill="#D6EFB4"/>'
      +'<circle cx="16" cy="11" r="2" fill="#FFF3A8"/>';
  }
  // tree: queen of the night
  let o='<circle cx="16" cy="11" r="12" fill="#FFF3D6" opacity=".18"/>';
  for(let i=0;i<10;i++)o+=nfPointPetal(16,11,i*36+18,11.5,1.1,'#E08E60','#F2B08E');
  for(let i=0;i<8;i++)o+=nfPointPetal(16,11,i*45,9.4,3.2,'#FFF6E4','#E4CFA8');
  return o+'<circle cx="16" cy="11" r="3" fill="#FFF8DC"/><circle cx="14.6" cy="9.8" r=".9" fill="#FFC93D"/><circle cx="17.4" cy="9.6" r=".9" fill="#FFC93D"/><circle cx="16" cy="8.4" r=".9" fill="#FFC93D"/><circle cx="16" cy="11.2" r="1" fill="#FFFFFF"/>';
}
function nfSmBud(tierKey){
  switch(tierKey){
    case 'seed':return nfBud(16,17.5,3.4,11,0,'#F055B8','#FFA3DC');
    case 'weed':return nfBud(16,17.5,3.4,12,0,'#F6ECA0','#D9AE45','#8FA64A');
    case 'thorn':return nfBud(12.5,18,1.8,7,-22,'#B8386A','#E47AA4')+nfBud(19.5,18,1.8,7,22,'#B8386A','#E47AA4')+nfBud(16,17.5,2.8,10,0,'#C24477','#EE8EB5');
    case 'vine':return nfBud(16,18,3.2,14,4,'#F4F1FF','#A99BE6');
    default:return nfBud(17,18,4.2,12.5,-18,'#F8E6D6','#D98F70','#C9704F');
  }
}
function smStageArt(tierKey,pct,done){
  const st=smStage(pct,done);
  const open='<svg viewBox="0 0 32 38" width="1em" height="1.15em" style="vertical-align:middle;display:inline-block;overflow:visible">';
  const close='</svg>';
  const ground='<ellipse cx="16" cy="34" rx="9" ry="3" fill="#8B6542"/><ellipse cx="16" cy="33.2" rx="7" ry="2.2" fill="#A0785A"/>';
  const stem=d=>'<path d="'+d+'" stroke="#A6E596" stroke-width="3.6" stroke-linecap="round" fill="none" opacity=".45"/><path d="'+d+'" stroke="#3C8A4E" stroke-width="2.3" stroke-linecap="round" fill="none"/>';
  const lf='fill="#5CB062" stroke="#B8F0A2" stroke-opacity=".6" stroke-width=".6"';
  const lr='fill="#3F8C4F" stroke="#B8F0A2" stroke-opacity=".6" stroke-width=".6"';
  if(st===0){
    return open+ground+stem('M16 33Q15.8 28 16 23')
      +'<path d="M16 23Q10 23 7 17Q13 15.5 16 21Z" '+lf+'/>'
      +'<path d="M16 23Q22 23 25 17Q19 15.5 16 21Z" '+lr+'/>'
      +close;
  }
  const leaves='<path d="M16 28Q10.5 28 8 22.5Q13.5 21.5 16 26Z" '+lf+'/><path d="M16 28Q21.5 28 24 22.5Q18.5 21.5 16 26Z" '+lr+'/>';
  if(st===1)return open+ground+stem('M16 33Q15.6 25 16 18')+leaves+nfSmBud(tierKey)+close;
  return open+ground+stem('M16 33Q15.6 24 16 16')+leaves+nfSmFlower(tierKey)+close;
}


// ── Night garden creatures (Magical Night Garden) ─────────────────────────────
// const NIGHT_IC: same inline format as IC (width="1em", height in em, same style).
// Drop-in keys: butterfly (luna moth), bee (firefly), ladybug (glow beetle),
// hedgehog (sleepy, nightcap), caterpillar (glowworm).
// New keys: owl, snail, toad, bunny, wisp, bat, moon.
// No <defs>/ids anywhere: strings are repeated many times on one page.
// Optional animation hooks: .nc-wing, .nc-glow, .nc-eye.
const NIGHT_IC=(function(){
  const INK='#2B1633',BL='#FF8FB8',GLOW='#FFF3A0';
  const wrap=(vb,w,h,body)=>{
    return '<svg viewBox="'+vb+'" width="'+w+'em" height="'+h+'em" style="vertical-align:middle;display:inline-block">'+body+'</svg>';
  };
  // big shiny eye: ink disc + two highlights
  const eye=(x,y,r)=>'<g class="nc-eye"><circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="'+INK+'"/>'
    +'<circle cx="'+(x+r*.32).toFixed(2)+'" cy="'+(y-r*.34).toFixed(2)+'" r="'+(r*.42).toFixed(2)+'" fill="#fff"/>'
    +'<circle cx="'+(x-r*.35).toFixed(2)+'" cy="'+(y+r*.38).toFixed(2)+'" r="'+(r*.17).toFixed(2)+'" fill="#fff" opacity=".85"/></g>';
  // closed happy/sleepy eye (arc)
  const shut=(x,y,w,sw)=>'<path d="M'+(x-w)+' '+y+'Q'+x+' '+(y+w*.9)+' '+(x+w)+' '+y+'" stroke="'+INK+'" stroke-width="'+sw+'" fill="none" stroke-linecap="round"/>';
  const blush=(x,y,rx,ry,o)=>'<ellipse cx="'+x+'" cy="'+y+'" rx="'+rx+'" ry="'+ry+'" fill="'+BL+'" opacity="'+(o||.6)+'"/>';
  const smile=(x,y,w,sw)=>'<path d="M'+(x-w)+' '+y+'Q'+x+' '+(y+w)+' '+(x+w)+' '+y+'" stroke="'+INK+'" stroke-width="'+sw+'" fill="none" stroke-linecap="round"/>';
  const halo=(x,y,r,c,o)=>'<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="'+c+'" opacity="'+o+'"/>';
  const glow=(x,y,r,c)=>'<g class="nc-glow">'+halo(x,y,r,c,.05)+halo(x,y,r*.82,c,.06)+halo(x,y,r*.64,c,.08)+halo(x,y,r*.46,c,.1)+'</g>';
  const star=(x,y,s,c)=>'<path d="M'+x+' '+(y-s)+'Q'+(x+s*.18)+' '+(y-s*.18)+' '+(x+s)+' '+y+'Q'+(x+s*.18)+' '+(y+s*.18)+' '+x+' '+(y+s)+'Q'+(x-s*.18)+' '+(y+s*.18)+' '+(x-s)+' '+y+'Q'+(x-s*.18)+' '+(y-s*.18)+' '+x+' '+(y-s)+'Z" fill="'+c+'"/>';

  // ── Luna moth ──
  const mothHalf='<path d="M23 20C19 8 8 2 4 8C0 14 5 22 13 23C17 23.5 21 23 23 22Z" fill="#B9F2D0" stroke="#E6FFF1" stroke-width="1.2" stroke-linejoin="round"/>'
    +'<path d="M22 12C17 8 11 7 7 9" stroke="#8FE8B8" stroke-width="1.2" fill="none" stroke-linecap="round"/>'
    +'<circle cx="12" cy="14.5" r="3.4" fill="#FFD24A"/><circle cx="12" cy="14.5" r="1.9" fill="#FF9F6E"/><circle cx="12.6" cy="13.8" r=".7" fill="#fff"/>'
    +'<path d="M23 23C17 23 10 26 11 31C11.5 34 9 38 6 42.5C11 41.5 15 38 16.5 34C19 30 23 28 23 23Z" fill="#9FEBC2" stroke="#E6FFF1" stroke-width="1.2" stroke-linejoin="round"/>'
    +'<circle cx="16.5" cy="28" r="1.7" fill="#FFD24A"/>';
  const moth=wrap('0 0 48 46',1,.96,
    '<g class="nc-wing">'+mothHalf+'</g>'
    +'<g class="nc-wing"><g transform="translate(48 0) scale(-1 1)">'+mothHalf+'</g></g>'
    +'<path d="M22 12C20 7 17 5 14 4M26 12C28 7 31 5 34 4" stroke="#FFD24A" stroke-width="1.5" fill="none" stroke-linecap="round"/>'
    +'<path d="M17.5 5.5l-1.3-2.4M16 6.8l-2.2-1.6M30.5 5.5l1.3-2.4M32 6.8l2.2-1.6" stroke="#FFD24A" stroke-width="1" stroke-linecap="round"/>'
    +'<ellipse cx="24" cy="26" rx="4" ry="9" fill="#FFF4E8" stroke="#FFFFFF" stroke-width=".8"/>'
    +'<path d="M20.4 25h7.2M20.6 29h6.8" stroke="#E7D6C4" stroke-width="1"/>'
    +'<circle cx="24" cy="15.5" r="6" fill="#FFF4E8" stroke="#fff" stroke-width=".8"/>'
    +eye(21.8,15.3,1.55)+eye(26.2,15.3,1.55)+blush(20.4,18,1.3,.8,.7)+blush(27.6,18,1.3,.8,.7));

  // ── Firefly ──
  const firefly=wrap('0 0 48 40',1,.83,
    glow(33,26.5,14,GLOW)
    +'<path d="M14 30l-2 5M19 31l-1 5M24 31l1 4.5" stroke="#C9A2FF" stroke-width="1.6" stroke-linecap="round"/>'
    +'<ellipse cx="33" cy="26.5" rx="9" ry="8.5" fill="'+GLOW+'" class="nc-glow"/>'
    +'<ellipse cx="34" cy="25.5" rx="5.5" ry="5" fill="#FFFDE6"/>'
    +'<ellipse cx="22" cy="24" rx="10" ry="8.5" fill="#5B3A73" stroke="#A884D6" stroke-width="1.3"/>'
    +'<g class="nc-wing"><ellipse cx="25" cy="13" rx="9" ry="5.5" transform="rotate(-18 25 13)" fill="#E6DCFF" opacity=".62" stroke="#fff" stroke-width="1"/>'
    +'<ellipse cx="30" cy="15" rx="7" ry="4.3" transform="rotate(12 30 15)" fill="#E6DCFF" opacity=".5" stroke="#fff" stroke-width="1"/></g>'
    +'<path d="M9 9C8 5 6 3 3 3M15 8C16 4 18 2 21 2" stroke="#C9A2FF" stroke-width="1.5" fill="none" stroke-linecap="round"/>'
    +'<circle cx="3" cy="3" r="1.6" fill="#C9A2FF"/><circle cx="21" cy="2.2" r="1.6" fill="#C9A2FF"/>'
    +'<circle cx="12.5" cy="18" r="9" fill="#FF9F6E" stroke="#FFC7A6" stroke-width="1.2"/>'
    +eye(9.5,17.5,2.4)+eye(16,17.5,2.4)+blush(7.5,21.5,1.6,1,.8)+blush(18,21.5,1.6,1,.8)+smile(12.7,21.5,1.6,1.1));

  // ── Glow beetle (ladybug) ──
  const ladybug=wrap('0 0 40 38',1,.95,
    '<ellipse cx="20" cy="17" rx="15" ry="13.5" fill="none" stroke="#FF8FA0" stroke-width="4.5" opacity=".22" class="nc-glow"/>'
    +'<path d="M8.5 27.5l-2.5 2M31.5 27.5l2.5 2" stroke="#B99BD6" stroke-width="2" stroke-linecap="round"/>'
    +'<ellipse cx="20" cy="17" rx="15" ry="13.5" fill="#F0566A" stroke="#FFA3AE" stroke-width="1.4"/>'
    +'<path d="M20 4v24" stroke="#9C2F48" stroke-width="1.4"/>'
    +'<path d="M10 10Q13 6 17 5.5" stroke="#FFC9CF" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".8"/>'
    +'<g class="nc-glow">'+halo(13,12.5,3.8,GLOW,.35)+halo(27,12.5,3.8,GLOW,.35)+halo(9.5,21.5,3,GLOW,.35)+halo(30.5,21.5,3,GLOW,.35)+'</g>'
    +'<circle cx="13" cy="12.5" r="2.4" fill="'+GLOW+'"/><circle cx="27" cy="12.5" r="2.4" fill="'+GLOW+'"/>'
    +'<circle cx="9.5" cy="21.5" r="1.9" fill="'+GLOW+'"/><circle cx="30.5" cy="21.5" r="1.9" fill="'+GLOW+'"/>'
    +'<path d="M16 25C14 21 11 20 9 21M24 25C26 21 29 20 31 21" stroke="none" fill="none"/>'
    +'<ellipse cx="20" cy="28.5" rx="9.5" ry="7.5" fill="#5E3F7C" stroke="#B596DC" stroke-width="1.3"/>'
    +    +'<circle cx="16.3" cy="28.2" r="2.75" fill="#fff"/><circle cx="23.7" cy="28.2" r="2.75" fill="#fff"/>'
    +eye(16.4,28.4,2.25)+eye(23.6,28.4,2.25)+blush(13.2,32,1.4,.9,.8)+blush(26.8,32,1.4,.9,.8)
    +'<path d="M18.6 32.6Q20 33.8 21.4 32.6" stroke="#FFD5E2" stroke-width="1.1" fill="none" stroke-linecap="round"/>');

  // ── Sleepy hedgehog in a nightcap ──
  const hedgehog=wrap('0 0 50 40',1,.8,
    '<path d="M5 33L2 29L6 27.5L2.5 22.5L8 21.5L5.5 15.5L11.5 16L10.5 10L16 12.5L17 6.5L21.5 10.5L24.5 5L27 10.5L31 6.5L31.5 12.5L35 11L34 17L38 19L36 34Z" fill="#7A4E3E" stroke="#C99A7E" stroke-width="1.3" stroke-linejoin="round"/>'
    +'<path d="M11 22l3-2M16 16l3-2M22 13l2-3M14 28l3-2M20 21l3-2M27 15l2-3M25 25l2-3" stroke="#C99A7E" stroke-width="1.1" stroke-linecap="round" opacity=".7"/>'
    +'<path d="M31 18C38 16 45 21 46.5 27C47 30 44 33 39 34L25 35C27 28 27 21 31 18Z" fill="#F6DCC2" stroke="#FFF1E2" stroke-width="1"/>'
    +'<circle cx="46.2" cy="27.2" r="2.1" fill="'+INK+'"/><circle cx="46.8" cy="26.5" r=".6" fill="#fff"/>'
    +shut(38.5,24.5,2.2,1.3)+blush(40,29,2,1.2,.75)
    +'<path d="M41.5 30.5Q43 31.5 44.5 30.5" stroke="'+INK+'" stroke-width="1" fill="none" stroke-linecap="round"/>'
    +'<ellipse cx="12" cy="35" rx="4" ry="2.2" fill="#F6DCC2"/><ellipse cx="33" cy="35" rx="4" ry="2.2" fill="#F6DCC2"/>'
    +'<path d="M29.5 19.5C31 16 36 14.5 40 17.5C38 11 32 8 26 8.5C22 9 19 11 18.5 14C22 12.5 26 13 29.5 19.5Z" fill="#C9A2FF" stroke="#E6D4FF" stroke-width="1.1" stroke-linejoin="round"/>'
    +'<path d="M29 18.5C31.5 15.5 36 15 40.5 18" stroke="#FFF4E8" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
    +'<circle cx="18.2" cy="14.6" r="3" fill="'+GLOW+'" class="nc-glow"/>'
    +'<path d="M42 7h4l-4 4h4" stroke="#9FC2FF" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>');

  // ── Glowworm ──
  const caterpillar=wrap('0 0 52 28',1.2,.65,
    glow(9,17,9,GLOW)
    +'<circle cx="8" cy="19" r="5" fill="'+GLOW+'" class="nc-glow"/><circle cx="8.5" cy="18.3" r="2.8" fill="#FFFDE6"/>'
    +'<circle cx="16" cy="18.5" r="5.5" fill="#6FD3A0" stroke="#C8F7DD" stroke-width="1"/>'
    +'<circle cx="24" cy="17.8" r="6" fill="#8FE8B8" stroke="#D6FBE6" stroke-width="1"/>'
    +'<circle cx="32" cy="17" r="6.3" fill="#6FD3A0" stroke="#C8F7DD" stroke-width="1"/>'
    +'<path d="M14 24.5v2M22 24.5v2M30 24v2.5" stroke="#6FD3A0" stroke-width="1.8" stroke-linecap="round"/>'
    +'<path d="M38 7C37 4 35.5 3 34 2.5M45 7C46 4 47.5 3 49 2.5" stroke="#8FE8B8" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
    +'<circle cx="34" cy="2.6" r="1.8" fill="'+GLOW+'"/><circle cx="49" cy="2.6" r="1.8" fill="'+GLOW+'"/>'
    +'<circle cx="41.5" cy="14" r="9" fill="#A6F0C8" stroke="#E0FFEE" stroke-width="1.1"/>'
    +eye(38.5,13.5,2.2)+eye(44.8,13.5,2.2)+blush(36.5,17.5,1.5,1,.8)+blush(46.8,17.5,1.5,1,.8)+smile(41.6,17.4,1.5,1.1));

  // ── Owl on a branch ──
  const owl=wrap('0 0 40 46',1,1.15,
    '<path d="M2 40.5Q20 37.5 38 40.5" stroke="#8A5E4A" stroke-width="3.6" fill="none" stroke-linecap="round"/>'
    +'<path d="M2 40.5Q20 37.5 38 40.5" stroke="#C9977A" stroke-width="1" fill="none" stroke-linecap="round" opacity=".7" transform="translate(0 -1.3)"/>'
    +'<path d="M7 12L9 3L15 8.5Z M33 12L31 3L25 8.5Z" fill="#6E4F96" stroke="#B794E6" stroke-width="1.2" stroke-linejoin="round"/>'
    +'<ellipse cx="20" cy="23" rx="14" ry="16" fill="#6E4F96" stroke="#B794E6" stroke-width="1.3"/>'
    +'<ellipse cx="20" cy="29" rx="8.5" ry="9" fill="#C9A2FF"/>'
    +'<path d="M16 26.5q1.5 1.3 3 0M21 26.5q1.5 1.3 3 0M18.5 30.5q1.5 1.3 3 0M16 34q1.5 1.3 3 0M21 34q1.5 1.3 3 0" stroke="#8E6CC0" stroke-width="1" fill="none" stroke-linecap="round"/>'
    +'<path d="M7 20Q3.5 28 8 35Q10 28 9 21Z M33 20Q36.5 28 32 35Q30 28 31 21Z" fill="#553A7A" stroke="#B794E6" stroke-width="1" stroke-linejoin="round" class="nc-wing"/>'
    +'<circle cx="14" cy="16.5" r="6.2" fill="#F3E8FF"/><circle cx="26" cy="16.5" r="6.2" fill="#F3E8FF"/>'
    +'<circle cx="14" cy="16.5" r="4.4" fill="#FFD24A"/><circle cx="26" cy="16.5" r="4.4" fill="#FFD24A"/>'
    +eye(14,16.6,3)+eye(26,16.6,3)
    +'<path d="M18.3 21L21.7 21L20 24Z" fill="#FF9F6E" stroke="#FFC29E" stroke-width=".6" stroke-linejoin="round"/>'
    +blush(9.5,23,1.8,1.1,.7)+blush(30.5,23,1.8,1.1,.7)
    +'<path d="M15 38.5v2.5M17 38.5v2.5M23 38.5v2.5M25 38.5v2.5" stroke="#FF9F6E" stroke-width="1.5" stroke-linecap="round"/>');

  // ── Snail with a glowing shell ──
  const snail=wrap('0 0 50 38',1,.76,
    '<path d="M4 33C4 29 10 28 18 28L36 27C40 22 38 17 39 13C40 9 47 9 47.5 14C48 20 46 28 42 32C39 35 33 35.5 26 35.5L7 35.5C5 35.5 4 34.5 4 33Z" fill="#8FE8B8" stroke="#D6FBE6" stroke-width="1.1" stroke-linejoin="round"/>'
    +'<path d="M40.5 10.5L38.5 3.5M45.5 10L47 3" stroke="#8FE8B8" stroke-width="1.8" stroke-linecap="round"/>'
    +'<circle cx="38.3" cy="3.6" r="2.6" fill="#fff"/><circle cx="47" cy="3.3" r="2.6" fill="#fff"/>'
    +eye(38.8,4,1.6)+eye(47.3,3.7,1.6)
    +blush(41,17.5,1.6,1,.8)+smile(44,16.5,1.6,1.1)
    +'<circle cx="20" cy="19" r="13.5" fill="none" stroke="#C9A2FF" stroke-width="4" opacity=".3" class="nc-glow"/>'
    +'<circle cx="20" cy="19" r="12.5" fill="#A67FE0" stroke="#E2CCFF" stroke-width="1.3"/>'
    +'<path class="nc-glow" d="M20.5 19.5C21.8 18.2 20.5 16 18.5 16.5C15.5 17.2 15.8 21.5 18.8 22.6C23 24 26 20 25 16C23.8 11.5 17.5 10.5 14 13.5C10 17 11 24 15.5 26.5" stroke="'+GLOW+'" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
    +'<path d="M12 11Q15 8 19 7.8" stroke="#E8DAFF" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".8"/>');

  // ── Toad on a glowing toadstool ──
  const toad=wrap('0 0 44 50',1,1.14,
    '<path d="M17 36Q16 44 15.5 47.5H28.5Q28 44 27 36Z" fill="#FFF4E8" stroke="#fff" stroke-width=".8"/>'
    +'<path d="M3 37C3 28 11 23.5 22 23.5S41 28 41 37Q22 40 3 37Z" fill="none" stroke="#FF9F6E" stroke-width="5" stroke-linejoin="round" opacity=".25" class="nc-glow"/>'
    +'<path d="M3 37C3 28 11 23.5 22 23.5S41 28 41 37Q22 40 3 37Z" fill="#FF9F6E" stroke="#FFCBAA" stroke-width="1.3" stroke-linejoin="round"/>'
    +'<g class="nc-glow"><circle cx="9" cy="33" r="2" fill="'+GLOW+'"/><circle cx="35" cy="33" r="2" fill="'+GLOW+'"/><circle cx="15" cy="36.3" r="1.4" fill="'+GLOW+'"/><circle cx="29" cy="36.3" r="1.4" fill="'+GLOW+'"/></g>'
    +'<path d="M8 27Q11 25 14 24.5" stroke="#FFD9C2" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".8"/>'
    +'<path d="M8.5 26C8 17 14 12 22 12S36 17 35.5 26C31 27.5 13 27.5 8.5 26Z" fill="#6FAF6A" stroke="#B8F0A2" stroke-width="1.3" stroke-linejoin="round"/>'
    +'<ellipse cx="22" cy="23" rx="7.5" ry="3.3" fill="#D5F0BE"/>'
    +'<circle cx="15" cy="12.5" r="5" fill="#6FAF6A" stroke="#B8F0A2" stroke-width="1.3"/><circle cx="29" cy="12.5" r="5" fill="#6FAF6A" stroke="#B8F0A2" stroke-width="1.3"/>'
    +'<circle cx="15" cy="12.5" r="3.6" fill="#fff"/><circle cx="29" cy="12.5" r="3.6" fill="#fff"/>'
    +eye(15.4,12.9,2.5)+eye(29.4,12.9,2.5)
    +blush(12,19.5,2,1.2,.7)+blush(32,19.5,2,1.2,.7)
    +'<path d="M16 18.5Q22 22.5 28 18.5" stroke="'+INK+'" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
    +'<ellipse cx="11.5" cy="26" rx="3.4" ry="1.8" fill="#8FCB84"/><ellipse cx="32.5" cy="26" rx="3.4" ry="1.8" fill="#8FCB84"/>');

  // ── Moon bunny ──
  const bunny=wrap('0 0 42 48',1,1.14,
    '<path d="M32.5 5.2A6 6 0 1 0 38.5 13.5A4.6 4.6 0 1 1 32.5 5.2Z" fill="#FFD24A" class="nc-glow"/>'
    +'<path d="M15 20C11 14 10.5 5 13 3C15.5 1.5 18 8 18.5 18Z" fill="#F3EEFF" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>'
    +'<path d="M14.5 15C13 11 13 6.5 13.8 5.2C15 5.5 16.5 10 16.6 15Z" fill="#FFB8D0"/>'
    +'<path d="M22.5 18.5C24 10 28 5.5 31 7C33.5 8.5 30 16 25.5 20.5Z" fill="#F3EEFF" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>'
    +'<path d="M24.5 17C26 12 28.5 8.8 30 9.2C30.5 11 28.5 14.5 26 17.5Z" fill="#FFB8D0"/>'
    +'<ellipse cx="21" cy="37" rx="12.5" ry="9.5" fill="#E6DEFA" stroke="#fff" stroke-width="1"/>'
    +'<circle cx="32.5" cy="40.5" r="3.4" fill="#fff"/>'
    +'<circle cx="20" cy="25" r="10" fill="#F3EEFF" stroke="#fff" stroke-width="1"/>'
    +eye(16,24.5,2.3)+eye(24,24.5,2.3)+blush(13.5,28.5,1.9,1.1,.75)+blush(26.5,28.5,1.9,1.1,.75)
    +'<path d="M19 27.6h2l-1 1.2Z" fill="#FF8FB8"/>'
    +'<path d="M18.2 29.7Q19.1 30.8 20 29.7Q20.9 30.8 21.8 29.7" stroke="'+INK+'" stroke-width=".9" fill="none" stroke-linecap="round"/>'
    +'<ellipse cx="15" cy="44.5" rx="4" ry="2.2" fill="#F3EEFF"/><ellipse cx="25" cy="44.5" rx="4" ry="2.2" fill="#F3EEFF"/>'
    +'<ellipse cx="17" cy="37" rx="2.4" ry="2" fill="#F3EEFF"/><ellipse cx="23" cy="37" rx="2.4" ry="2" fill="#F3EEFF"/>'
    +star(6,10,2.6,GLOW)+star(37,26,1.8,GLOW));

  // ── Will-o'-the-wisp ──
  const wisp=wrap('0 0 38 46',1,1.2,
    '<g class="nc-glow"><path d="M19 42C9.5 42 5 35 6.5 27.5C8 20 13 18 13.5 11C16 14 17.5 16 17.5 18.5C19 13 21 7 26 3C25 9 27.5 13 30 17.5C33 23 33.5 30 30 35.5C27.5 39.5 23.5 42 19 42Z" fill="#9FC2FF" stroke="#BFD6FF" stroke-width="3.6" stroke-linejoin="round" opacity=".38"/><path d="M19 42C9.5 42 5 35 6.5 27.5C8 20 13 18 13.5 11C16 14 17.5 16 17.5 18.5C19 13 21 7 26 3C25 9 27.5 13 30 17.5C33 23 33.5 30 30 35.5C27.5 39.5 23.5 42 19 42Z" fill="#9FC2FF" stroke="#CFE0FF" stroke-width="1.1" stroke-linejoin="round"/></g>'
    +'<path d="M19 40C12 40 9 35 10 29.5C11 24 15 22 16.5 17.5C18 20 19 21.5 19.5 23C21 19 23 16 25.5 13C25.5 18 28.5 21 29 26C29.8 33 25.5 40 19 40Z" fill="#DCE8FF"/>'
    +'<ellipse cx="19.5" cy="32" rx="7.5" ry="6.8" fill="#F7FAFF"/>'
    +eye(16.4,31,1.9)+eye(22.6,31,1.9)+blush(14,34.6,1.5,.9,.75)+blush(25,34.6,1.5,.9,.75)+smile(19.5,34.2,1.3,1)
    +star(5,12,1.8,GLOW)+star(34,9,1.4,GLOW)+'<circle cx="33" cy="40" r="1" fill="'+GLOW+'"/>');

  // ── Fruit bat ──
  const batWing='<path d="M20 17C15 10 7 7 2 9C3 12 3.5 14 3 17C5 16.5 7 17 8 19C9.5 18 11.5 18.5 12.5 20.5C14 19.5 16.5 20 18 22Z" fill="#5A3A73" stroke="#B794E6" stroke-width="1.2" stroke-linejoin="round"/>'
    +'<path d="M18 14.5L9 10.5M18 16.8L7 16.5" stroke="#8A68B5" stroke-width=".9" stroke-linecap="round"/>';
  const bat=wrap('0 0 52 34',1,.65,
    '<g class="nc-wing"><g transform="translate(0 0)">'+batWing+'</g></g>'
    +'<g class="nc-wing"><g transform="translate(52 0) scale(-1 1)">'+batWing+'</g></g>'
    +'<ellipse cx="26" cy="23.5" rx="7.5" ry="8" fill="#B9785E" stroke="#E3AE93" stroke-width="1.1"/>'
    +'<ellipse cx="26" cy="25" rx="4.5" ry="5" fill="#D99A7E"/>'
    +'<path d="M18.5 9L17 1.8L22.5 6ZM33.5 9L35 1.8L29.5 6Z" fill="#8A5A4A" stroke="#E3AE93" stroke-width="1.1" stroke-linejoin="round"/>'
    +'<path d="M19.2 7L18.4 3.8L21 6Z M32.8 7L33.6 3.8L31 6Z" fill="#FFB8D0"/>'
    +'<circle cx="26" cy="12.5" r="8.5" fill="#B9785E" stroke="#E3AE93" stroke-width="1.1"/>'
    +'<ellipse cx="26" cy="15.5" rx="4.2" ry="3" fill="#E8BFA8"/>'
    +eye(22.4,11.4,2.2)+eye(29.6,11.4,2.2)+blush(20.2,15.2,1.5,.9,.8)+blush(31.8,15.2,1.5,.9,.8)
    +'<ellipse cx="26" cy="14.4" rx="1.1" ry=".75" fill="'+INK+'"/>'
    +smile(26,16.2,1.3,.9)
    +'<path d="M23 31v2M29 31v2" stroke="#E3AE93" stroke-width="1.3" stroke-linecap="round"/>');

  // ── Crescent moon in a nightcap ──
  const moon=wrap('0 0 46 46',1,1,
    '<path d="M27 7.5A18 18 0 1 0 27 42.5A23.1 23.1 0 0 1 27 7.5Z" fill="#FFE27A" stroke="#FFF3A0" stroke-width="1.3" class="nc-glow"/>'
    +'<path d="M8 20Q7 27 10 33" stroke="#FFF6C8" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".8"/>'
    +'<circle cx="9" cy="33" r="1.2" fill="#F2C94C" opacity=".6"/><circle cx="15" cy="37" r="1" fill="#F2C94C" opacity=".6"/>'
    +shut(14,22.5,2,1.3)+blush(12.5,27.5,2,1.2,.75)
    +'<path d="M15.2 29.6Q17.2 31 18.4 29.2" stroke="'+INK+'" stroke-width="1.2" fill="none" stroke-linecap="round"/>'
    +'<path d="M9.5 14C12 7 19 3.5 26 4.5C31 5.5 34.5 9 35 13.5C33 12.5 31 12.5 29 13.2C27.5 10.5 24 9.5 19.5 10C15.5 10.5 12 12 9.5 14Z" fill="#C9A2FF" stroke="#E6D4FF" stroke-width="1.1" stroke-linejoin="round"/>'
    +'<path d="M9.5 14C14 10.5 22 9.5 28 11.5" stroke="#FFF4E8" stroke-width="2.8" fill="none" stroke-linecap="round"/>'
    +'<circle cx="35" cy="14.8" r="2.7" fill="#FFF4E8"/>'
    +star(40,31,2,GLOW)+star(35,40,1.3,GLOW)
    +'<path d="M37 21h3.4l-3.4 3.4h3.4" stroke="#9FC2FF" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>');

  return {butterfly:moth,bee:firefly,ladybug:ladybug,hedgehog:hedgehog,caterpillar:caterpillar,
    owl:owl,snail:snail,toad:toad,bunny:bunny,wisp:wisp,bat:bat,moon:moon};
})();

// ── Night Bloom creatures ─────────────────────────────────────────────────────
// NIGHT_IC (scripts/art/night-creatures.js) replaces the old day creatures under the same keys,
// so every existing use upgrades: butterfly = luna moth, bee = firefly, ladybug = glow beetle,
// hedgehog = sleepy hedgehog, caterpillar = glowworm. New ones: owl, snail, toad, bunny, wisp, bat, moon.
Object.assign(IC, NIGHT_IC);
// scene.js reads window.IC. Before this it was never set (IC is a const), so the garden's
// moth flights, beetles and hovering bee never appeared.
window.IC = IC;
// Each flower size gets its own creature in the bloom popup.
const NB_CEL = {tree:['owl','moon'], vine:['butterfly','wisp'], thorn:['toad','snail'], weed:['bunny','butterfly'], seed:['bee','ladybug']};
function nbCelebCreature(key){ const a = NB_CEL[key] || NB_CEL.seed; return IC[a[Math.floor(Math.random()*a.length)]]; }
