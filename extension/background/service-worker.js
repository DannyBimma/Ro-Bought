// Ro-Bought service worker — the coordinator.
// It is the ONLY writer of runState, owns arm/disarm, the once-only lock, notifications,
// content-script registration and keep-awake. It never holds precise timers: Chrome may
// stop it after ~30 s idle, so everything it needs is re-derived from storage on wake.
'use strict';

importScripts(
  '../shared/namespace.js',
  '../shared/constants.js',
  '../shared/url-utils.js',
  '../shared/ticket-guard.js',
  '../shared/config.js',
);

const {
  STORAGE_KEYS, RUN_STATUS, TERMINAL_STATUSES, ACTIVE_STATUSES, MESSAGES,
  CONTENT_SCRIPT_ID, CONTENT_SCRIPT_FILES, EVENT_LOG_MAX,
} = RoBought.constants;

const EXTENSION_ORIGIN = self.location.origin;
const NOTIFY_ICON = 'icons/icon128.png';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function idleState() {
  return {
    status: RUN_STATUS.IDLE,
    runId: null,
    tabId: null,
    armedAt: null,
    message: '',
    purchaseLock: null,
    events: [],
    updatedAt: Date.now(),
  };
}

async function loadConfig() {
  const { [STORAGE_KEYS.CONFIG]: raw } = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  return raw ? RoBought.config.validate(raw) : null;
}

async function readRunState() {
  const { [STORAGE_KEYS.RUN_STATE]: s } = await chrome.storage.local.get(STORAGE_KEYS.RUN_STATE);
  return s && typeof s === 'object' ? { ...idleState(), ...s } : idleState();
}

// Serialised read-modify-write so concurrent messages can never interleave state writes.
let stateQueue = Promise.resolve();
function mutateRunState(mutator) {
  const task = stateQueue.then(async () => {
    const current = await readRunState();
    const next = await mutator(structuredClone(current));
    if (!next) return current; // mutator declined to change anything
    next.updatedAt = Date.now();
    if (next.events.length > EVENT_LOG_MAX) next.events = next.events.slice(-EVENT_LOG_MAX);
    await chrome.storage.local.set({ [STORAGE_KEYS.RUN_STATE]: next });
    return next;
  });
  stateQueue = task.catch(() => {});
  return task;
}

function pushEvent(state, level, text) {
  state.events.push({ t: Date.now(), level, text: String(text).slice(0, 300) });
}

// ---------------------------------------------------------------------------
// Side effects derived from state: badge + keep-awake
// ---------------------------------------------------------------------------

const BADGES = {
  [RUN_STATUS.ARMED]: ['ON', '#166552'],
  [RUN_STATUS.WAITING]: ['ON', '#166552'],
  [RUN_STATUS.WATCHING]: ['ON', '#166552'],
  [RUN_STATUS.EXECUTING]: ['GO', '#b45309'],
  [RUN_STATUS.PAUSED]: ['!', '#b91c1c'],
  [RUN_STATUS.AWAITING_USER]: ['!', '#b45309'],
  [RUN_STATUS.COMPLETED]: ['✓', '#166552'],
  [RUN_STATUS.ABORTED]: ['×', '#6b7280'],
  [RUN_STATUS.ERROR]: ['×', '#b91c1c'],
};

async function applySideEffects(state) {
  const [text, color] = BADGES[state.status] || ['', '#000000'];
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });

  // Keep the display awake only while a run is active (the extension can't run while asleep).
  if (ACTIVE_STATUSES.includes(state.status)) chrome.power.requestKeepAwake('display');
  else chrome.power.releaseKeepAwake();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.RUN_STATE]?.newValue) {
    applySideEffects(changes[STORAGE_KEYS.RUN_STATE].newValue).catch(logError);
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function notify(id, title, message, requireInteraction = false) {
  return chrome.notifications.create(`robought-${id}`, {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title,
    message,
    priority: 2,
    requireInteraction,
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('robought-')) return;
  chrome.notifications.clear(notificationId);
  const state = await readRunState();
  if (state.tabId != null) await focusTab(state.tabId).catch(() => {});
});

// ---------------------------------------------------------------------------
// Content-script registration (only for the configured retailer origin)
// ---------------------------------------------------------------------------

async function syncContentScripts() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });

  const result = await loadConfig();
  if (!result?.ok) return { registered: false, reason: 'No valid configuration saved yet.' };
  const pattern = RoBought.url.originPattern(result.config.productUrl);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { registered: false, reason: 'Site access for the retailer has not been granted.' };
  }
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: [pattern],
    js: [...CONTENT_SCRIPT_FILES],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  }]);
  return { registered: true, pattern };
}

