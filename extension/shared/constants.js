(() => {
  'use strict';

  const deepFreeze = (obj) => {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
    }
    return Object.freeze(obj);
  };

  RoBought.constants = deepFreeze({
    CONFIG_VERSION: 1,

    STORAGE_KEYS: {
      CONFIG: 'config',
      RUN_STATE: 'runState',
      // chrome.storage.session (service worker only — never exposed to content scripts)
      PRESENCE: 'presence',
      NOTICES: 'notices',
    },

    CONTENT_SCRIPT_ID: 'robought-retailer',
    // Classic scripts injected (in order) into the configured retailer site only.
    CONTENT_SCRIPT_FILES: [
      'shared/namespace.js',
      'shared/constants.js',
      'shared/url-utils.js',
      'shared/ticket-guard.js',
      'content/dom.js',
      'content/guards.js',
      'content/overlay.js',
      'content/main.js',
    ],

    WATCHDOG_ALARM: 'robought-watchdog',
    HEARTBEAT_MS: 30_000,
    STALE_AFTER_MS: 100_000,
    HIDDEN_NOTICE_COOLDOWN_MS: 60_000,
    STALE_NOTICE_COOLDOWN_MS: 300_000,

    // Why a run can pause. Content-detected kinds are re-checked continuously on the page;
    // tab-level kinds are detected by the service worker from tab events.
    CONTENT_GUARD_KINDS: ['captcha', 'challenge', 'queue', 'signin', 'payment', 'blocked'],
    TAB_GUARD_KINDS: ['offsite', 'tab_closed', 'discarded'],
    PAUSE_HINTS: {
      captcha: 'Ro-Bought never solves CAPTCHAs. Complete it yourself, then click Resume.',
      challenge: 'Ro-Bought never bypasses bot checks. Complete it yourself, then click Resume.',
      queue: 'Ro-Bought never skips queues. Wait your turn in this tab, then click Resume.',
      signin: 'Ro-Bought never enters passwords or codes. Sign in yourself, then click Resume.',
      payment: 'Ro-Bought never enters card details. Fill this in yourself, then click Resume (or finish the order by hand).',
      blocked: 'The retailer blocked this request. Ro-Bought will not try to get around it.',
      offsite: 'Usually a queue, a sign-in page or a payment step on another site. Handle it, then click Resume.',
      tab_closed: 'Click Resume to reopen the retailer tab.',
      discarded: 'Chrome unloaded the tab to save memory. Click Resume to reload it.',
    },

    TRIGGER_MODES: ['scheduled', 'restock'],

    RUN_STATUS: {
      IDLE: 'idle',
      ARMED: 'armed',
      WAITING: 'waiting',           // scheduled drop: counting down
      WATCHING: 'watching',         // restock: polling
      EXECUTING: 'executing',       // running checkout steps
      PAUSED: 'paused',             // anti-bot control detected; human in charge
      AWAITING_USER: 'awaiting_user', // stopped one click short
      COMPLETED: 'completed',       // order placed (or lock claimed) — terminal
      ABORTED: 'aborted',           // a guard stopped the run — terminal
      ERROR: 'error',               // unexpected failure — terminal
    },

    // [label, tone] for the popup pill and the in-page panel.
    STATUS_LABELS: {
      idle: ['Off', ''],
      armed: ['Armed', 'on'],
      waiting: ['Waiting', 'on'],
      watching: ['Watching', 'on'],
      executing: ['Buying', 'warn'],
      paused: ['Your turn', 'bad'],
      awaiting_user: ['Your click', 'warn'],
      completed: ['Done', 'on'],
      aborted: ['Stopped', ''],
      error: ['Error', 'bad'],
    },

    // Statuses that require an explicit user "Reset" before the bot can run again.
    TERMINAL_STATUSES: ['completed', 'aborted', 'error'],
    // Statuses in which the bot is considered "on".
    ACTIVE_STATUSES: ['armed', 'waiting', 'watching', 'executing', 'paused', 'awaiting_user'],

    // Polite-network limits (seconds unless stated).
    LIMITS: {
      RESTOCK_INTERVAL_MIN: 20,
      RESTOCK_INTERVAL_MAX: 900,
      RESTOCK_INTERVAL_DEFAULT: 45,
      JITTER_PCT_MIN: 0,
      JITTER_PCT_MAX: 50,
      JITTER_PCT_DEFAULT: 20,
      BURST_INTERVAL_MIN: 2,
      BURST_INTERVAL_MAX: 30,
      BURST_INTERVAL_DEFAULT: 3,
      BURST_WINDOW_MIN: 10,
      BURST_WINDOW_MAX: 600,
      BURST_WINDOW_DEFAULT: 180,
      FIRE_OFFSET_MS_MIN: -2000,
      FIRE_OFFSET_MS_MAX: 5000,
      PRODUCT_NAME_MAX: 200,
      URL_MAX: 2048,
      PRICE_MAX: 1_000_000,
      MAX_SCHEDULE_AHEAD_DAYS: 90,
    },

    EVENT_LOG_MAX: 50,
    PREWARN_MINUTES: 2,

    MESSAGES: {
      // popup / options -> service worker
      GET_STATUS: 'GET_STATUS',
      ARM: 'ARM',
      RESET: 'RESET',
      CONFIG_SAVED: 'CONFIG_SAVED',
      // popup / options / in-page panel -> service worker
      DISARM: 'DISARM',
      RESUME: 'RESUME',
      // content -> service worker (content learns about state changes via storage.onChanged)
      CONTENT_HELLO: 'CONTENT_HELLO',
      GUARD_STATUS: 'GUARD_STATUS',
      PRESENCE: 'PRESENCE',
    },
  });
})();
