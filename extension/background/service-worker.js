// Ro-Bought service worker — the coordinator.
// It is the ONLY writer of runState, owns arm/disarm/pause/resume, the once-only lock,
// notifications, content-script registration, the watchdog and keep-awake. It never holds
// precise timers: Chrome may stop it after ~30 s idle, so everything it needs is re-derived
// from storage on wake.
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
  CONTENT_SCRIPT_ID, CONTENT_SCRIPT_FILES, EVENT_LOG_MAX, WATCHDOG_ALARM, PREWARN_ALARM,
  PREWARN_MINUTES, STALE_AFTER_MS, HIDDEN_NOTICE_COOLDOWN_MS, STALE_NOTICE_COOLDOWN_MS,
  CONTENT_GUARD_KINDS, PAUSE_HINTS, WATCH_RESULTS, CHECKOUT,
} = RoBought.constants;

const EXTENSION_ORIGIN = self.location.origin;
// Absolute URL: a relative path would resolve against /background/ and fail to load.
const NOTIFY_ICON = chrome.runtime.getURL('icons/icon128.png');

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function idleState() {
  return {
    status: RUN_STATUS.IDLE,
    runId: null,
    tabId: null,
    armedAt: null,
    activeSince: null,  // last arm/resume — the watchdog's baseline for "heard from the tab"
    message: '',
    pause: null,        // { kind, label, signature, at, cleared, from }
    ackSignature: null, // a guard the user chose to "Resume anyway" past
    firedAt: null,      // scheduled drop: when the retailer tab fired
    burstUntil: null,   // scheduled drop: end of the fast-retry window
    checkout: null,     // { stage, visits: {stage: n}, startedAt, ready, cartPassed }
    preflight: null,    // 'pending' | 'done' — the cart check made once per run, at arm
    purchaseLock: null, // { at, total } — set at most once per run, the moment before "Place order"
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

/** The settings the retailer tab needs for triggers and checkout (already validated). */
function runConfigOf(config) {
  const {
    productUrl, retailer, triggerMode, dropTime, fireOffsetMs, restockIntervalSec,
    jitterPct, burstIntervalSec, burstWindowSec, maxTotalPrice, stopBeforePlaceOrder, selectors,
  } = config;
  return {
    productUrl, retailer, triggerMode, dropTime, fireOffsetMs, restockIntervalSec,
    jitterPct, burstIntervalSec, burstWindowSec, maxTotalPrice, stopBeforePlaceOrder, selectors,
  };
}

/** Where an active run sits when nothing special is happening. */
function baseActiveStatus(config, now = Date.now()) {
  return config.triggerMode === 'scheduled' && config.dropTime > now ? RUN_STATUS.WAITING : RUN_STATUS.WATCHING;
}

/** Watcher memory for the current run (session storage), or null if it's from another run. */
async function readWatch(runId) {
  const { [STORAGE_KEYS.WATCH]: watch } = await chrome.storage.session.get(STORAGE_KEYS.WATCH);
  return watch && runId && watch.runId === runId ? watch : null;
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
  const clean = String(text).slice(0, 300);
  const last = state.events[state.events.length - 1];
  if (last && last.text === clean && last.level === level) {
    last.t = Date.now(); // collapse repeats instead of flooding the log
    return;
  }
  state.events.push({ t: Date.now(), level, text: clean });
}

// ---------------------------------------------------------------------------
// Side effects derived from state: badge, keep-awake, watchdog alarm
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

  if (ACTIVE_STATUSES.includes(state.status)) {
    // Keep the display awake only while a run is active (the extension can't run while asleep).
    chrome.power.requestKeepAwake('display');
    if (!(await chrome.alarms.get(WATCHDOG_ALARM))) {
      await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
    }
  } else {
    chrome.power.releaseKeepAwake();
    await chrome.alarms.clear(WATCHDOG_ALARM);
    await chrome.alarms.clear(PREWARN_ALARM);
  }
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
  return chrome.notifications
    .create(`robought-${id}`, {
      type: 'basic',
      iconUrl: NOTIFY_ICON,
      title,
      message,
      priority: 2,
      requireInteraction,
    })
    .catch(logError);
}

function clearNotification(id) {
  return chrome.notifications.clear(`robought-${id}`).catch(() => {});
}

/** Notify at most once per `cooldownMs` for a given key (tracked in session storage). */
async function noticeWithCooldown(key, cooldownMs, title, message) {
  const { [STORAGE_KEYS.NOTICES]: notices = {} } = await chrome.storage.session.get(STORAGE_KEYS.NOTICES);
  const now = Date.now();
  if (notices[key] && now - notices[key] < cooldownMs) return;
  notices[key] = now;
  await chrome.storage.session.set({ [STORAGE_KEYS.NOTICES]: notices });
  await notify(key, title, message);
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('robought-')) return;
  chrome.notifications.clear(notificationId);
  const state = await readRunState();
  if (state.tabId != null) await focusTab(state.tabId).catch(() => {});
});

