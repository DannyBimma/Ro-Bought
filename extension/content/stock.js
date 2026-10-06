// Stock detection on a document — either the live page or fetched page source.
// Order of trust: retailer adapter → structured data (JSON-LD, meta/microdata) → the page's
// main buy button. If nothing is conclusive the answer is "unknown", never a guess.
(() => {
  'use strict';

  const { schemaState, parsePrice, offersFromJsonLd } = RoBought.availability;

  const JSONLD_MAX_SCRIPTS = 25;
  const JSONLD_MAX_CHARS = 1_000_000;
  const BUTTON_SCAN_LIMIT = 400;
  const BUY_LABEL = /^(?:add to (?:cart|bag|basket)|buy (?:it )?now|pre-?order(?: now)?)\b/i;
  const SOLD_OUT_LABEL = /^(?:sold out|out of stock|currently unavailable|temporarily out of stock|unavailable|not available|notify me|email me when available|coming soon)\b/i;

  function fromJsonLd(doc) {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    let budget = JSONLD_MAX_CHARS;
    let result = null;
    for (let i = 0; i < Math.min(scripts.length, JSONLD_MAX_SCRIPTS); i++) {
      const raw = scripts[i].textContent || '';
      if (raw.length > budget) break;
      budget -= raw.length;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }
      const offers = offersFromJsonLd(data);
      if (offers?.state === 'in_stock') return offers;
      if (offers && !result) result = offers;
    }
    return result;
  }

  function fromMeta(doc) {
    const el = doc.querySelector([
      'meta[property="product:availability"]',
      'meta[property="og:availability"]',
      'meta[itemprop="availability"]',
      'link[itemprop="availability"]',
    ].join(','));
    if (!el) return null;
    const state = schemaState(el.getAttribute('content') || el.getAttribute('href') || '');
    if (!state) return null;
    const priceEl = doc.querySelector('meta[property="product:price:amount"], meta[itemprop="price"]');
    return { state, price: parsePrice(priceEl?.getAttribute('content') || '') };
  }

  function buttonLabel(el) {
    const raw = el.tagName === 'INPUT' ? el.value : el.textContent || el.getAttribute('aria-label') || '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** The page's own buy button: first "Add to cart"-like control in the main content. */
  function fromButtons(doc) {
    const scope = doc.querySelector('main, [role="main"], #main, #content') || doc.body;
    if (!scope) return null;
    const controls = scope.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]');
    let soldOut = null;
    for (let i = 0; i < Math.min(controls.length, BUTTON_SCAN_LIMIT); i++) {
      const label = buttonLabel(controls[i]);
      if (BUY_LABEL.test(label)) {
        return RoBought.adapters.isDisabled(controls[i])
          ? { state: 'out_of_stock', detail: `"${label}" button is disabled` }
          : { state: 'in_stock', detail: `"${label}" button is available` };
      }
      if (!soldOut && SOLD_OUT_LABEL.test(label)) soldOut = { state: 'out_of_stock', detail: `Page shows "${label}"` };
    }
    return soldOut;
  }

  /**
   * @param {Document} doc
   * @param {{productUrl: string, maxTotalPrice: number|null}} config
   * @returns {{state: 'in_stock'|'out_of_stock'|'unknown'|'over_price', price: number|null, source: string, detail: string}}
   */
  function detect(doc, config) {
    const adapter = RoBought.adapters.forUrl(config.productUrl);
    let result = null;

    const own = adapter.readStock(doc);
    if (own) result = { ...own, source: adapter.id };

    if (!result) {
      const ld = fromJsonLd(doc);
      if (ld) result = { ...ld, source: 'json-ld', detail: `Structured data says ${ld.state === 'in_stock' ? 'in stock' : 'out of stock'}` };
    }
    if (!result) {
      const meta = fromMeta(doc);
      if (meta) result = { ...meta, source: 'meta', detail: `Page metadata says ${meta.state === 'in_stock' ? 'in stock' : 'out of stock'}` };
    }
    if (!result) {
      const btn = fromButtons(doc);
      if (btn) result = { ...btn, price: null, source: 'button' };
    }
    if (!result) return { state: 'unknown', price: null, source: 'none', detail: 'No stock information found on the page' };

    const price = Number.isFinite(result.price) ? result.price : null;
    if (result.state === 'in_stock' && price !== null && config.maxTotalPrice && price > config.maxTotalPrice) {
      return {
        state: 'over_price', price, source: result.source,
        detail: `In stock at ${price.toFixed(2)}, above your max of ${config.maxTotalPrice.toFixed(2)}`,
      };
    }
    return { state: result.state, price, source: result.source, detail: result.detail || '' };
  }

  /**
   * Live page: client-rendered stores (e.g. Nintendo) draw the buy button after load, so
   * if the first look is inconclusive, watch the DOM briefly until it is.
   */
  async function detectLive(config, signal, timeoutMs = 5000) {
    let result = detect(document, config);
    if (result.state !== 'unknown') return result;
    let observer = null;
    let timer = null;
    let onAbort = null;
    try {
      await new Promise((resolve, reject) => {
        let pending = null;
        const recheck = () => {
          pending = null;
          result = detect(document, config);
          if (result.state !== 'unknown') resolve();
        };
        observer = new MutationObserver(() => {
          if (pending === null) pending = setTimeout(recheck, 150);
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'class', 'aria-disabled'] });
        timer = setTimeout(() => {
          clearTimeout(pending);
          resolve();
        }, timeoutMs);
        onAbort = () => {
          clearTimeout(pending);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      if (observer) observer.disconnect();
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    return result;
  }

  RoBought.stock = Object.freeze({ detect, detectLive });
})();
