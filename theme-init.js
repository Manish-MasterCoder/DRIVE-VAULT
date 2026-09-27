/**
 * @fileoverview theme-init.js
 * FOUC Prevention — Theme Bootstrap Script.
 *
 * Loaded synchronously in <head> (no defer, no async) so it executes
 * before the browser paints a single pixel. Sets the correct data-theme
 * attribute on <html> before CSS renders, eliminating theme flash.
 *
 * WHY a separate file instead of an inline <script>:
 *   Inline scripts require 'unsafe-inline' or a SHA-256 hash in the CSP
 *   script-src directive. Hashes are brittle (any whitespace change breaks
 *   them). A same-origin .js file is permitted by 'self' with zero risk.
 *
 * Storage strategy:
 *   localStorage is appropriate for UX preferences (not secrets).
 *   Tokens remain in sessionStorage; theme choice lives in localStorage
 *   so it persists across sessions.
 */
(function () {
  var STORAGE_KEY = 'dv_theme';
  var stored = '';
  try { stored = localStorage.getItem(STORAGE_KEY) || ''; } catch (_) {}
  var theme;
  if (stored === 'light' || stored === 'dark') {
    theme = stored;
  } else {
    // Honour OS/browser colour-scheme preference on first visit
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
}());