// ---------------------------------------------------------------------------
// Content-script registration (only for the configured retailer site)
// ---------------------------------------------------------------------------

// Serialised: get -> unregister -> register is not atomic, and install, options-save, arm
// and permission changes can all trigger a sync at the same moment.
let scriptSyncQueue = Promise.resolve();
function syncContentScripts() {
  const task = scriptSyncQueue.then(syncContentScriptsNow);
  scriptSyncQueue = task.catch(() => {});
  return task;
}

async function syncContentScriptsNow() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });

  const result = await loadConfig();
  if (!result?.ok) return { registered: false, reason: 'No valid configuration saved yet.' };
  const patterns = RoBought.url.scopePatterns(result.config.productUrl);
  if (!(await chrome.permissions.contains({ origins: patterns }))) {
    return { registered: false, reason: 'Site access for the retailer has not been granted.' };
  }
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: patterns,
    js: [...CONTENT_SCRIPT_FILES],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  }]);
  return { registered: true, patterns };
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
  const tabs = await chrome.tabs.query({ url: RoBought.url.scopePatterns(productUrl) });
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

async function recordPresence(tabId, visible) {
  await chrome.storage.session.set({ [STORAGE_KEYS.PRESENCE]: { tabId, at: Date.now(), visible } });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function getStatus() {
  const [state, cfg] = await Promise.all([readRunState(), loadConfig()]);
  return {
    ok: true,
    state,
    watch: await readWatch(state.runId),
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
    next.status = baseActiveStatus(cfg.config);
    next.preflight = 'pending'; // the retailer tab checks the cart once (see onPreflight)
    next.runId = crypto.randomUUID();
    next.armedAt = Date.now();
    next.activeSince = next.armedAt;
    next.message = cfg.config.triggerMode === 'scheduled'
      ? `Armed for the drop at ${new Date(cfg.config.dropTime).toLocaleString()}.`
      : 'Armed — watching for a restock.';
    pushEvent(next, 'info', next.message);
    return next;
  });
  if (refusal) return { ok: false, error: refusal };

  await chrome.storage.session.remove(STORAGE_KEYS.WATCH);
  const prewarnAt = cfg.config.dropTime - PREWARN_MINUTES * 60_000;
  if (cfg.config.triggerMode === 'scheduled' && prewarnAt > Date.now() + 5_000) {
    await chrome.alarms.create(PREWARN_ALARM, { when: prewarnAt });
  }

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
    if (s.purchaseLock) {
      // "Place order" was clicked this run: the order may exist. End the run for good, so a
      // new one needs an explicit Reset (after the user has checked their orders).
      s.status = RUN_STATUS.ABORTED;
      s.message = `${reason} Ro-Bought had already clicked "Place order": check your orders before starting a new run.`;
    } else {
      s.status = RUN_STATUS.IDLE;
      s.message = reason;
    }
    s.pause = null;
    pushEvent(s, 'info', s.message);
    disarmed = true;
    return s;
  });
  if (disarmed) {
    releaseTab(state.tabId);
    clearNotification('paused');
  }
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
    s.pause = null;
    pushEvent(s, 'error', reason);
    aborted = true;
    return s;
  });
  if (!aborted) return;
  releaseTab(state.tabId);
  clearNotification('paused');
  notify('aborted', 'Ro-Bought stopped', reason, true);
}

// ---------------------------------------------------------------------------
// Pause / resume — the bot hands control back to the human
// ---------------------------------------------------------------------------

/**
 * Pause the active run because something needs a human.
 * @param {{kind: string, label: string, signature: string}} guard
 */
async function pauseRun(guard, { focus = true } = {}) {
  let paused = false;
  const state = await mutateRunState((s) => {
    if (!ACTIVE_STATUSES.includes(s.status)) return null;
    if (s.status === RUN_STATUS.AWAITING_USER) return null; // the user is already in control
    if (s.ackSignature && s.ackSignature === guard.signature) return null; // user chose to continue past this
    if (s.status === RUN_STATUS.PAUSED && s.pause?.signature === guard.signature && !s.pause.cleared) return null;
    const from = s.status === RUN_STATUS.PAUSED ? s.pause?.from : s.status;
    s.status = RUN_STATUS.PAUSED;
    s.pause = { ...guard, at: Date.now(), cleared: false, from: from || null };
    s.message = `Paused: ${guard.label}.`;
    pushEvent(s, 'warn', s.message);
    paused = true;
    return s;
  });
  if (!paused) return { ok: true, ignored: true };

  notify('paused', 'Ro-Bought paused — your turn', `${guard.label}. ${PAUSE_HINTS[guard.kind] || ''}`, true);
  if (focus && state.tabId != null && guard.kind !== 'tab_closed') {
    focusTab(state.tabId).catch(() => {});
  }
  return { ok: true };
}

