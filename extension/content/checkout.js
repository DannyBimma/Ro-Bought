// The checkout engine, running in the retailer tab while the run is "executing".
//
// Each page load works out where it is (product → cart → checkout steps → review →
// confirmation) and takes the next step; single-page checkouts are followed in place.
// Safety rules:
//   • Only buttons the user taught, preset buttons, or exact-text matches are clicked, and
//     never "Buy now"/1-Click, upsells or sign-ups (see adapters.neverClick).
//   • Nothing is typed. Address and payment must already be saved on the account.
//   • "Place order" is clicked only if auto-purchase is on, the total is read and within the
//     max price, the cart is one unit of one item as far as can be seen, and the service
//     worker grants the once-only purchase lock. With the lock taken, it never clicks again.
//   • The engine gets one turn per page load (plus one per Resume), so a state update can
//     never make it repeat a click on the same page.
//   • Anything unexpected pauses (resumable) or hands the purchase to the user.
(() => {
  'use strict';

  const { MESSAGES, RUN_STATUS, CHECKOUT } = RoBought.constants;
  const F = RoBought.finder;
  const { TEXT } = RoBought.adapters;

  let ctl = null;      // { ctx, ac }
  let leaving = false; // we navigated; this page's engine is done
  let ran = false;     // the engine already had its turn on this page (until a pause/resume)
  let confirmWatch = null; // { ctx, ac } while the user is in control mid-checkout
  const CONFIRM_WATCH_MS = 15 * 60_000;

  // Step results: NEXT = the page changed in place (single-page checkout), look again;
  // DONE = navigating away, handed off, or waiting for the user.
  const NEXT = 'next';
  const DONE = 'done';
  const MAX_IN_PAGE_STEPS = 8;

  const money = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'unknown');
  const isAbort = (e, signal) => signal.aborted || e?.name === 'AbortError';
  const here = () => new URL(location.href);

  const specs = (ctx, adapter) => specsFor(ctx.config, adapter);

  /** How to find each button: taught first, then the retailer preset, then exact text. */
  function specsFor(config, adapter) {
    const taught = config.selectors || {};
    const one = (v) => (v ? [v] : []);
    return {
      addToCart: { taught: one(taught.addToCart), presets: adapter.selectors.addToCart, text: TEXT.addToCart },
      proceed: { taught: one(taught.proceedToCheckout), presets: adapter.selectors.proceedToCheckout, text: TEXT.proceed },
      continue: { taught: taught.checkoutContinue || [], presets: adapter.selectors.checkoutContinue, text: TEXT.continue },
      placeOrder: { taught: one(taught.placeOrder), presets: adapter.selectors.placeOrder, text: TEXT.placeOrder },
      orderTotal: { taught: one(taught.orderTotal), presets: adapter.selectors.orderTotal, read: true },
      confirmation: { taught: one(taught.confirmation), read: true },
    };
  }

  function isConfirmation(ctx, adapter) {
    return adapter.isConfirmation(here(), document) || !!F.find(document, specs(ctx, adapter).confirmation);
  }

  /** What kind of page is this? Order matters: the product page is never mistaken for review. */
  function classify(ctx, adapter) {
    const url = here();
    const s = specs(ctx, adapter);
    if (isConfirmation(ctx, adapter)) return { type: 'confirmation' };
    if (adapter.isProductPage(url.href, ctx.config.productUrl)) return { type: 'product' };
    const reason = adapter.interstitial(url, document);
    if (reason) return { type: 'interstitial', reason };
    if (adapter.isAddedPage(url, document)) return { type: 'added' };
    if (F.find(document, s.placeOrder)) return { type: 'review' };
    if (adapter.isCartPage(url, document)) return { type: 'cart' };
    if (adapter.isCheckoutPage(url, document) || F.find(document, s.continue)) return { type: 'checkout' };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Talking to the coordinator
  // ---------------------------------------------------------------------------

  async function progress(ctl, stage, extra = {}) {
    return (await ctl.ctx.send(MESSAGES.CHECKOUT_PROGRESS, { stage, ...extra })) || { ok: false, error: 'Lost contact with Ro-Bought.' };
  }

  /** mode 'pause': the user does one step, then Resume. 'final': the user takes it from here. */
  async function handoff(ctl, mode, reason, stage, extra = {}) {
    await ctl.ctx.send(MESSAGES.CHECKOUT_HANDOFF, { mode, reason, stage, path: location.pathname, ...extra });
    return DONE;
  }

  function navigate(url) {
    leaving = true;
    stop();
    location.assign(url);
    return DONE;
  }

  /**
   * After a click: 'navigating' if the page is unloading, 'changed' if it changed in place,
   * or null if nothing happened before the timeout.
   */
  async function waitForChange(ctl, stillSame, timeoutMs) {
    let unloading = false;
    const onHide = () => {
      unloading = true;
      leaving = true;
    };
    window.addEventListener('pagehide', onHide, { once: true });
    try {
      const changed = await F.waitFor(() => unloading || !stillSame(), timeoutMs, ctl.ac.signal);
      if (unloading) return 'navigating';
      return changed ? 'changed' : null;
    } finally {
      window.removeEventListener('pagehide', onHide);
    }
  }

  // ---------------------------------------------------------------------------
  // Steps — each returns NEXT or DONE
  // ---------------------------------------------------------------------------

  /** One unit: if the product page has a quantity picker not set to 1, set it to 1. */
  function ensureQuantityOne(near) {
    const scope = near.closest('form') || document;
    const field = scope.querySelector('select[name*="quantity" i], select[name*="qty" i], select#quantity, input[name*="quantity" i]:not([type="hidden"]), input[name*="qty" i]:not([type="hidden"])');
    if (!field || field.value === '1') return true;
    if (field.tagName === 'SELECT' && ![...field.options].some((o) => o.value === '1')) return false;
    const proto = field.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, '1');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return field.value === '1';
  }

  async function stepProduct(ctl, adapter) {
    const s = specs(ctl.ctx, adapter);
    const found = await F.waitFind(document, s.addToCart, CHECKOUT.FIND_TIMEOUT_MS, ctl.ac.signal);
    if (!found) {
      // Sold out again (or not quite live yet): go back to watching rather than give up.
      await progress(ctl, 'product', { soldOut: true, entered: false });
      return DONE;
    }
    if (!ensureQuantityOne(found.el)) {
      return handoff(ctl, 'pause', "Couldn't set the quantity to 1. Set it yourself, then click Resume", 'product');
    }
    const label = F.labelOf(found.el);
    found.el.click();
    await progress(ctl, 'product', { note: `Clicked "${label}".`, entered: false });

    // Either the click navigates (this script ends), or the store confirms in place.
    const outcome = await waitForChange(ctl, () => !adapter.addedToCart(document), CHECKOUT.NAV_TIMEOUT_MS / 3);
    if (outcome === 'navigating') return DONE;
    return stepAdded(ctl, adapter);
  }

  async function stepAdded(ctl, adapter) {
    const cartUrl = adapter.cartUrl(ctl.ctx.config.productUrl, document);
    if (cartUrl) return navigate(cartUrl);
    return handoff(ctl, 'pause', "Couldn't find the cart. Open your cart, then click Resume", 'added');
  }

  async function stepCart(ctl, adapter) {
    const { productUrl } = ctl.ctx.config;
    const read = () => {
      const c = adapter.readCart(document, productUrl);
      return c.items !== null ? c : null;
    };
    const cart = (await F.waitFor(read, 4000, ctl.ac.signal)) || { items: null, qty: null, hasProduct: null };

    if (cart.items === 0) {
      // The add didn't stick (sold out at the last second?). Try the product page again;
      // the coordinator's visit limit stops this from looping.
      return navigate(productUrl);
    }
    if (cart.items > 1 || cart.hasProduct === false) {
      return handoff(ctl, 'pause', 'Your cart has other items. Ro-Bought only buys this one product: remove the others, then click Resume', 'cart');
    }
    if (cart.qty !== null && cart.qty > 1) {
      return handoff(ctl, 'pause', `The cart quantity is ${cart.qty}. Set it to 1, then click Resume`, 'cart');
    }
    const s = specs(ctl.ctx, adapter);
    const proceed = await F.waitFind(document, s.proceed, CHECKOUT.FIND_TIMEOUT_MS, ctl.ac.signal);
    if (!proceed) {
      return handoff(ctl, 'pause', `Couldn't find "Proceed to checkout". Click it yourself, then click Resume`, 'cart');
    }
    const button = proceed.el;
    const path = location.pathname;
    button.click();
    const outcome = await waitForChange(ctl, () => button.isConnected && location.pathname === path, CHECKOUT.NAV_TIMEOUT_MS);
    if (outcome === 'navigating') return DONE;
    if (outcome === 'changed') return NEXT;
    return handoff(ctl, 'pause', 'Clicked "Proceed to checkout" but nothing happened. Continue yourself, then click Resume', 'cart');
  }

  async function stepCheckout(ctl, adapter) {
    const s = specs(ctl.ctx, adapter);
    // Single-page checkouts show "Place order" right away; otherwise click one "continue".
    const next = await F.waitFor(
      () => (F.find(document, s.placeOrder) && 'review') || (F.find(document, s.continue) && 'continue'),
      CHECKOUT.FIND_TIMEOUT_MS,
      ctl.ac.signal,
    );
    if (next === 'review') return NEXT;
    if (!next) {
      return handoff(ctl, 'pause', "Couldn't find how to continue the checkout. Continue yourself, then click Resume", 'checkout');
    }
    const button = F.find(document, s.continue).el;
    const label = F.labelOf(button);
    button.click();
    await progress(ctl, 'checkout', { note: `Clicked "${label}".`, entered: false });
    const outcome = await waitForChange(ctl, () => button.isConnected && F.find(document, s.continue)?.el === button, CHECKOUT.NAV_TIMEOUT_MS);
    if (outcome === 'navigating') return DONE;
    if (outcome === 'changed') return NEXT;
    return handoff(ctl, 'pause', `Clicked "${label}" but nothing happened. Continue yourself, then click Resume`, 'checkout');
  }

  function readTotal(ctl, adapter) {
    const s = specs(ctl.ctx, adapter);
    if (s.orderTotal.taught.length) {
      const taught = F.find(document, { taught: s.orderTotal.taught, read: true });
      const p = taught ? RoBought.availability.parsePrice(taught.el.textContent || '') : null;
      if (p !== null) return p;
    }
    return adapter.readTotal(document);
  }

  async function stepReview(ctl, adapter) {
    const { config } = ctl.ctx;
    const s = specs(ctl.ctx, adapter);
    const found = await F.waitFind(document, s.placeOrder, CHECKOUT.FIND_TIMEOUT_MS, ctl.ac.signal);
    if (!found) {
      return handoff(ctl, 'pause', "Couldn't find the Place order button. Continue yourself, then click Resume", 'review');
    }
    const button = found.el;
    const label = F.labelOf(button) || 'Place order';
    // Give totals a moment to render (they often load after the button).
    const total = await F.waitFor(() => readTotal(ctl, adapter), 3000, ctl.ac.signal);

    if (adapter.hasAddress(document) === false) {
      return handoff(ctl, 'pause', 'No delivery address is selected. Pick your saved address, then click Resume', 'review');
    }
    if (adapter.hasPayment(document) === false) {
      return handoff(ctl, 'pause', 'No payment method is selected. Pick your saved card, then click Resume', 'review');
    }
    const max = config.maxTotalPrice;
    if (max !== null && total !== null && total > max) {
      return handoff(ctl, 'final', `The order total is ${money(total)}, above your max of ${money(max)}. Ro-Bought will not place this order`, 'review', { total });
    }

    button.scrollIntoView({ block: 'center', behavior: 'instant' });
    RoBought.overlay.highlight(button, { tone: 'ready', label: `Ro-Bought: "${label}"` });

    if (config.stopBeforePlaceOrder) {
      return handoff(ctl, 'final', `Ready: order total ${money(total)}. Check it, then click "${label}" to buy`, 'review', { ready: true, total });
    }
    if (total === null) {
      return handoff(ctl, 'final', `Couldn't read the order total, so Ro-Bought won't place the order. Check it and click "${label}" yourself`, 'review', { ready: true });
    }

    // The once-only lock: granted at most once per run, persisted, re-checked by the coordinator.
    const claim = await ctl.ctx.send(MESSAGES.CLAIM_PURCHASE, { total, label });
    if (!claim?.ok) {
      return handoff(ctl, 'final', claim?.error || 'Ro-Bought could not take the purchase lock, so it did not place the order', 'review', { ready: true });
    }
    RoBought.overlay.clearHighlight();
    button.click(); // exactly once
    return awaitConfirmation(ctl, adapter);
  }

  /** After "Place order": watch for the confirmation; never click anything again. */
  async function awaitConfirmation(ctl, adapter) {
    let unloading = false;
    const onHide = () => {
      unloading = true;
      leaving = true;
    };
    window.addEventListener('pagehide', onHide, { once: true });
    try {
      const ok = await F.waitFor(() => unloading || isConfirmation(ctl.ctx, adapter) || null, CHECKOUT.CONFIRM_TIMEOUT_MS, ctl.ac.signal);
      if (unloading) return DONE; // the next page load keeps watching (the lock is set)
      if (ok) {
        await ctl.ctx.send(MESSAGES.ORDER_PLACED, { detail: document.title.slice(0, 120) });
        return DONE;
      }
    } finally {
      window.removeEventListener('pagehide', onHide);
    }
    return handoff(ctl, 'final', 'Ro-Bought clicked "Place order" once and will not click it again. No confirmation showed up: check this page and your orders', 'placing');
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  async function run(ctl) {
    const adapter = RoBought.adapters.forUrl(ctl.ctx.config.productUrl);

    for (let i = 0; i < MAX_IN_PAGE_STEPS && !leaving; i++) {
      const { ctx } = ctl;
      const page = await F.waitFor(() => classify(ctx, adapter), CHECKOUT.SETTLE_MS, ctl.ac.signal);

      if (page?.type === 'confirmation') {
        await ctx.send(MESSAGES.ORDER_PLACED, { detail: document.title.slice(0, 120) });
        return;
      }
      if (ctx.state.purchaseLock) {
        // Place order was already clicked this run (this is a later page or step).
        await awaitConfirmation(ctl, adapter);
        return;
      }
      if (!page) {
        // An unrecognised page right after Add to cart is the store's "added" page.
        if (ctx.state.checkout?.stage === 'product') await stepAdded(ctl, adapter);
        else await handoff(ctl, 'pause', "Ro-Bought doesn't recognise this page. Get to the next checkout step yourself, then click Resume", 'unknown');
        return;
      }
      if (page.type === 'interstitial') {
        await handoff(ctl, 'pause', page.reason, 'interstitial');
        return;
      }

      const stage = page.type === 'added' ? 'product' : page.type;
      const entered = await progress(ctl, stage, { entered: page.type !== 'added' });
      if (!entered.ok) {
        if (!entered.rewatch) await handoff(ctl, 'pause', entered.error || 'The checkout stalled', stage);
        return;
      }

      let result = DONE;
      if (page.type === 'product') result = await stepProduct(ctl, adapter);
      else if (page.type === 'added') result = await stepAdded(ctl, adapter);
      else if (page.type === 'cart') result = await stepCart(ctl, adapter);
      else if (page.type === 'checkout') result = await stepCheckout(ctl, adapter);
      else if (page.type === 'review') result = await stepReview(ctl, adapter);
      if (result !== NEXT) return;
    }
    if (!leaving) await handoff(ctl, 'pause', 'The checkout took more steps than expected. Continue yourself, then click Resume', 'loop');
  }

  /**
   * While the user is in control mid-checkout (paused, or handed the final click), keep
   * watching for the order confirmation so the run finishes cleanly — including stores that
   * confirm in place without loading a new page. Never clicks anything.
   */
  function startConfirmWatch(ctx) {
    if (confirmWatch) {
      confirmWatch.ctx = ctx;
      return;
    }
    const cw = { ctx, ac: new AbortController() };
    confirmWatch = cw;
    const adapter = RoBought.adapters.forUrl(ctx.config.productUrl);
    F.waitFor(() => isConfirmation(cw.ctx, adapter) || null, CONFIRM_WATCH_MS, cw.ac.signal)
      .then((confirmed) => {
        if (confirmed && confirmWatch === cw) return cw.ctx.send(MESSAGES.ORDER_PLACED, { detail: document.title.slice(0, 120) });
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        if (confirmWatch === cw) confirmWatch = null;
      });
  }

  function stopConfirmWatch() {
    if (!confirmWatch) return;
    confirmWatch.ac.abort();
    confirmWatch = null;
  }

  /**
   * Start, keep or stop the engine to match the run state.
   * @param {null | {state: object, config: object, send: Function}} ctx
   */
  function sync(ctx) {
    if (leaving) return;
    const status = ctx?.state?.status;
    if (status !== RUN_STATUS.AWAITING_USER) RoBought.overlay.clearHighlight();
    if (ctx?.config && ctx.state.checkout && (status === RUN_STATUS.AWAITING_USER || status === RUN_STATUS.PAUSED)) {
      startConfirmWatch(ctx);
    } else {
      stopConfirmWatch();
    }
    if (status !== RUN_STATUS.EXECUTING) {
      ran = false; // after a pause + Resume, the engine may look at this page again
      stop();
      return;
    }
    if (!ctx.config) return;
    if (ctl) {
      ctl.ctx = ctx; // e.g. the purchase lock was just granted
      return;
    }
    if (ran) return; // this page already had its turn: wait for a navigation or a Resume
    ran = true;
    const current = { ctx, ac: new AbortController() };
    ctl = current;
    run(current)
      .catch((e) => {
        if (isAbort(e, current.ac.signal)) return undefined;
        console.warn('[Ro-Bought] checkout stopped:', e);
        return handoff(current, 'pause', 'Something unexpected happened during checkout. Continue yourself, then click Resume', 'error');
      })
      .finally(() => {
        if (ctl === current) ctl = null;
      });
  }

  function stop() {
    if (!ctl) return;
    ctl.ac.abort();
    ctl = null;
  }

  /** Teardown: stop everything this module started. */
  function shutdown() {
    stop();
    stopConfirmWatch();
    RoBought.overlay.clearHighlight();
  }

  /** Page restored from the back/forward cache. */
  function revive() {
    leaving = false;
    ran = false;
  }

  RoBought.checkout = Object.freeze({ sync, stop, shutdown, revive, specsFor });
})();
