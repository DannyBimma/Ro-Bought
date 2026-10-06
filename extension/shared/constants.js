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
    },

    CONTENT_SCRIPT_ID: 'robought-retailer',
    // Classic scripts injected (in order) into the configured retailer origin only.
    CONTENT_SCRIPT_FILES: [
      'shared/namespace.js',
      'shared/constants.js',
      'shared/url-utils.js',
      'shared/ticket-guard.js',
      'content/main.js',
    ],

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
      DISARM: 'DISARM',
      RESET: 'RESET',
      CONFIG_SAVED: 'CONFIG_SAVED',
      // content -> service worker
      CONTENT_HELLO: 'CONTENT_HELLO',
      // service worker -> content
      RUN_STATE_CHANGED: 'RUN_STATE_CHANGED',
    },
  });
})();