/** The thing that caused the pause is gone; the user still decides when to resume. */
async function markPauseCleared() {
  let cleared = false;
  await mutateRunState((s) => {
    if (s.status !== RUN_STATUS.PAUSED || !s.pause || s.pause.cleared) return null;
    // Only on-page checks and leaving the site can "clear". A stalled checkout step or a closed
    // tab stays paused until the user acts.
    if (!CONTENT_GUARD_KINDS.includes(s.pause.kind) && s.pause.kind !== 'offsite') return null;
    s.pause.cleared = true;
    s.message = 'It looks clear now. Click Resume when you are ready.';
    pushEvent(s, 'info', `Cleared: ${s.pause.label}.`);
    cleared = true;
    return s;
  });
  if (cleared) notify('paused', 'Ro-Bought: looks clear', 'Click Resume when you are ready.', true);
}

async function resume() {
  const cfg = await loadConfig();
  let refusal = null;
  let pause = null;
  const state = await mutateRunState((s) => {
    if (s.status !== RUN_STATUS.PAUSED) {
      refusal = 'Nothing to resume.';
      return null;
    }
    pause = s.pause || { kind: 'unknown' };
    const from = pause.from;
    const fallback = cfg?.ok ? baseActiveStatus(cfg.config) : RUN_STATUS.WATCHING;
    const resumable = from && ACTIVE_STATUSES.includes(from) && from !== RUN_STATUS.PAUSED && from !== RUN_STATUS.ARMED;
    s.status = resumable ? from : fallback;
    // "Resume anyway" past an on-page check: remember it so the same check on the same
    // page doesn't immediately re-pause. Tab-level pauses are one-off events, never acked.
    if (!pause.cleared && CONTENT_GUARD_KINDS.includes(pause.kind)) s.ackSignature = pause.signature;
    if (s.status === RUN_STATUS.EXECUTING && s.checkout) {
      // The user fixed something: give the checkout a fresh set of attempts and time.
      s.checkout.visits = {};
      s.checkout.startedAt = Date.now();
    }
    s.pause = null;
    s.activeSince = Date.now();
    s.message = 'Resumed.';
    pushEvent(s, 'info', pause.cleared ? 'Resumed.' : `Resumed anyway past: ${pause.label}.`);
    return s;
  });
  if (refusal) return { ok: false, error: refusal };
  clearNotification('paused');

  if (pause.kind === 'tab_closed' || pause.kind === 'discarded') {
    try {
      await reopenRunTab(state);
    } catch (e) {
      await pauseRun({ kind: 'tab_closed', label: 'The retailer tab could not be reopened', signature: 'tab_closed' });
      return { ok: false, error: `Could not reopen the retailer tab: ${e.message}` };
    }
  }
  return { ok: true };
}

async function reopenRunTab(state) {
  const existing = state.tabId != null ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
  if (existing) {
    await chrome.tabs.reload(existing.id);
    await focusTab(existing.id);
    return;
  }
  const cfg = await loadConfig();
  if (!cfg?.ok) throw new Error('The saved configuration is no longer valid.');
  const tab = await openRetailerTab(cfg.config.productUrl);
  await mutateRunState((s) => (s.runId === state.runId ? { ...s, tabId: tab.id } : null));
}

// ---------------------------------------------------------------------------
// Messages from the retailer tab
// ---------------------------------------------------------------------------

/** Returns the run state if `sender` is the run's tab, else null. */
async function runStateForSender(sender) {
  const s = await readRunState();
  return s.tabId != null && s.tabId === sender.tab.id ? s : null;
}

async function onContentHello(msg, sender) {
  const tabId = sender.tab.id;
  const cfg = await loadConfig();
  // Every tab on the site gets the settings (so it can take over if it becomes the run tab
  // later); only the run tab gets the watcher memory.
  const reply = { ok: true, tabId, config: cfg?.ok ? runConfigOf(cfg.config) : null, watch: null };
  const state = await runStateForSender(sender);
  if (!state) return reply; // another tab on the same site — stays dormant

  await recordPresence(tabId, msg.visible !== false);
  const ticketReason = typeof msg.ticketReason === 'string' ? msg.ticketReason.slice(0, 200) : null;
  if (ticketReason) {
    await abortRun(`${ticketReason} Event tickets are not supported — the run was stopped.`);
    return reply;
  }
  await mutateRunState((s) => {
    if (!ACTIVE_STATUSES.includes(s.status) || s.tabId !== tabId) return null;
    pushEvent(s, 'info', 'Retailer tab connected.');
    return s;
  });
  reply.watch = await readWatch(state.runId);
  reply.runTab = true;
  return reply;
}

// ---------------------------------------------------------------------------
// Triggers: watcher reports, drop firing, availability
// ---------------------------------------------------------------------------

