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
      WATCH: 'watch', // watcher telemetry + memory that must survive page reloads
      // chrome.storage.local, separate from the run config (editable while a run is active)
      ALERT_SETTINGS: 'alertSettings', // { sound, query, feedUrl } — written by the options page
      ALERT_STATE: 'alertState',       // feed polling memory — written by the service worker only
    },

    CONTENT_SCRIPT_ID: 'robought-retailer',
    // Classic scripts injected (in order) into the configured retailer site only.
    CONTENT_SCRIPT_FILES: [
      'shared/namespace.js',
      'shared/constants.js',
      'shared/url-utils.js',
      'shared/ticket-guard.js',
      'shared/timing.js',
      'shared/availability.js',
      'content/dom.js',
      'content/guards.js',
      'content/adapters.js',
      'content/stock.js',
      'content/clock.js',
      'content/watcher.js',
      'content/overlay.js',
      'content/finder.js',
      'content/checkout.js',
      'content/teach.js',
      'content/main.js',
    ],

    WATCHDOG_ALARM: 'robought-watchdog',
    PREWARN_ALARM: 'robought-prewarn',
    ALERTS_ALARM: 'robought-alerts',
    ALERTS_POLL_MINUTES: 30,
    ALERTS_KEEP_ITEMS: 20,  // recent alert items shown in the options page
    ALERTS_KEEP_SEEN: 300,  // ids remembered so an item is announced once
    SOUND_KINDS: ['attention', 'success'],
    HEARTBEAT_MS: 30_000,
    STALE_AFTER_MS: 100_000,
    HIDDEN_NOTICE_COOLDOWN_MS: 60_000,
    STALE_NOTICE_COOLDOWN_MS: 300_000,

    // Why a run can pause. Content-detected kinds are re-checked continuously on the page;
    // tab-level kinds are detected by the service worker from tab events.
    CONTENT_GUARD_KINDS: ['captcha', 'challenge', 'queue', 'signin', 'payment', 'blocked'],
    TAB_GUARD_KINDS: ['offsite', 'tab_closed', 'discarded'],
    // 'checkout': the checkout engine got stuck and needs the user to do one step.
    PAUSE_HINTS: {
      checkout: 'Do this step yourself, then click Resume — or just finish the purchase by hand.',
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

    // Watcher tuning (milliseconds).
    WATCH: {
      FETCH_TIMEOUT_MS: 15_000,
      MAX_HTML_CHARS: 8_000_000,      // ignore absurdly large responses
      CLOCK_CHECK_LEAD_MS: 60_000,    // measure the store's clock this long before a drop
      CLOCK_CHECK_MIN_LEAD_MS: 8_000, // ...but not if the drop is closer than this
      CLOCK_SAMPLES: 5,
      CLOCK_SAMPLE_GAP_MS: 1_200,     // not a whole second, so samples land at different sub-second phases
      PRECISE_WINDOW_MS: 1_500,       // switch from coarse timers to frame/macrotask timing
      COARSE_CHUNK_MS: 30_000,        // long waits are chunked so sleep/clock changes are corrected
      UNREADABLE_NOTICE_AFTER: 3,     // consecutive "can't tell" checks before telling the user
    },

    // Checkout engine tuning (milliseconds unless stated).
    CHECKOUT: {
      STAGE_MAX_VISITS: 3,        // landing on the same stage more often than this = a loop
      TIMEOUT_MS: 5 * 60_000,     // the whole checkout, from "in stock" to confirmation
      FIND_TIMEOUT_MS: 10_000,    // waiting for a button to appear
      SETTLE_MS: 6_000,           // waiting for a page to become recognisable
      NAV_TIMEOUT_MS: 15_000,     // waiting for a click to lead somewhere
      CONFIRM_TIMEOUT_MS: 30_000, // waiting for the order confirmation after Place order
      MAX_CONTINUES_PER_PAGE: 3,
    },

    // Buttons the user can teach (Options → Buttons, or ⚡ → Teach buttons on the store page).
    TEACH_FIELDS: [
      // A click that reveals Add to cart: a pop-up's close button, or a buying option such as
      // Amazon's "regular price" radio during a Prime deal. (Id kept for saved configs.)
      { id: 'dismissPopup', label: 'Click first, before Add to cart (optional)', where: 'product page: a pop-up\'s close button or the regular-price option' },
      { id: 'addToCart', label: 'Add to cart', where: 'product page' },
      { id: 'proceedToCheckout', label: 'Proceed to checkout', where: 'cart page' },
      { id: 'checkoutContinue', label: 'Continue / Use this address / Use this payment', where: 'checkout pages (up to 3)', multi: true },
      { id: 'placeOrder', label: 'Place order', where: 'final review page' },
      { id: 'orderTotal', label: 'Order total amount', where: 'final review page' },
      { id: 'confirmation', label: 'Order confirmation message', where: 'thank-you page' },
    ],
    MAX_CONTINUE_SELECTORS: 3,

    // Last-check outcomes reported by the watcher.
    WATCH_RESULTS: ['in_stock', 'out_of_stock', 'unknown', 'over_price', 'error', 'blocked', 'backoff'],

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
      WATCH_REPORT: 'WATCH_REPORT',
      DROP_FIRED: 'DROP_FIRED',
      AVAILABLE: 'AVAILABLE',
      // checkout engine (content -> service worker)
      CHECKOUT_PROGRESS: 'CHECKOUT_PROGRESS',
      CHECKOUT_HANDOFF: 'CHECKOUT_HANDOFF',
      CLAIM_PURCHASE: 'CLAIM_PURCHASE',
      ORDER_PLACED: 'ORDER_PLACED',
      PREFLIGHT: 'PREFLIGHT', // cart check at arm time (content -> service worker)
      // notifications, alerts, activity log (options -> service worker)
      ALERTS_SAVED: 'ALERTS_SAVED',
      ALERTS_CHECK: 'ALERTS_CHECK',
      TEST_SOUND: 'TEST_SOUND',
      CLEAR_LOG: 'CLEAR_LOG',
      // service worker -> offscreen document
      PLAY_SOUND: 'PLAY_SOUND',
      // teach mode
      TEACH_OPEN: 'TEACH_OPEN',   // popup -> service worker -> store tab
      TEACH_SAVE: 'TEACH_SAVE',   // store tab -> service worker
      TEACH_CLEAR: 'TEACH_CLEAR', // options -> service worker
    },
  });
})();
