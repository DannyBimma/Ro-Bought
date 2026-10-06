// Retailer adapters. Phase 3: recognising the product page and reading stock and price.
// Phase 4 adds the checkout steps. Selectors are best-effort for the US stores and are
// written to fail safe: if nothing matches, the result is "unknown", never a false "in stock".
(() => {
  'use strict';

  const { parsePrice } = RoBought.availability;

  const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const isDisabled = (el) =>
    el.hasAttribute('disabled') ||
    el.getAttribute('aria-disabled') === 'true' ||
    /(^|\s)(disabled|is-disabled)(\s|$)/i.test(el.getAttribute('class') || '');

  function samePath(a, b) {
    const norm = (p) => p.replace(/\/+$/, '').toLowerCase() || '/';
    return norm(a) === norm(b);
  }

  // -------------------------------------------------------------------------
  // Amazon.com
  // -------------------------------------------------------------------------

  const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i;
  const asinOf = (url) => (new URL(url).pathname.match(ASIN_RE) || [])[1]?.toUpperCase() || null;

  const amazon = {
    id: 'amazon',
    matches: (url) => /(^|\.)amazon\.com$/i.test(url.hostname),

    isProductPage(url, productUrl) {
      const a = asinOf(url);
      return a !== null && a === asinOf(productUrl);
    },

    /** @returns {{state: string, price: number|null, detail: string} | null} */
    readStock(doc) {
      const price = parsePrice(text(doc.querySelector([
        '#corePrice_feature_div .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-offscreen',
        '#apex_desktop .a-price .a-offscreen',
        '#price_inside_buybox',
        '#priceblock_ourprice',
      ].join(','))));

      const buy = doc.querySelector('#add-to-cart-button, #buy-now-button');
      if (buy && !isDisabled(buy)) return { state: 'in_stock', price, detail: 'Amazon: Add to Cart is available' };

      const availability = text(doc.querySelector('#availability'));
      if (doc.querySelector('#outOfStock') || /currently unavailable|temporarily out of stock|out of stock/i.test(availability)) {
        return { state: 'out_of_stock', price, detail: `Amazon: ${availability || 'Currently unavailable'}` };
      }
      // Only marketplace offers: often resellers at scalper prices. Not treated as a restock.
      if (doc.querySelector('#buybox-see-all-buying-choices, #buybox-see-all-buying-choices-announce')) {
        return { state: 'out_of_stock', price: null, detail: 'Amazon: only other sellers ("See All Buying Options")' };
      }
      return null;
    },
  };

  // -------------------------------------------------------------------------
  // Nintendo US store (www.nintendo.com/us/store/...)
  // -------------------------------------------------------------------------

  const nintendo = {
    id: 'nintendo',
    matches: (url) => /(^|\.)nintendo\.com$/i.test(url.hostname) && /^\/us\/store\//i.test(url.pathname),

    isProductPage(url, productUrl) {
      return samePath(new URL(url).pathname, new URL(productUrl).pathname);
    },

    // The store is client-rendered. Structured data and the generic button reading do the
    // work; anything the page source doesn't reveal falls back to page reloads.
    readStock: () => null,
  };

  // -------------------------------------------------------------------------
  // Generic: any other store
  // -------------------------------------------------------------------------

  const generic = {
    id: 'generic',
    matches: () => true,
    isProductPage(url, productUrl) {
      return samePath(new URL(url).pathname, new URL(productUrl).pathname);
    },
    readStock: () => null,
  };

  const ADAPTERS = [amazon, nintendo, generic];

  /** @param {string|URL} productUrl */
  function forUrl(productUrl) {
    const url = productUrl instanceof URL ? productUrl : new URL(productUrl);
    return ADAPTERS.find((a) => a.matches(url));
  }

  RoBought.adapters = Object.freeze({ forUrl, isDisabled });
})();