const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** Whitelists and bounds the watcher memory reported by the retailer tab. */
function sanitizeWatch(w, runId) {
  if (!w || typeof w !== 'object') return null;
  const clock = w.clock && typeof w.clock === 'object'
    ? {
      offsetMs: finiteOr(w.clock.offsetMs, 0),
      lowMs: finiteOr(w.clock.lowMs, null),
      highMs: finiteOr(w.clock.highMs, null),
      samples: finiteOr(w.clock.samples, 0),
      consistent: w.clock.consistent === true,
    }
    : null;
  return {
    runId,
    method: w.method === 'reload' ? 'reload' : 'fetch',
    backoffLevel: Math.max(0, Math.min(10, finiteOr(w.backoffLevel, 0))),
    backoffUntil: finiteOr(w.backoffUntil, 0),
    unknownStreak: Math.max(0, finiteOr(w.unknownStreak, 0)),
    clockOffsetMs: Number.isFinite(w.clockOffsetMs) ? w.clockOffsetMs : null,
    clock,
    checks: Math.max(0, finiteOr(w.checks, 0)),
    lastCheckAt: finiteOr(w.lastCheckAt, 0),
    nextCheckAt: finiteOr(w.nextCheckAt, 0),
    lastResult: WATCH_RESULTS.includes(w.lastResult) ? w.lastResult : null,
    lastDetail: cleanText(w.lastDetail, 200),
    lastPrice: Number.isFinite(w.lastPrice) ? w.lastPrice : null,
    confirming: w.confirming === true,
    firedAt: finiteOr(w.firedAt, 0),
  };
}

async function onWatchReport(msg, sender) {
  const state = await runStateForSender(sender);
  if (!state || !ACTIVE_STATUSES.includes(state.status)) return { ok: false, error: 'Not the active run tab.' };
  const watch = sanitizeWatch(msg.watch, state.runId);
  if (watch) await chrome.storage.session.set({ [STORAGE_KEYS.WATCH]: watch });

  const ev = msg.event;
  if (ev && typeof ev === 'object' && typeof ev.text === 'string') {
    const level = ev.level === 'warn' ? 'warn' : 'info';
    await mutateRunState((s) => {
      if (s.runId !== state.runId) return null;
      pushEvent(s, level, cleanText(ev.text, 200));
      return s;
    });
  }
  if (msg.unreadable === true) {
    await noticeWithCooldown(`unreadable-${state.runId}`, Infinity, "Ro-Bought can't read this page's stock",
      "It can't tell whether the product is in stock, so it may miss the restock. Keep an eye on the tab yourself.");
  }
  return { ok: true };
}

async function onDropFired(msg, sender) {
  const cfg = await loadConfig();
  if (!cfg?.ok) return { ok: false, error: 'No valid configuration.' };
  const state = await runStateForSender(sender);
  if (!state) return { ok: false, error: 'Not the run tab.' };
  let fired = false;
  await mutateRunState((s) => {
    if (s.status !== RUN_STATUS.WAITING || s.runId !== state.runId) return null;
    // Sanity: the tab's clock correction is bounded, so a fire far before the drop is a bug.
    if (Date.now() < cfg.config.dropTime - 11 * 60_000) return null;
    const { burstIntervalSec, burstWindowSec } = cfg.config;
    s.status = RUN_STATUS.WATCHING;
    s.firedAt = Date.now();
    s.burstUntil = s.firedAt + burstWindowSec * 1000;
    s.message = `Drop time! Checking every ~${burstIntervalSec}s for ${burstWindowSec}s, then every ~${cfg.config.restockIntervalSec}s.`;
    const offset = finiteOr(msg.clockOffsetMs, 0);
    const shown = Math.abs(offset) >= 500 ? ` (store clock ${offset > 0 ? '+' : ''}${(offset / 1000).toFixed(1)}s)` : '';
    pushEvent(s, 'info', `Fired for the drop${shown}.`);
    fired = true;
    return s;
  });
  return fired ? { ok: true } : { ok: false, error: 'Not waiting for a drop.' };
}

