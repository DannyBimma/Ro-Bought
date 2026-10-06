// Ro-Bought content script — injected ONLY into the configured retailer site.
// Handshake, page guards (pause + hand back), heartbeat/visibility, status panel, and the
// trigger controller (content/watcher.js). The checkout engine arrives in Phase 4.
(() => {
  'use strict';

  // Guard against double injection.
  if (RoBought.contentLoaded) return;
  Object.defineProperty(RoBought, 'contentLoaded', { value: true });

  const {
    STORAGE_KEYS, MESSAGES, RUN_STATUS, ACTIVE_STATUSES, TERMINAL_STATUSES,
    HEARTBEAT_MS, PAUSE_HINTS, STATUS_LABELS,
  } = RoBought.constants;

  const GUARD_CHECK_DELAY_MS = 250;
  const OBSERVED_ATTRIBUTES = ['style', 'class', 'hidden', 'src', 'open', 'aria-hidden'];

  let myTabId = null;
  let state = null;
  let runConfig = null;   // validated config subset, from the service worker
  let savedWatch = null;  // watcher memory from earlier page loads of this run
  let watcherNote = '';   // the watcher's latest one-line status
  let observer = null;
  let checkTimer = null;
  let heartbeatTimer = null;
  let lastGuardSignature; // undefined = nothing reported from this page yet
  let dismissed = false;  // user dismissed a finished-run message on this page
  let flash = '';         // one-off error shown in the panel until the next state change
  let dead = false;

  const isRunTab = () => !!state && myTabId !== null && state.tabId === myTabId;
  const isActive = () => isRunTab() && ACTIVE_STATUSES.includes(state.status);
  // Guards and heartbeat run while the bot is (or may soon be) acting — not once the user
  // has taken over the purchase.
  const isGuarding = () => isActive() && state.status !== RUN_STATUS.AWAITING_USER;
  const pageVisible = () => document.visibilityState === 'visible';

  // ---------------------------------------------------------------------------
  // Messaging. If the extension is reloaded or removed, this script is orphaned:
  // detect it and tear everything down so nothing leaks.
  // ---------------------------------------------------------------------------

  async function send(type, payload = {}) {
    if (dead) return null;
    if (!chrome.runtime?.id) {
      teardown();
      return null;
    }
    try {
      return await chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      if (!chrome.runtime?.id) teardown();
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Guards: watch the page while the run is active; report changes only.
  // ---------------------------------------------------------------------------

  function checkGuards() {
    checkTimer = null;
    if (!isGuarding()) return;
    RoBought.overlay.ensureAttached();
    const hit = RoBought.guards.detectBlocker(document, location);
    const signature = hit ? hit.signature : null;
    if (signature === lastGuardSignature) return;
    lastGuardSignature = signature;
    send(MESSAGES.GUARD_STATUS, {
      guard: hit ? { kind: hit.kind, label: hit.label, signature } : null,
    });
  }

  function scheduleGuardCheck() {
    // Coalesce bursts of DOM mutations into one check at most every 250 ms.
    if (checkTimer === null) checkTimer = setTimeout(checkGuards, GUARD_CHECK_DELAY_MS);
  }

  function startWatching() {
    if (!observer) {
      observer = new MutationObserver(scheduleGuardCheck);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: OBSERVED_ATTRIBUTES,
      });
      lastGuardSignature = undefined;
      checkGuards();
    }
    if (heartbeatTimer === null) {
      heartbeatTimer = setInterval(() => send(MESSAGES.PRESENCE, { visible: pageVisible() }), HEARTBEAT_MS);
    }
  }

  function stopWatching() {
    if (observer) observer.disconnect();
    observer = null;
    if (checkTimer !== null) clearTimeout(checkTimer);
    checkTimer = null;
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Status panel
  // ---------------------------------------------------------------------------

  function overlayModel() {
    if (!isRunTab() || dismissed) return null;
    const s = state;
    const [pill, tone] = STATUS_LABELS[s.status] || [s.status, ''];
    const disarm = { id: 'disarm', label: 'Disarm', variant: 'danger' };

    if (s.status === RUN_STATUS.PAUSED) {
      const p = s.pause || {};
      return {
        pill, tone,
        title: p.cleared ? 'Looks clear — your call' : 'Paused — your turn',
        body: p.label || s.message,
        hint: flash || (p.cleared ? 'Click Resume when you are ready.' : PAUSE_HINTS[p.kind] || ''),
        actions: [
          p.cleared
            ? { id: 'resume', label: 'Resume', variant: 'primary' }
            : { id: 'resume', label: 'Resume anyway' },
          disarm,
        ],
      };
    }
    if (s.status === RUN_STATUS.AWAITING_USER) {
      return {
        pill, tone,
        title: 'In stock — your turn',
        body: s.message,
        hint: flash || 'Ro-Bought has stopped checking. Disarm when you are done.',
        actions: [{ id: 'disarm', label: 'Done — disarm', variant: 'primary' }],
      };
    }
    if (ACTIVE_STATUSES.includes(s.status)) {
      return {
        pill, tone,
        body: s.message,
        hint: flash || watcherNote || 'Keep this tab in the foreground and your computer awake.',
        actions: [disarm],
      };
    }
    if (TERMINAL_STATUSES.includes(s.status)) {
      return {
        pill, tone,
        title: s.status === RUN_STATUS.COMPLETED ? 'Finished' : 'Ro-Bought stopped',
        body: s.message,
        actions: [{ id: 'dismiss', label: 'Dismiss' }],
      };
    }
    return null;
  }

  function renderOverlay() {
    RoBought.overlay.render(overlayModel(), onOverlayAction);
  }

  async function onOverlayAction(id) {
    if (id === 'dismiss') {
      dismissed = true;
      renderOverlay();
      return;
    }
    const type = id === 'resume' ? MESSAGES.RESUME : id === 'disarm' ? MESSAGES.DISARM : null;
    if (!type) return;
    const res = await send(type);
    if (res && res.ok === false) {
      flash = res.error || 'That did not work.';
      renderOverlay();
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function onWatcherNote(text) {
    if (text === watcherNote) return;
    watcherNote = text;
    renderOverlay();
  }

  function applyState(next) {
    state = next && typeof next === 'object' ? next : null;
    flash = '';
    if (state && !TERMINAL_STATUSES.includes(state.status)) dismissed = false;
    if (isGuarding()) startWatching();
    else stopWatching();
    if (isActive() && runConfig) {
      RoBought.watcher.sync({ state, config: runConfig, watch: savedWatch, send, onNote: onWatcherNote });
    } else {
      RoBought.watcher.stop();
      watcherNote = '';
    }
    renderOverlay();
  }

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes[STORAGE_KEYS.RUN_STATE]) {
      applyState(changes[STORAGE_KEYS.RUN_STATE].newValue);
    }
  }

  function onVisibilityChange() {
    if (isGuarding()) send(MESSAGES.PRESENCE, { visible: pageVisible() });
  }

  async function hello() {
    // Defense in depth: options and arming already refuse ticket sites, but re-check the
    // live page (redirects, structured data, page title).
    const ticketReason =
      RoBought.ticketGuard.checkUrl(location.href) || RoBought.guards.detectTicketPage(document);
    const res = await send(MESSAGES.CONTENT_HELLO, { ticketReason, visible: pageVisible() });
    if (res && Number.isInteger(res.tabId)) myTabId = res.tabId;
    if (res && res.config && typeof res.config === 'object') runConfig = res.config;
    savedWatch = res && res.watch && typeof res.watch === 'object' ? res.watch : null;
  }

  function onPageShow(ev) {
    // Restored from the back/forward cache: re-introduce ourselves and re-report guards.
    if (!ev.persisted) return;
    lastGuardSignature = undefined;
    RoBought.watcher.revive();
    hello()
      .then(() => chrome.storage.local.get(STORAGE_KEYS.RUN_STATE))
      .then((stored) => applyState(stored[STORAGE_KEYS.RUN_STATE]))
      .then(() => checkGuards())
      .catch(() => {});
  }

  function teardown() {
    if (dead) return;
    dead = true;
    stopWatching();
    RoBought.watcher.stop();
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // context already invalidated
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
    RoBought.overlay.remove();
  }

  async function init() {
    chrome.storage.onChanged.addListener(onStorageChanged);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    await hello();
    if (dead) return;
    const stored = await chrome.storage.local.get(STORAGE_KEYS.RUN_STATE);
    applyState(stored[STORAGE_KEYS.RUN_STATE]);
  }

  init().catch(() => teardown());
})();
