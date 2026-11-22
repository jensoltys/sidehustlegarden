// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// focus-trap.js: keyboard focus for every modal dialog.
// Same file in every hub app. It watches for any [role=dialog][aria-modal=true]
// (or the tour box) becoming visible, however the app opens it, and:
//   - moves focus into it when it opens,
//   - keeps Tab and Shift+Tab inside it while it's the top dialog,
//   - hands focus back to whatever opened it once every dialog has closed.
// Escape stays with each app's own close path, so Back and Escape stay in sync.
(function () {
  'use strict';
  var SEL = '[role="dialog"][aria-modal="true"], #tourbox';
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var stack = []; // [{ el, opener, last }] in the order they opened
  var scheduled = false;

  function shown(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }
  function focusables(el) {
    return Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (n) {
      return n.getAttribute('tabindex') !== '-1' && shown(n);
    });
  }
  function entryFor(el) {
    for (var i = 0; i < stack.length; i++) if (stack[i].el === el) return stack[i];
    return null;
  }
  function top() {
    for (var i = stack.length - 1; i >= 0; i--) if (shown(stack[i].el)) return stack[i];
    return null;
  }
  function focusInto(entry) {
    var el = entry.el;
    if (el.contains(document.activeElement)) return;
    var target = entry.last && el.contains(entry.last) && shown(entry.last) ? entry.last : focusables(el)[0];
    if (!target) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      target = el;
    }
    try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  var current = null;     // the top dialog as of the last check
  var lastOutside = null; // last element focused outside every dialog

  function check() {
    scheduled = false;
    var all = document.querySelectorAll(SEL);
    for (var i = 0; i < all.length; i++) {
      if (shown(all[i]) && !entryFor(all[i])) {
        var active = document.activeElement;
        var opener = active && active !== document.body && !all[i].contains(active) ? active : lastOutside;
        stack.push({ el: all[i], opener: opener, last: null });
      }
    }
    stack = stack.filter(function (e) { return e.el.isConnected; });
    var now = top();
    var was = current;
    current = now;
    if (now) {
      if (now !== was) focusInto(now);
      return;
    }
    if (!stack.length) return;
    // Every dialog is closed: return focus to whatever opened the first one.
    var back = stack[0].opener;
    stack = [];
    var a = document.activeElement;
    if (back && shown(back) && (!a || a === document.body || !shown(a))) {
      try { back.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(check);
  }

  document.addEventListener('focusin', function (e) {
    var t = top();
    if (t && t.el.contains(e.target)) t.last = e.target;
    else if (!t) lastOutside = e.target;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    check();
    var t = top();
    if (!t) return;
    var items = focusables(t.el);
    if (!items.length) { e.preventDefault(); focusInto(t); return; }
    var first = items[0], last = items[items.length - 1];
    var a = document.activeElement;
    if (!t.el.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  });

  function start() {
    new MutationObserver(schedule).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'],
    });
    check();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