async function onAvailable(msg, sender) {
  const state = await runStateForSender(sender);
  if (!state) return { ok: false, error: 'Not the run tab.' };
  const detail = cleanText(msg.detail || 'The product can be bought', 200);
  const price = Number.isFinite(msg.price) ? msg.price : null;
  let started = false;
  const next = await mutateRunState((s) => {
    if (s.runId !== state.runId) return null;
    if (s.status !== RUN_STATUS.WATCHING && s.status !== RUN_STATUS.WAITING) return null;
    s.status = RUN_STATUS.EXECUTING;
    s.checkout = { stage: null, visits: {}, startedAt: Date.now(), ready: false };
    s.message = `In stock — buying now (${detail}${price !== null ? `, ${price.toFixed(2)}` : ''}).`;
    pushEvent(s, 'info', `In stock: ${detail}.`);
    started = true;
    return s;
  });
  if (!started) return { ok: false, error: 'Not watching.' };
  notify('available', 'In stock — Ro-Bought is checking out', 'Watch the retailer tab. Ro-Bought will hand over if it needs you.');
  if (next.tabId != null) focusTab(next.tabId).catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Checkout: progress, hand-offs, the once-only purchase lock, completion
// ---------------------------------------------------------------------------

const CHECKOUT_STAGES = ['product', 'cart', 'checkout', 'review', 'placing'];
const STAGE_MESSAGES = {
  product: 'Buying: adding it to the cart…',
  cart: 'Buying: checking the cart…',
  checkout: 'Buying: going through checkout…',
  review: 'Buying: final review…',
};

async function onCheckoutProgress(msg, sender) {
  const state = await runStateForSender(sender);
  if (!state) return { ok: false, error: 'Not the run tab.' };
  const stage = CHECKOUT_STAGES.includes(msg.stage) ? msg.stage : null;
  if (!stage) return { ok: false, error: 'Unknown checkout stage.' };
  let reply = { ok: true };
  await mutateRunState((s) => {
    if (s.runId !== state.runId || s.status !== RUN_STATUS.EXECUTING) {
      reply = { ok: false, error: 'Not checking out.' };
      return null;
    }
    const c = s.checkout || { stage: null, visits: {}, startedAt: Date.now(), ready: false };
    if (msg.soldOut === true && stage === 'product' && !s.purchaseLock) {
      s.status = RUN_STATUS.WATCHING;
      s.checkout = null;
      s.message = 'It sold out again before Ro-Bought could add it. Watching again.';
      pushEvent(s, 'warn', s.message);
      reply = { ok: false, rewatch: true };
      return s;
    }
    if (Date.now() - c.startedAt > CHECKOUT.TIMEOUT_MS) {
      reply = { ok: false, error: 'The checkout is taking too long' };
      return null;
    }
    if (msg.entered !== false) {
      c.visits[stage] = (c.visits[stage] || 0) + 1;
      if (c.visits[stage] > CHECKOUT.STAGE_MAX_VISITS) {
        reply = { ok: false, error: `Ro-Bought keeps landing on the ${stage} page` };
        return null;
      }
    }
    c.stage = stage;
    if (stage === 'cart' && msg.cartPassed === true) c.cartPassed = true; // survives Resume
    s.checkout = c;
    s.message = STAGE_MESSAGES[stage] || s.message;
    const note = typeof msg.note === 'string' ? cleanText(msg.note, 120) : '';
    pushEvent(s, 'info', note ? `Checkout (${stage}): ${note}` : `Checkout: ${stage} page.`);
    return s;
  });
  return reply;
}

async function onCheckoutHandoff(msg, sender) {
  const state = await runStateForSender(sender);
  if (!state) return { ok: false, error: 'Not the run tab.' };
  const reason = cleanText(msg.reason || 'Ro-Bought needs you to take over', 220);
  const stage = cleanText(msg.stage || 'checkout', 20);

  if (msg.mode === 'pause') {
    if (state.status !== RUN_STATUS.EXECUTING) return { ok: false, error: 'Not checking out.' };
    return pauseRun({ kind: 'checkout', label: reason, signature: `checkout:${stage}:${cleanText(msg.path, 200)}` });
  }

  let handedOff = false;
  const ready = msg.ready === true;
  const next = await mutateRunState((s) => {
    if (s.runId !== state.runId || s.status !== RUN_STATUS.EXECUTING) return null;
    s.status = RUN_STATUS.AWAITING_USER;
    s.checkout = { ...(s.checkout || { visits: {}, startedAt: Date.now() }), stage, ready };
    s.message = `${reason}.`;
    pushEvent(s, ready ? 'info' : 'warn', s.message);
    handedOff = true;
    return s;
  });
  if (!handedOff) return { ok: false, error: 'Not checking out.' };
  notify('handoff', ready ? 'Ready — your click' : 'Ro-Bought: your turn', next.message, true);
  if (next.tabId != null) focusTab(next.tabId).catch(() => {});
  return { ok: true };
}

/**
 * The once-only purchase lock. Granted at most once per run, and only when automatic purchase
 * is on and the reported total is within the max price. Persisted before the click happens, so
 * no reload, crash or restart can lead to a second "Place order".
 */
async function onClaimPurchase(msg, sender) {
  const cfg = await loadConfig();
  const state = await runStateForSender(sender);
  if (!state || !cfg?.ok) return { ok: false, error: 'Not the run tab.' };
  const total = Number.isFinite(msg.total) ? msg.total : null;
  let reply = { ok: false, error: 'Not checking out' };
  await mutateRunState((s) => {
    if (s.runId !== state.runId || s.status !== RUN_STATUS.EXECUTING) return null;
    if (s.purchaseLock) {
      reply = { ok: false, error: 'Ro-Bought already clicked "Place order" once in this run, so it will not click again' };
      return null;
    }
    if (cfg.config.stopBeforePlaceOrder) {
      reply = { ok: false, error: 'Automatic purchase is off, so Ro-Bought stopped one click short' };
      return null;
    }
    if (!s.checkout?.cartPassed) {
      reply = { ok: false, error: 'Ro-Bought only places an order after it has checked the cart, so it did not click this' };
      return null;
    }
    const max = cfg.config.maxTotalPrice;
    if (max === null || total === null || total > max) {
      reply = { ok: false, error: `The order total (${total ?? 'unknown'}) is not within your max (${max ?? 'not set'}), so Ro-Bought did not place the order` };
      return null;
    }
    s.purchaseLock = { at: Date.now(), total };
    s.checkout = { ...(s.checkout || { visits: {}, startedAt: Date.now() }), stage: 'placing' };
    s.message = `Placing the order (total ${total.toFixed(2)})…`;
    pushEvent(s, 'info', s.message);
    reply = { ok: true };
    return s;
  });
  return reply;
}

async function onOrderPlaced(msg, sender) {
  const state = await runStateForSender(sender);
  if (!state) return { ok: false, error: 'Not the run tab.' };
  let completed = false;
  const next = await mutateRunState((s) => {
    if (s.runId !== state.runId || !s.checkout) return null;
    const byBot = s.status === RUN_STATUS.EXECUTING && !!s.purchaseLock;
    const byUser = s.status === RUN_STATUS.AWAITING_USER || s.status === RUN_STATUS.PAUSED;
    if (!byBot && !byUser) return null;
    s.status = RUN_STATUS.COMPLETED;
    s.pause = null;
    s.message = byBot && s.purchaseLock.total !== null
      ? `Order placed (total ${s.purchaseLock.total.toFixed(2)}). Check your email for the store's confirmation.`
      : "Order placed. Check your email for the store's confirmation.";
    pushEvent(s, 'info', s.message);
    completed = true;
    return s;
  });
  if (!completed) return { ok: false, error: 'No purchase in progress.' };
  releaseTab(next.tabId);
  clearNotification('handoff');
  clearNotification('paused');
  notify('completed', 'Order placed!', next.message, true);
  return { ok: true };
}

/**
 * Cart check at arm time: the retailer tab reads the cart once in the background. If other items
 * are in it, say so now, while there's time to empty it, rather than pausing during the drop.
 */
async function onPreflight(msg, sender) {
  const state = await runStateForSender(sender);
  if (!state) return { ok: false, error: 'Not the run tab.' };
  const items = Number.isInteger(msg.items) && msg.items >= 0 ? msg.items : null;
  let warn = false;
  await mutateRunState((s) => {
    if (s.runId !== state.runId || s.preflight !== 'pending') return null;
    s.preflight = 'done';
    if (items !== null && items > 0) {
      warn = true;
      pushEvent(s, 'warn', `Your cart already has ${items} item${items === 1 ? '' : 's'}. Ro-Bought buys only this product and will pause at the cart until it's empty.`);
    } else {
      pushEvent(s, 'info', items === 0 ? 'Cart checked: empty.' : "Couldn't read the cart ahead of time; it will be checked during checkout.");
    }
    return s;
  });
  if (warn) {
    notify('preflight', 'Empty your cart before the drop',
      `Your cart has ${items} item${items === 1 ? '' : 's'}. Ro-Bought buys only this product, so it would pause at the cart. Remove them (on Amazon, "Save for later" works) now.`, true);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Teach mode: remember the buttons the user points at
// ---------------------------------------------------------------------------

async function teachOpen() {
  const s = await readRunState();
  if (ACTIVE_STATUSES.includes(s.status)) return { ok: false, error: 'Disarm before teaching buttons.' };
  const cfg = await loadConfig();
  if (!cfg?.ok) return { ok: false, error: 'Save a product in the options first.' };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const host = RoBought.url.baseHost(new URL(cfg.config.productUrl).hostname);
  if (!tab?.url || !RoBought.url.inScope(tab.url, cfg.config.productUrl)) {
    return { ok: false, error: `Open ${host} in this tab first, then click Teach buttons.` };
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: MESSAGES.TEACH_OPEN, config: runConfigOf(cfg.config) }, { frameId: 0 });
    return res && typeof res === 'object' ? res : { ok: false, error: 'Reload the store tab and try again.' };
  } catch {
    return { ok: false, error: "Reload the store tab and try again (Ro-Bought isn't running in it yet)." };
  }
}

async function saveSelectors(mutate) {
  const { [STORAGE_KEYS.CONFIG]: raw } = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  if (!raw) return { ok: false, error: 'Save a product in the options first.' };
  const selectors = RoBought.config.cleanSelectors(raw.selectors);
  const problem = mutate(selectors);
  if (problem) return { ok: false, error: problem };
  const result = RoBought.config.validate({ ...raw, selectors });
  if (!result.ok) return { ok: false, error: 'Fix the settings in the options first.' };
  await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: result.config });
  return { ok: true, selectors: result.config.selectors };
}

