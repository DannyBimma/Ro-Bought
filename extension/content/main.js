// Ro-Bought content script — injected ONLY into the configured retailer site.
// Handshake, page guards (pause + hand back), heartbeat/visibility and the status panel.
// Wires up the trigger controller (content/watcher.js), the checkout engine
// (content/checkout.js) and teach mode (content/teach.js).
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
  let preflightRun = null; // run whose cart check this page already started
  let introduced = false;  // the coordinator knows this tab as the run tab
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

  /** Past the product page in a checkout: only then do card/bank (payment) checks apply. */
  function inCheckout() {
    if (!state?.checkout || !runConfig) return false;
    const checkingOut = state.status === RUN_STATUS.EXECUTING
      || (state.status === RUN_STATUS.PAUSED && state.pause?.from === RUN_STATUS.EXECUTING);
    if (!checkingOut) return false;
    return !RoBought.adapters.forUrl(runConfig.productUrl).isProductPage(location.href, runConfig.productUrl);
  }
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
    const hit = RoBought.guards.detectBlocker(document, location, { checkout: inCheckout() });
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
        title: s.checkout?.ready ? 'Ready — your click' : 'Your turn',
        body: s.message,
        hint: flash || (s.checkout?.ready
          ? 'The highlighted button places the order. Ro-Bought finishes the run when the confirmation appears.'
          : 'Ro-Bought has stopped clicking. Finish the purchase yourself, or disarm.'),
        actions: [{ id: 'disarm', label: 'Disarm', variant: 'danger' }],
      };
    }
    if (s.status === RUN_STATUS.EXECUTING) {
      return {
        pill, tone,
        title: 'Buying',
        body: s.message,
        hint: flash || 'Ro-Bought is clicking through checkout. Hands off this tab for a moment.',
        actions: [disarm],
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
    if (RoBought.teach.isOpen()) return; // teach mode owns the panel
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
    // Arming opens the tab and then records it as the run tab; a fast page can say hello in
    // between and be treated as a bystander. Re-introduce ourselves once we become the run tab.
    if (!isRunTab()) introduced = false;
    else if (!introduced && myTabId !== null) {
      introduced = true;
      hello().catch(() => {});
    }
    if (state && !TERMINAL_STATUSES.includes(state.status)) dismissed = false;
    if (isGuarding()) startWatching();
    else stopWatching();
    if (isActive() && runConfig) {
      RoBought.watcher.sync({ state, config: runConfig, watch: savedWatch, send, onNote: onWatcherNote });
      RoBought.checkout.sync({ state, config: runConfig, send });
    } else {
      RoBought.watcher.stop();
      RoBought.checkout.sync(null);
      watcherNote = '';
    }
    if (isActive()) RoBought.teach.close(); // no teaching during a run
    runPreflight();
    renderOverlay();
  }

  /**
   * Once per run, right after arming: read the cart page in the background so the user hears
   * about other items in it now, not when the bot pauses at the cart during the drop.
   */
  async function runPreflight() {
    if (!isActive() || !runConfig || state.preflight !== 'pending' || preflightRun === state.runId) return;
    if (state.status !== RUN_STATUS.WATCHING && state.status !== RUN_STATUS.WAITING) return;
    preflightRun = state.runId;
    const adapter = RoBought.adapters.forUrl(runConfig.productUrl);
    let items = null;
    try {
      const cartUrl = adapter.cartUrl(runConfig.productUrl, document);
      if (cartUrl) {
        const res = await fetch(cartUrl, { credentials: 'include', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        if (res.ok && RoBought.url.inScope(res.url, runConfig.productUrl)) {
          const html = (await res.text()).slice(0, RoBought.constants.WATCH.MAX_HTML_CHARS);
          const doc = new DOMParser().parseFromString(html, 'text/html'); // never runs scripts
          if (!RoBought.guards.detectBlocker(doc, new URL(res.url), { static: true })) {
            items = adapter.readCart(doc, runConfig.productUrl).items;
          }
        }
      }
    } catch {
      // Unreadable (client-rendered cart, network): checked during checkout instead.
    }
    send(MESSAGES.PREFLIGHT, { items });
  }

  // Teach mode is opened by the service worker (popup → "Teach buttons").
  function onRuntimeMessage(msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || sender.tab || !msg || msg.type !== MESSAGES.TEACH_OPEN) return false;
    if (isActive()) {
      sendResponse({ ok: false, error: 'Disarm before teaching buttons.' });
      return false;
    }
    if (!runConfig) {
      sendResponse({ ok: false, error: 'Reload the store tab and try again.' });
      return false;
    }
    RoBought.teach.open({
      config: msg.config && typeof msg.config === 'object' ? msg.config : runConfig,
      send,
      onClose: renderOverlay,
    });
    sendResponse({ ok: true });
    return false;
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
    introduced = !!res?.runTab;
    if (res && res.config && typeof res.config === 'object') runConfig = res.config;
    savedWatch = res && res.watch && typeof res.watch === 'object' ? res.watch : null;
  }

  function onPageShow(ev) {
    // Restored from the back/forward cache: re-introduce ourselves and re-report guards.
    if (!ev.persisted) return;
    lastGuardSignature = undefined;
    RoBought.watcher.revive();
    RoBought.checkout.revive();
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
    RoBought.checkout.shutdown();
    RoBought.teach.close();
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // context already invalidated
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
    RoBought.overlay.remove();
  }

  async function init() {
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    await hello();
    if (dead) return;
    const stored = await chrome.storage.local.get(STORAGE_KEYS.RUN_STATE);
    applyState(stored[STORAGE_KEYS.RUN_STATE]);
  }

  init().catch((e) => {
    console.error('[Ro-Bought] content script failed to start:', e);
    teardown();
  });
})();
