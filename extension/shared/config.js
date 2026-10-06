// Config schema, defaults and validation. Used by the options page (before saving)
// and by the service worker (before arming) — never trust stored data blindly.
(() => {
  'use strict';

  const { CONFIG_VERSION, LIMITS, TRIGGER_MODES } = RoBought.constants;
  const RETAILERS = Object.freeze(['generic']);

  function defaults() {
    return {
      version: CONFIG_VERSION,
      retailer: 'generic',
      productUrl: '',
      productName: '',
      triggerMode: 'restock',
      dropTime: null, // epoch ms
      fireOffsetMs: 0,
      restockIntervalSec: LIMITS.RESTOCK_INTERVAL_DEFAULT,
      jitterPct: LIMITS.JITTER_PCT_DEFAULT,
      burstIntervalSec: LIMITS.BURST_INTERVAL_DEFAULT,
      burstWindowSec: LIMITS.BURST_WINDOW_DEFAULT,
      stopBeforePlaceOrder: true,
      maxTotalPrice: null,
      selectors: emptySelectors(), // buttons the user taught (override the presets)
    };
  }

  const SELECTOR_MAX = 500;
  const LABEL_MAX = 80;

  function emptySelectors() {
    const out = {};
    for (const f of RoBought.constants.TEACH_FIELDS) out[f.id] = f.multi ? [] : null;
    return out;
  }

  /**
   * One taught button: { selector, label }. The selector may be empty when only the button's
   * exact text is reliable. Anything malformed is dropped.
   */
  function cleanTaught(v) {
    if (!v || typeof v !== 'object') return null;
    const selector = typeof v.selector === 'string' ? v.selector.trim() : '';
    if (selector.length > SELECTOR_MAX || /[\u0000-\u001f]/.test(selector)) return null;
    const label = typeof v.label === 'string' ? v.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LABEL_MAX) : '';
    if (!selector && !label) return null;
    return { selector, label };
  }

  function cleanSelectors(raw) {
    const out = emptySelectors();
    if (!raw || typeof raw !== 'object') return out;
    for (const f of RoBought.constants.TEACH_FIELDS) {
      if (f.multi) {
        const list = Array.isArray(raw[f.id]) ? raw[f.id] : [];
        out[f.id] = list.map(cleanTaught).filter(Boolean).slice(0, RoBought.constants.MAX_CONTINUE_SELECTORS);
      } else {
        out[f.id] = cleanTaught(raw[f.id]);
      }
    }
    return out;
  }

  const isPlainObject = (v) =>
    v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

  function intInRange(value, min, max) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  }

  /**
   * Builds a clean config from untrusted input. Only known keys are copied, so stray or
   * hostile properties (e.g. "__proto__") never reach storage.
   * @param {unknown} raw
   * @returns {{ ok: boolean, config: object, errors: Array<{field: string, message: string}>, warnings: string[] }}
   */
  function validate(raw) {
    const input = isPlainObject(raw) ? raw : {};
    const base = defaults();
    const config = { ...base };
    const errors = [];
    const warnings = [];
    const err = (field, message) => errors.push({ field, message });

    // Retailer
    config.retailer = RETAILERS.includes(input.retailer) ? input.retailer : base.retailer;

    // Product URL
    const url = RoBought.url.parseProductUrl(input.productUrl);
    if (!url) {
      err('productUrl', 'Enter a full https:// product URL (http is only allowed for localhost).');
    } else {
      config.productUrl = url.href;
      const ticketReason = RoBought.ticketGuard.checkUrl(url);
      if (ticketReason) err('productUrl', `${ticketReason} Event tickets are not supported.`);
    }

    // Product name (optional, used for alerts and the ticket check)
    if (input.productName != null) {
      const name = String(input.productName).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (name.length > LIMITS.PRODUCT_NAME_MAX) {
        err('productName', `Keep the product name under ${LIMITS.PRODUCT_NAME_MAX} characters.`);
      } else {
        config.productName = name;
        const ticketReason = RoBought.ticketGuard.checkText(name);
        if (ticketReason) err('productName', `${ticketReason} Event tickets are not supported.`);
      }
    }

    // Trigger mode
    if (!TRIGGER_MODES.includes(input.triggerMode)) {
      err('triggerMode', 'Choose a trigger mode.');
    } else {
      config.triggerMode = input.triggerMode;
    }

    // Scheduled drop time
    if (config.triggerMode === 'scheduled') {
      const t = Number(input.dropTime);
      if (!Number.isFinite(t) || t <= 0) {
        err('dropTime', 'Set the drop date and time.');
      } else {
        config.dropTime = Math.trunc(t);
      }
    } else if (Number.isFinite(Number(input.dropTime)) && Number(input.dropTime) > 0) {
      config.dropTime = Math.trunc(Number(input.dropTime)); // remembered, unused in restock mode
    }

    const ranged = [
      ['fireOffsetMs', LIMITS.FIRE_OFFSET_MS_MIN, LIMITS.FIRE_OFFSET_MS_MAX, 'Fire offset'],
      ['restockIntervalSec', LIMITS.RESTOCK_INTERVAL_MIN, LIMITS.RESTOCK_INTERVAL_MAX, 'Restock interval'],
      ['jitterPct', LIMITS.JITTER_PCT_MIN, LIMITS.JITTER_PCT_MAX, 'Jitter'],
      ['burstIntervalSec', LIMITS.BURST_INTERVAL_MIN, LIMITS.BURST_INTERVAL_MAX, 'Drop retry interval'],
      ['burstWindowSec', LIMITS.BURST_WINDOW_MIN, LIMITS.BURST_WINDOW_MAX, 'Drop retry window'],
    ];
    for (const [field, min, max, label] of ranged) {
      if (input[field] === undefined) continue;
      const v = intInRange(input[field], min, max);
      if (v === null) err(field, `${label} must be a whole number between ${min} and ${max}.`);
      else config[field] = v;
    }

    // Purchase behaviour
    config.stopBeforePlaceOrder = input.stopBeforePlaceOrder !== false;

    if (input.maxTotalPrice !== null && input.maxTotalPrice !== undefined && input.maxTotalPrice !== '') {
      const p = Number(input.maxTotalPrice);
      if (!Number.isFinite(p) || p <= 0 || p > LIMITS.PRICE_MAX) {
        err('maxTotalPrice', 'Max total price must be a positive number.');
      } else {
        config.maxTotalPrice = Math.round(p * 100) / 100;
      }
    }
    if (!config.stopBeforePlaceOrder && config.maxTotalPrice === null) {
      err('maxTotalPrice', 'A max total price is required when the bot places the order for you.');
    }
    if (config.stopBeforePlaceOrder && config.maxTotalPrice === null) {
      warnings.push('No max total price set — consider adding one as a safety net.');
    }

    // Taught buttons: malformed entries are dropped, never an error.
    config.selectors = cleanSelectors(input.selectors);

    return { ok: errors.length === 0, config, errors, warnings };
  }

  /**
   * Extra checks that depend on "now" — run when arming, not when saving.
   * @returns {string[]} blocking problems
   */
  function armProblems(config, now = Date.now()) {
    const problems = [];
    if (config.triggerMode === 'scheduled') {
      const maxAhead = LIMITS.MAX_SCHEDULE_AHEAD_DAYS * 86_400_000;
      if (!config.dropTime || config.dropTime <= now) {
        problems.push('The scheduled drop time is in the past. Update it in the options.');
      } else if (config.dropTime - now > maxAhead) {
        problems.push(`The drop is more than ${LIMITS.MAX_SCHEDULE_AHEAD_DAYS} days away — arm closer to the date.`);
      }
    }
    return problems;
  }

  RoBought.config = Object.freeze({ RETAILERS, defaults, validate, armProblems, cleanSelectors, cleanTaught, emptySelectors });
})();