async function teachSave(msg) {
  const s = await readRunState();
  if (ACTIVE_STATUSES.includes(s.status)) return { ok: false, error: 'Disarm before teaching buttons.' };
  const field = RoBought.constants.TEACH_FIELDS.find((f) => f.id === msg.field);
  const entry = RoBought.config.cleanTaught({ selector: msg.selector, label: msg.label });
  if (!field || !entry) return { ok: false, error: 'That button could not be saved.' };
  return saveSelectors((sel) => {
    if (!field.multi) {
      sel[field.id] = entry;
      return null;
    }
    const list = sel[field.id].filter((e) => e.selector !== entry.selector || e.label !== entry.label);
    if (list.length >= RoBought.constants.MAX_CONTINUE_SELECTORS) {
      return `Up to ${RoBought.constants.MAX_CONTINUE_SELECTORS} continue buttons. Clear one in the options first.`;
    }
    sel[field.id] = [...list, entry];
    return null;
  });
}

async function teachClear(msg) {
  const s = await readRunState();
  if (ACTIVE_STATUSES.includes(s.status)) return { ok: false, error: 'Disarm before changing buttons.' };
  const field = RoBought.constants.TEACH_FIELDS.find((f) => f.id === msg.field);
  if (!field) return { ok: false, error: 'Unknown button.' };
  return saveSelectors((sel) => {
    if (field.multi && Number.isInteger(msg.index)) sel[field.id] = sel[field.id].filter((_, i) => i !== msg.index);
    else sel[field.id] = field.multi ? [] : null;
    return null;
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PREWARN_ALARM) prewarn().catch(logError);
});

