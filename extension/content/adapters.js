// Retailer adapters: recognise each page of the purchase flow, read stock, cart and totals,
// and list the buttons to click. Presets cover the US stores (Amazon.com, Nintendo US).
// Everything is written to fail safe: when unsure, return null ("unknown"), never a guess
// that could lead to a wrong click. Buttons the user teaches always take priority.
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

  // ---------------------------------------------------------------------------
  // Hard safety rules: never click these, whatever a preset or a taught button says.
  // ---------------------------------------------------------------------------

  // "Buy now" / "Order now" on Amazon can be an instant purchase that skips the review page,
  // bypassing the max-price, one-item and once-only checks. Ro-Bought never clicks them.
  const NEVER_CLICK_SELECTOR = [
    '#buy-now-button', '[name="submit.buy-now"]', '[id*="buy-now" i]', '[id*="buynow" i]',
    '[name*="buy-now" i]', '[name*="buynow" i]', '[id*="one-click" i]', '[id*="oneclick" i]',
    '[name*="one-click" i]', '[name*="oneclick" i]', '[id^="turbo-checkout" i]', '[id*="prime-trial" i]',
  ].join(',');
  const NEVER_CLICK_TEXT = /1-click|one-click|subscribe|free trial|start (?:your )?trial|try prime|join prime|sign up|add (?:a )?protection|add (?:a )?warranty|buy now|buy it now|(?<!pre-?)order now|instant (?:buy|purchase|checkout)/i;

  /**
   * True if Ro-Bought must never click this element (instant-buy, upsells, sign-ups).
   * Amazon draws a button as <span class="a-button"><input id=…><span>Label</span></span>: the
   * visible label is a sibling of the real input, so the whole wrapper is checked.
   */
  function neverClick(el, label) {
    if (el.closest(NEVER_CLICK_SELECTOR)) return true;
    const wrap = el.closest('.a-button');
    if (wrap && (wrap.querySelector(NEVER_CLICK_SELECTOR) || NEVER_CLICK_TEXT.test(wrap.textContent || ''))) return true;
    return NEVER_CLICK_TEXT.test(label || '');
  }

  // ---------------------------------------------------------------------------
  // Generic recognisers, shared by all adapters as a fallback
  // ---------------------------------------------------------------------------

  const TEXT = Object.freeze({
    addToCart: /^(?:add to (?:cart|bag|basket)|pre-?order(?: now)?)\b/i,
    proceed: /^(?:proceed to checkout|checkout|check out|continue to checkout|go to checkout|secure checkout)$/i,
    continue: /^(?:continue|use this address|use this payment method|deliver to this address|ship to this address|continue to (?:shipping|delivery|payment|review|order review)|review (?:your )?order)$/i,
    // Exact phrases only. Never "buy now": on Amazon that can be an instant 1-Click purchase.
    placeOrder: /^(?:place (?:your )?order|place order and pay|complete (?:your )?(?:order|purchase)|submit (?:your )?order|confirm (?:and pay|order|purchase)|pay now)$/i,
    confirmation: /\b(?:thank you for your (?:order|purchase)|thank you, your order|your order (?:has been|was) (?:placed|received|confirmed)|order (?:placed|confirmed)(?:, thanks)?)\b/i,
  });
  const CART_URL = /\/(?:cart|basket|bag)(?:[/.?]|$)/i;
  const CHECKOUT_URL = /\/checkout(?:[/.?]|$)|\/buy\//i;
  const CONFIRM_URL = /thank-?you|order-?confirm(?:ation)?|\/confirmation|order-?complete|\/receipt/i;
  const TOTAL_LABEL = /^(?:(?:order|grand|estimated) total|total(?: to pay| due| charged)?)\b\s*:?/i;

  function genericIsConfirmation(url, doc) {
    if (CONFIRM_URL.test(url.pathname)) return true;
    for (const h of doc.querySelectorAll('h1, h2, h3, [role="alert"], [role="status"]')) {
      if (TEXT.confirmation.test(text(h).slice(0, 200))) return true;
    }
    return false;
  }

  /** "Order total: $529.99" anywhere in the main content; the strongest/last label wins. */
  function genericTotal(doc) {
    const scope = doc.querySelector('main, [role="main"]') || doc.body;
    if (!scope) return null;
    const nodes = scope.querySelectorAll('td, th, dt, dd, span, div, p, li, strong, b, label, h2, h3, h4');
    let best = null;
    for (let i = 0; i < Math.min(nodes.length, 4000); i++) {
      const el = nodes[i];
      if (el.children.length > 3) continue;
      const own = text(el);
      if (own.length > 60 || !TOTAL_LABEL.test(own)) continue;
      const weight = /order|grand/i.test(own) ? 2 : 1;
      const strip = (s) => s.replace(/\([^)]*\)/g, ' ').replace(TOTAL_LABEL, ' ');
      let price = parsePrice(strip(own));
      if (price === null && el.parentElement) {
        const row = text(el.parentElement);
        if (row.length <= 120) price = parsePrice(strip(row));
      }
      if (price !== null && (!best || weight >= best.weight)) best = { price, weight };
    }
    return best ? best.price : null;
  }

  /** Cart lines from quantity fields: one field per line item. */
  function genericCart(doc) {
    const scope = doc.querySelector('main, [role="main"], form') || doc.body;
    if (!scope) return { items: null, qty: null, hasProduct: null };
    const fields = scope.querySelectorAll('input[name*="qty" i], input[name*="quantity" i], select[name*="qty" i], select[name*="quantity" i]');
    if (fields.length) {
      const qtys = [...fields].map((f) => Number(f.value) || 0);
      return { items: fields.length, qty: qtys.length === 1 ? qtys[0] : Math.max(...qtys), hasProduct: null };
    }
    if (/your (?:shopping )?(?:cart|bag|basket) is empty/i.test(text(scope).slice(0, 5000))) return { items: 0, qty: 0, hasProduct: false };
    return { items: null, qty: null, hasProduct: null };
  }

  /** In-place confirmation that an item went into the cart (a toast, drawer or dialog). */
  function genericAdded(doc) {
    const spots = doc.querySelectorAll('[role="dialog"], [role="alert"], [role="status"], [aria-live], aside');
    for (let i = 0; i < Math.min(spots.length, 30); i++) {
      if (/\badded to (?:your )?(?:cart|bag|basket)\b/i.test(text(spots[i]).slice(0, 300))) return true;
    }
    return false;
  }

  /** A link to the cart in the page (header), for stores without a known cart URL. */
  function genericCartUrl(doc) {
    for (const a of doc.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.getAttribute('href'), location.href);
        if (u.origin === location.origin && CART_URL.test(u.pathname)) return u.href;
      } catch {
        // ignore malformed hrefs
      }
    }
    return null;
  }

  const generic = {
    id: 'generic',
    isProductPage: (url, productUrl) => samePath(new URL(url).pathname, new URL(productUrl).pathname),
    readStock: () => null,
    selectors: { addToCart: [], proceedToCheckout: [], checkoutContinue: [], placeOrder: [], orderTotal: [] },
    addedToCart: (doc) => genericAdded(doc),
    cartUrl: (_productUrl, doc) => genericCartUrl(doc),
    isAddedPage: () => false,
    isCartPage: (url) => CART_URL.test(url.pathname),
    readCart: (doc) => genericCart(doc),
    isCheckoutPage: (url) => CHECKOUT_URL.test(url.pathname),
    interstitial: () => null,
    readTotal: (doc) => genericTotal(doc),
    hasAddress: () => null,
    hasPayment: () => null,
    isConfirmation: genericIsConfirmation,
  };

  // ---------------------------------------------------------------------------
  // Amazon.com — best-effort selectors from Amazon's long-standing markup
  // ---------------------------------------------------------------------------

  const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i;
  const asinOf = (url) => (new URL(url).pathname.match(ASIN_RE) || [])[1]?.toUpperCase() || null;

  const amazon = {
    ...generic,
    id: 'amazon',

    isProductPage(url, productUrl) {
      const a = asinOf(url);
      return a !== null && a === asinOf(productUrl);
    },

    readStock(doc) {
      const price = parsePrice(text(doc.querySelector([
        '#corePrice_feature_div .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-offscreen',
        '#apex_desktop .a-price .a-offscreen',
        '#price_inside_buybox',
        '#priceblock_ourprice',
      ].join(','))));
      const buy = doc.querySelector('#add-to-cart-button');
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

    selectors: {
      addToCart: ['#add-to-cart-button', 'input[name="submit.add-to-cart"]'],
      proceedToCheckout: [
        'input[name="proceedToRetailCheckout"]', '#sc-buy-box-ptc-button input', '#sc-buy-box-ptc-button',
        '#desktop-ptc-button-celWidget input',
      ],
      checkoutContinue: [
        '#shipToThisAddressButton input', 'input[data-testid="Address_selectShipToThisAddress"]',
        '#orderSummaryPrimaryActionBtn input', 'input[name="ppw-widgetEvent:SetPaymentPlanSelectContinueEvent"]',
        '#shippingOptionFormId .a-button-primary input',
      ],
      placeOrder: [
        '#submitOrderButtonId input', 'input[name="placeYourOrder1"]', '#placeYourOrder input',
        '#placeOrder', '#bottomSubmitOrderButtonId input',
      ],
      orderTotal: [
        '#subtotals-marketplace-table .grand-total-price', '.order-summary-grand-total .a-color-price',
        '[data-testid="order-summary-total"]',
      ],
    },

    addedToCart: (doc) => !!doc.querySelector([
      '#NATC_SMART_WAGON_CONF_MSG_SUCCESS', '#sw-atc-details-single-container', '#attach-added-to-cart-message',
      '#huc-v2-order-row-confirm-text', '#sw-atc-confirmation',
    ].join(',')) || genericAdded(doc),

    cartUrl: (productUrl) => new URL('/gp/cart/view.html', productUrl).href,
    // The "Added to Cart" page (or side sheet page) that follows Add to Cart.
    isAddedPage: (url) => /^\/(?:cart\/smart-wagon|gp\/huc\/)/i.test(url.pathname),
    isCartPage: (url) => /^\/gp\/cart\/view\.html/i.test(url.pathname) || /^\/cart\/?(?:$|\?)/i.test(url.pathname),

    readCart(doc, productUrl) {
      const lines = doc.querySelectorAll('#sc-active-cart .sc-list-item[data-asin], #activeCartViewForm .sc-list-item[data-asin]');
      if (lines.length) {
        const want = asinOf(productUrl);
        const qtys = [...lines].map((l) => Number(l.getAttribute('data-quantity')) || 0);
        return {
          items: lines.length,
          qty: Math.max(...qtys),
          hasProduct: want ? [...lines].some((l) => (l.getAttribute('data-asin') || '').toUpperCase() === want) : null,
        };
      }
      if (/your amazon cart is empty/i.test(text(doc.querySelector('#sc-active-cart, .sc-your-amazon-cart-is-empty')))) {
        return { items: 0, qty: 0, hasProduct: false };
      }
      return { items: null, qty: null, hasProduct: null };
    },

    isCheckoutPage: (url) => /^\/(?:gp\/buy\/|checkout\/)/i.test(url.pathname),

    interstitial(url) {
      if (/^\/gp\/buy\/primeinterstitial\//i.test(url.pathname)) {
        return 'Amazon is offering a Prime trial. Decline it yourself, then click Resume';
      }
      if (/duplicate/i.test(url.pathname)) {
        return 'Amazon thinks this might be a duplicate order. Check it yourself';
      }
      return null;
    },

    readTotal(doc) {
      for (const sel of amazon.selectors.orderTotal) {
        const p = parsePrice(text(doc.querySelector(sel)));
        if (p !== null) return p;
      }
      return genericTotal(doc);
    },

    hasAddress: (doc) => (doc.querySelector('#shipaddress, .displayAddressDiv, #deliver-to-address-text, #checkout-delivery-address-panel, [data-testid="shipping-address-section"]') ? true : null),
    hasPayment: (doc) => (doc.querySelector('#payment-information, #checkout-payment-information-panel, .pmts-instrument-display-name, [data-testid="payment-method-section"]') ? true : null),

    isConfirmation(url, doc) {
      if (/^\/gp\/buy\/thankyou\//i.test(url.pathname) || /\/thankyou/i.test(url.pathname)) return true;
      if (/order placed, thanks/i.test(text(doc.querySelector('#widget-purchaseConfirmationStatus, h4, h1')))) return true;
      return genericIsConfirmation(url, doc);
    },
  };

  // ---------------------------------------------------------------------------
  // Nintendo US store — client-rendered; mostly generic, plus its cart address.
  // Nintendo account sign-in is on accounts.nintendo.com, which pauses as "offsite".
  // ---------------------------------------------------------------------------

  const nintendo = {
    ...generic,
    id: 'nintendo',
    cartUrl: (productUrl) => new URL('/us/cart/', productUrl).href,
    isCartPage: (url) => /^\/us\/cart(?:\/|$)/i.test(url.pathname),
    isCheckoutPage: (url) => /^\/us\/checkout(?:\/|$)/i.test(url.pathname) || CHECKOUT_URL.test(url.pathname),
  };

  const ADAPTERS = { amazon, nintendo, generic };

  /** @param {string|URL} productUrl */
  function forUrl(productUrl) {
    return ADAPTERS[RoBought.url.presetFor(productUrl)] || generic;
  }

  RoBought.adapters = Object.freeze({ forUrl, isDisabled, neverClick, TEXT });
})();