// ---------------------------------------------------------------------------
// Tab helpers (no "tabs" permission: host permission for the retailer is enough)
// ---------------------------------------------------------------------------

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

async function openRetailerTab(productUrl) {
  const pattern = RoBought.url.originPattern(productUrl);
  const tabs = await chrome.tabs.query({ url: pattern });
  const reuse = tabs.find((t) => t.url === productUrl) || tabs[0];
  let tab;
  if (reuse) {
    // Navigate (= reload) so the freshly registered content script is injected.
    tab = await chrome.tabs.update(reuse.id, { url: productUrl, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    tab = await chrome.tabs.create({ url: productUrl, active: true });
  }
  // Stop Memory Saver from discarding the tab mid-run.
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

function releaseTab(tabId) {
  // Hand the tab back to Memory Saver. Ignore failures: the tab may already be closed.
  if (tabId != null) chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
}

async function activeTabTicketReason() {
  // With activeTab (granted by the popup click), the active tab's URL is visible.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.url ? RoBought.ticketGuard.checkUrl(tab.url) : null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function getStatus() {
  const [state, cfg] = await Promise.all([readRunState(), loadConfig()]);
  return {
    ok: true,
    state,
    config: cfg?.config ?? null,
    configValid: !!cfg?.ok,
    configErrors: cfg?.errors ?? [],
  };
}

async function arm() {
  const ticketHere = await activeTabTicketReason();
  if (ticketHere) return { ok: false, error: `Ro-Bought is disabled on ticket sites. ${ticketHere}` };

  const cfg = await loadConfig();
  if (!cfg) return { ok: false, error: 'Configure a product in the options first.' };
  if (!cfg.ok) return { ok: false, error: cfg.errors[0].message };
  const problems = RoBought.config.armProblems(cfg.config);
  if (problems.length) return { ok: false, error: problems[0] };

  const reg = await syncContentScripts();
  if (!reg.registered) return { ok: false, error: reg.reason };

  let refusal = null;
  const state = await mutateRunState((s) => {
    if (TERMINAL_STATUSES.includes(s.status)) {
      refusal = 'The last run has finished. Click "Reset for a new run" first.';
      return null;
    }
    if (ACTIVE_STATUSES.includes(s.status)) {
      refusal = 'Already armed.';
      return null;
    }
    const next = idleState();
    next.events = s.events;
    next.status = RUN_STATUS.ARMED;
    next.runId = crypto.randomUUID();
    next.armedAt = Date.now();
    next.message = cfg.config.triggerMode === 'scheduled'
      ? `Armed for the drop at ${new Date(cfg.config.dropTime).toLocaleString()}.`
      : 'Armed — watching for a restock.';
    pushEvent(next, 'info', next.message);
    return next;
  });
  if (refusal) return { ok: false, error: refusal };

  try {
    const tab = await openRetailerTab(cfg.config.productUrl);
    await mutateRunState((s) => (s.runId === state.runId ? { ...s, tabId: tab.id } : null));
  } catch (e) {
    await disarm('Could not open the retailer tab.');
    return { ok: false, error: `Could not open the retailer tab: ${e.message}` };
  }

  notify('armed', 'Ro-Bought is armed',
    'Leave Chrome open and the retailer tab in the foreground. Your computer must stay awake.');
  return { ok: true };
}

async function disarm(reason = 'Disarmed by you.') {
  let disarmed = false;
  const state = await mutateRunState((s) => {
    if (!ACTIVE_STATUSES.includes(s.status)) return null;
    s.status = RUN_STATUS.IDLE;
    s.message = reason;
    pushEvent(s, 'info', reason);
    disarmed = true;
    return s;
  });
  if (disarmed) releaseTab(state.tabId);
  return { ok: true };
}

async function reset() {
  let refusal = null;
  await mutateRunState((s) => {
    if (ACTIVE_STATUSES.includes(s.status)) {
      refusal = 'Disarm before resetting.';
      return null;
    }
    const next = idleState();
    next.events = s.events;
    pushEvent(next, 'info', 'Reset — ready for a new run.');
    return next;
  });
  return refusal ? { ok: false, error: refusal } : { ok: true };
}

async function abortRun(reason) {
  let aborted = false;
  const state = await mutateRunState((s) => {
    if (!ACTIVE_STATUSES.includes(s.status)) return null;
    s.status = RUN_STATUS.ABORTED;
    s.message = reason;
    pushEvent(s, 'error', reason);
    aborted = true;
    return s;
  });
  if (!aborted) return;
  releaseTab(state.tabId);
  notify('aborted', 'Ro-Bought stopped', reason, true);
}

async function onContentHello(msg, sender) {
  const ticketReason = typeof msg.ticketReason === 'string' ? msg.ticketReason.slice(0, 200) : null;
  if (ticketReason) {
    await abortRun(`${ticketReason} Event tickets are not supported — the run was stopped.`);
    return { ok: true };
  }
  await mutateRunState((s) => {
    if (!ACTIVE_STATUSES.includes(s.status)) return null;
    if (s.tabId !== sender.tab.id) s.tabId = sender.tab.id;
    pushEvent(s, 'info', 'Retailer tab connected.');
    return s;
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messaging — every message is checked against who is allowed to send it
// ---------------------------------------------------------------------------

function isExtensionPage(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.origin) return sender.origin === EXTENSION_ORIGIN;
  return typeof sender.url === 'string' && sender.url.startsWith(`${EXTENSION_ORIGIN}/`);
}

async function isRetailerContent(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !sender.url) return false;
  const cfg = await loadConfig();
  return !!cfg?.ok && RoBought.url.sameHost(sender.url, cfg.config.productUrl);
}

const PAGE_HANDLERS = {
  [MESSAGES.GET_STATUS]: () => getStatus(),
  [MESSAGES.ARM]: () => arm(),
  [MESSAGES.DISARM]: () => disarm(),
  [MESSAGES.RESET]: () => reset(),
  [MESSAGES.CONFIG_SAVED]: async () => ({ ok: true, ...(await syncContentScripts()) }),
};

const CONTENT_HANDLERS = {
  [MESSAGES.CONTENT_HELLO]: (msg, sender) => onContentHello(msg, sender),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const run = async () => {
    if (isExtensionPage(sender) && Object.hasOwn(PAGE_HANDLERS, msg.type)) {
      return PAGE_HANDLERS[msg.type](msg, sender);
    }
    if (Object.hasOwn(CONTENT_HANDLERS, msg.type) && (await isRetailerContent(sender))) {
      return CONTENT_HANDLERS[msg.type](msg, sender);
    }
    return { ok: false, error: 'Message not allowed.' };
  };

  run().then(sendResponse, (e) => {
    logError(e);
    sendResponse({ ok: false, error: 'Internal error — see the service worker console.' });
  });
  return true; // async response
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function logError(e) {
  console.error('[Ro-Bought]', e);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await syncContentScripts().catch(logError);
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  // Chrome was closed, so any active run was interrupted. Never resume silently.
  await mutateRunState((s) => {
    if (!ACTIVE_STATUSES.includes(s.status)) return null;
    s.status = RUN_STATUS.IDLE;
    s.message = 'Chrome was restarted, so the run was disarmed. Re-arm when ready.';
    pushEvent(s, 'warn', s.message);
    return s;
  }).catch(logError);
  await syncContentScripts().catch(logError);
});

// If the user revokes site access, the bot can no longer run there: stop cleanly.
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  const cfg = await loadConfig();
  if (!cfg?.ok) return;
  const pattern = RoBought.url.originPattern(cfg.config.productUrl);
  if (!origins.includes(pattern)) return;
  await syncContentScripts().catch(logError);
  await disarm('Site access for the retailer was removed.');
});

// Re-apply badge/keep-awake each time the worker wakes up.
readRunState().then(applySideEffects).catch(logError);