async function prewarn() {
  const s = await readRunState();
  const waiting = s.status === RUN_STATUS.WAITING || (s.status === RUN_STATUS.PAUSED && s.pause?.from === RUN_STATUS.WAITING);
  if (!waiting) return;
  const { [STORAGE_KEYS.PRESENCE]: presence } = await chrome.storage.session.get(STORAGE_KEYS.PRESENCE);
  const quiet = !presence || presence.tabId !== s.tabId || Date.now() - presence.at > STALE_AFTER_MS;
  let message = 'Bring the retailer tab to the front and stay at your computer.';
  if (s.status === RUN_STATUS.PAUSED) message = `Ro-Bought is paused (${s.pause?.label}). Sort it out and click Resume now.`;
  else if (quiet) message = "Ro-Bought hasn't heard from the retailer tab recently. Reload the tab now.";
  notify('prewarn', `Drop in ${PREWARN_MINUTES} minutes`, message, true);
  if (s.tabId != null) focusTab(s.tabId).catch(() => {});
}

function sanitizeGuard(g) {
  if (!g || typeof g !== 'object' || !CONTENT_GUARD_KINDS.includes(g.kind)) return null;
  return {
    kind: g.kind,
    label: String(g.label || 'Something on the page needs you').slice(0, 160),
    signature: String(g.signature || g.kind).slice(0, 300),
  };
}

async function onGuardStatus(msg, sender) {
  if (!(await runStateForSender(sender))) return { ok: false, error: 'Not the run tab.' };
  if (msg.guard === null) {
    await markPauseCleared();
    return { ok: true };
  }
  const guard = sanitizeGuard(msg.guard);
  if (!guard) return { ok: false, error: 'Invalid guard report.' };
  return pauseRun(guard);
}

async function onPresence(msg, sender) {
  const state = await runStateForSender(sender);
  if (!state) return { ok: false, error: 'Not the run tab.' };
  const visible = msg.visible !== false;
  await recordPresence(sender.tab.id, visible);
  if (!ACTIVE_STATUSES.includes(state.status)) return { ok: true };
  if (visible) {
    clearNotification('hidden');
  } else if (state.status !== RUN_STATUS.PAUSED && state.status !== RUN_STATUS.AWAITING_USER) {
    await noticeWithCooldown('hidden', HIDDEN_NOTICE_COOLDOWN_MS, 'Keep the retailer tab in front',
      'Chrome slows down background tabs, so Ro-Bought may react late. Bring the retailer tab back to the foreground.');
  }
  return { ok: true };
}

async function contentResume(_msg, sender) {
  if (!(await runStateForSender(sender))) return { ok: false, error: 'Not the run tab.' };
  return resume();
}

async function contentDisarm(_msg, sender) {
  if (!(await runStateForSender(sender))) return { ok: false, error: 'Not the run tab.' };
  return disarm();
}

// ---------------------------------------------------------------------------
// Tab watching — detect the run tab closing, leaving the site, or being discarded
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  onRunTabRemoved(tabId).catch(logError);
});

async function onRunTabRemoved(tabId) {
  const s = await readRunState();
  if (!ACTIVE_STATUSES.includes(s.status) || s.tabId !== tabId) return;
  await pauseRun({ kind: 'tab_closed', label: 'The retailer tab was closed', signature: 'tab_closed' }, { focus: false });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Cheap filter first: only finished loads and discards matter.
  if (changeInfo.status !== 'complete' && changeInfo.discarded !== true) return;
  onRunTabUpdated(tabId, changeInfo, tab).catch(logError);
});

