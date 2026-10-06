// Ro-Bought content script — injected ONLY into the configured retailer origin.
// Phase 1: handshake + runtime ticket re-check. The precise clock, page guards and
// checkout engine arrive in later phases.
(() => {
  'use strict';

  // Guard against double injection (e.g. extension reload while the tab is open).
  if (RoBought.contentLoaded) return;
  Object.defineProperty(RoBought, 'contentLoaded', { value: true });

  const { MESSAGES } = RoBought.constants;

  // Defense in depth: options and arming already refuse ticket sites, but re-check the
  // live page in case of redirects to a ticketing partner.
  const ticketReason =
    RoBought.ticketGuard.checkUrl(location.href) ||
    RoBought.ticketGuard.checkText(document.title);

  chrome.runtime
    .sendMessage({ type: MESSAGES.CONTENT_HELLO, ticketReason })
    .catch(() => {
      // Service worker unavailable (e.g. extension reloaded) — nothing to do.
    });
})();