async function onRunTabUpdated(tabId, changeInfo, tab) {
  const s = await readRunState();
  if (!ACTIVE_STATUSES.includes(s.status) || s.tabId !== tabId) return;
  if (changeInfo.discarded) {
    await pauseRun({ kind: 'discarded', label: 'Chrome unloaded the retailer tab', signature: 'discarded' });
    return;
  }
  const cfg = await loadConfig();
  if (!cfg?.ok) return;
  // Without permission for the new site, tab.url is hidden from us — that alone means
  // the tab is no longer on the retailer (queue-it, accounts.nintendo.com, PayPal, ...).
  if (tab.url && RoBought.url.inScope(tab.url, cfg.config.productUrl)) return;
  const host = new URL(cfg.config.productUrl).hostname;
  await pauseRun({ kind: 'offsite', label: `The retailer tab left ${host}`, signature: 'offsite' });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) watchdog().catch(logError);
});

async function watchdog() {
  const s = await readRunState();
  if (!ACTIVE_STATUSES.includes(s.status)) {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }
  if (s.tabId == null) return;
  const tab = await chrome.tabs.get(s.tabId).catch(() => null);
  if (!tab) {
    await pauseRun({ kind: 'tab_closed', label: 'The retailer tab was closed', signature: 'tab_closed' }, { focus: false });
    return;
  }
  if (tab.discarded) {
    await pauseRun({ kind: 'discarded', label: 'Chrome unloaded the retailer tab', signature: 'discarded' });
    return;
  }
  if (s.status === RUN_STATUS.PAUSED || s.status === RUN_STATUS.AWAITING_USER) return; // a human is in charge

  const { [STORAGE_KEYS.PRESENCE]: presence } = await chrome.storage.session.get(STORAGE_KEYS.PRESENCE);
  const lastSeen = Math.max(presence?.tabId === s.tabId ? presence.at : 0, s.activeSince || 0);
  if (Date.now() - lastSeen > STALE_AFTER_MS) {
    await noticeWithCooldown('stale', STALE_NOTICE_COOLDOWN_MS, "Ro-Bought can't reach the retailer tab",
      'Make sure the tab is open, fully loaded and in the foreground, and that your computer has not slept. Reloading the tab usually fixes this.');
  }
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
  return !!cfg?.ok && RoBought.url.inScope(sender.url, cfg.config.productUrl);
}

const PAGE_HANDLERS = {
  [MESSAGES.GET_STATUS]: () => getStatus(),
  [MESSAGES.ARM]: () => arm(),
  [MESSAGES.DISARM]: () => disarm(),
  [MESSAGES.RESUME]: () => resume(),
  [MESSAGES.RESET]: () => reset(),
  [MESSAGES.CONFIG_SAVED]: async () => ({ ok: true, ...(await syncContentScripts()) }),
  [MESSAGES.TEACH_OPEN]: () => teachOpen(),
  [MESSAGES.TEACH_CLEAR]: (msg) => teachClear(msg),
};

const CONTENT_HANDLERS = {
  [MESSAGES.CONTENT_HELLO]: onContentHello,
  [MESSAGES.GUARD_STATUS]: onGuardStatus,
  [MESSAGES.PRESENCE]: onPresence,
  [MESSAGES.WATCH_REPORT]: onWatchReport,
  [MESSAGES.DROP_FIRED]: onDropFired,
  [MESSAGES.AVAILABLE]: onAvailable,
  [MESSAGES.CHECKOUT_PROGRESS]: onCheckoutProgress,
  [MESSAGES.CHECKOUT_HANDOFF]: onCheckoutHandoff,
  [MESSAGES.CLAIM_PURCHASE]: onClaimPurchase,
  [MESSAGES.ORDER_PLACED]: onOrderPlaced,
  [MESSAGES.PREFLIGHT]: onPreflight,
  [MESSAGES.TEACH_SAVE]: (msg) => teachSave(msg),
  [MESSAGES.RESUME]: contentResume,
  [MESSAGES.DISARM]: contentDisarm,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const run = async () => {
    if (isExtensionPage(sender)) {
      if (Object.hasOwn(PAGE_HANDLERS, msg.type)) return PAGE_HANDLERS[msg.type](msg, sender);
    } else if (Object.hasOwn(CONTENT_HANDLERS, msg.type) && (await isRetailerContent(sender))) {
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
    if (s.purchaseLock) {
      // "Place order" was clicked before the restart: the order may exist. End for good.
      s.status = RUN_STATUS.ABORTED;
      s.message = 'Chrome was restarted after Ro-Bought clicked "Place order". Check your orders before starting a new run.';
    } else {
      s.status = RUN_STATUS.IDLE;
      s.message = 'Chrome was restarted, so the run was disarmed. Re-arm when ready.';
    }
    s.pause = null;
    pushEvent(s, 'warn', s.message);
    return s;
  }).catch(logError);
  await syncContentScripts().catch(logError);
});

// If the user revokes site access, the bot can no longer run there: stop cleanly.
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  const cfg = await loadConfig();
  if (!cfg?.ok) return;
  const patterns = RoBought.url.scopePatterns(cfg.config.productUrl);
  if (!origins.some((o) => patterns.includes(o))) return;
  await syncContentScripts().catch(logError);
  await disarm('Site access for the retailer was removed.');
});

// Re-apply badge/keep-awake/watchdog each time the worker wakes up.
readRunState().then(applySideEffects).catch(logError);
