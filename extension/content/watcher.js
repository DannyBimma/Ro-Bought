// The trigger controller, running in the retailer tab.
//   waiting  (scheduled drop): measure the store's clock near the drop, fire on time, reload.
//   watching (restock / after a drop): check politely until the product can be bought.
// Each run is owned by one AbortController: every sleep, fetch and frame wait is
// cancellable, so stopping or pausing never leaves a timer or request behind.
(() => {
  'use strict';

  const { MESSAGES, RUN_STATUS, LIMITS, WATCH } = RoBought.constants;
  const { nextCheckDelay, backoffDelay, parseRetryAfter } = RoBought.timing;
  const { sleep } = RoBought.clock;

  const MODE_FOR_STATUS = { [RUN_STATUS.WAITING]: 'countdown', [RUN_STATUS.WATCHING]: 'watch' };

  let ctl = null;       // { mode, ctx, ac }
  let mem = null;       // watcher memory for this run (persisted via the service worker)
  let leaving = false;  // we started a navigation; this page's watcher is done

  const timeOf = (ms) => new Date(ms).toLocaleTimeString();
  const isAbort = (e, signal) => signal.aborted || e?.name === 'AbortError';

  function freshMem(runId, saved) {
    const base = {
      runId, method: 'fetch', backoffLevel: 0, backoffUntil: 0, unknownStreak: 0,
      clockOffsetMs: null, clock: null, checks: 0, lastCheckAt: 0, nextCheckAt: 0,
      lastResult: null, lastDetail: '', lastPrice: null, confirming: false, firedAt: 0,
    };
    return saved && saved.runId === runId ? { ...base, ...saved } : base;
  }

  function report(ctx, extra = {}) {
    ctx.send(MESSAGES.WATCH_REPORT, { watch: { ...mem }, ...extra });
  }

  function note(ctx, text) {
    ctx.onNote(text);
  }

  /** Reload the product page (or go to it). The new page continues the run. */
  function goToProduct(ctx) {
    leaving = true;
    stop();
    const { productUrl } = ctx.config;
    if (RoBought.adapters.forUrl(productUrl).isProductPage(location.href, productUrl)) location.reload();
    else location.assign(productUrl);
  }

  function baseIntervalMs(ctx) {
    const inBurst = ctx.state.burstUntil && Date.now() < ctx.state.burstUntil;
    return (inBurst ? ctx.config.burstIntervalSec : ctx.config.restockIntervalSec) * 1000;
  }

  function applyBackoff(ctx, retryAfterMs) {
    mem.backoffLevel = Math.min(mem.backoffLevel + 1, 10);
    mem.backoffUntil = Date.now() + backoffDelay(mem.backoffLevel, baseIntervalMs(ctx), retryAfterMs);
  }

  function clearBackoff() {
    mem.backoffLevel = 0;
    mem.backoffUntil = 0;
  }

  function recordCheck(result, detail, price = null) {
    mem.checks++;
    mem.lastCheckAt = Date.now();
    mem.lastResult = result;
    mem.lastDetail = String(detail || '').slice(0, 200);
    mem.lastPrice = price;
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  /** @returns {Promise<'continue'|'stop'>} */
  async function handleResult(ctl, r, via) {
    const { ctx } = ctl;
    recordCheck(r.state, r.detail, r.price);
    const wasConfirming = mem.confirming;
    mem.confirming = false;

    if (r.state === 'in_stock') {
      if (via === 'page') {
        report(ctx);
        await ctx.send(MESSAGES.AVAILABLE, { detail: r.detail, price: r.price, source: r.source });
        return 'stop';
      }
      // The page source says buyable: load the real page and confirm there before acting.
      mem.confirming = true;
      report(ctx, { event: { level: 'info', text: `Page source says in stock (${r.detail}) — reloading to confirm.` } });
      goToProduct(ctx);
      return 'stop';
    }

    if (wasConfirming) {
      report(ctx, { event: { level: 'warn', text: 'The page source said in stock, but the page does not. Still watching.' } });
    }
    if (r.state === 'over_price') {
      report(ctx, { event: { level: 'warn', text: `${r.detail}. Not buying; still watching.` } });
    }
    if (r.state === 'unknown') {
      if (via === 'fetch') {
        // Client-rendered store: stock isn't in the page source. Reload the page instead.
        mem.method = 'reload';
        report(ctx, { event: { level: 'info', text: "Can't read stock from the page source — checking by reloading the page instead." } });
        goToProduct(ctx);
        return 'stop';
      }
      if (mem.method === 'reload') {
        mem.unknownStreak++;
        if (mem.unknownStreak === WATCH.UNREADABLE_NOTICE_AFTER) report(ctx, { unreadable: true });
      }
    } else {
      mem.unknownStreak = 0;
    }
    return 'continue';
  }

  // ---------------------------------------------------------------------------
  // One background check: fetch the product page source
  // ---------------------------------------------------------------------------

  /** @returns {Promise<'continue'|'stop'>} */
  async function fetchCheck(ctl) {
    const { ctx } = ctl;
    const signal = ctl.ac.signal;
    const { productUrl } = ctx.config;
    let res;
    try {
      res = await fetch(productUrl, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(WATCH.FETCH_TIMEOUT_MS)]),
      });
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      recordCheck('error', e?.name === 'TimeoutError' ? 'The store took too long to answer' : 'Network error');
      applyBackoff(ctx, null);
      return 'continue';
    }

    if (res.status === 429 || res.status === 503) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      applyBackoff(ctx, retryAfterMs);
      const secs = Math.round((mem.backoffUntil - Date.now()) / 1000);
      recordCheck('backoff', `The store answered ${res.status} — waiting ${secs}s`);
      report(ctx, { event: { level: 'warn', text: `The store said slow down (HTTP ${res.status}). Backing off for ${secs}s.` } });
      return 'continue';
    }
    if (res.status === 404 || res.status === 410) {
      clearBackoff();
      recordCheck('out_of_stock', 'Product page not found (yet)');
      return 'continue';
    }
    if (res.status === 401 || res.status === 403) {
      mem.method = 'reload';
      recordCheck('blocked', `The store refused the background check (HTTP ${res.status})`);
      report(ctx, { event: { level: 'warn', text: `The store refused the background check (HTTP ${res.status}). Reloading the page so you can see why.` } });
      goToProduct(ctx);
      return 'stop';
    }
    if (!res.ok) {
      applyBackoff(ctx, null);
      recordCheck('error', `The store answered HTTP ${res.status}`);
      return 'continue';
    }
    if (!RoBought.url.inScope(res.url, productUrl)) {
      // Redirected to another site: a queue, sign-in, or similar. Show it to the user.
      recordCheck('blocked', 'The check was redirected to another site');
      report(ctx, { event: { level: 'warn', text: 'The store redirected the check to another site (a queue or sign-in?). Opening it in the tab.' } });
      goToProduct(ctx);
      return 'stop';
    }

    const html = await res.text();
    if (html.length > WATCH.MAX_HTML_CHARS) {
      recordCheck('unknown', 'The product page is unexpectedly large');
      return 'continue';
    }
    // DOMParser documents never run scripts or load subresources.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocker = RoBought.guards.detectBlocker(doc, new URL(res.url), { static: true });
    if (blocker) {
      mem.method = 'reload';
      recordCheck('blocked', blocker.label);
      report(ctx, { event: { level: 'warn', text: `The background check got "${blocker.label}". Reloading the page so you can deal with it.` } });
      goToProduct(ctx);
      return 'stop';
    }
    clearBackoff();
    return handleResult(ctl, RoBought.stock.detect(doc, ctx.config), 'fetch');
  }

  // ---------------------------------------------------------------------------
  // watching: restock checks
  // ---------------------------------------------------------------------------

  function describe() {
    const when = mem.nextCheckAt ? `next check ~${timeOf(mem.nextCheckAt)}` : '';
    const last = mem.lastDetail ? `${mem.lastDetail}.` : 'Watching.';
    const how = mem.method === 'reload' ? ' (page reloads)' : '';
    return `${last} ${when}${how}`.trim();
  }

  async function runWatch(ctl) {
    const signal = ctl.ac.signal;
    const { config } = ctl.ctx; // config is fixed for the whole run
    const adapter = RoBought.adapters.forUrl(config.productUrl);

    // A load of the product page is itself a check.
    if (adapter.isProductPage(location.href, config.productUrl)) {
      const { ctx } = ctl;
      const status = performance.getEntriesByType('navigation')[0]?.responseStatus;
      if (status === 429 || status === 503) {
        applyBackoff(ctx, null);
        recordCheck('backoff', `The store answered ${status} — slowing down`);
        report(ctx, { event: { level: 'warn', text: `The store said slow down (HTTP ${status}). Backing off.` } });
      } else {
        if (status && status < 400) clearBackoff();
        if ((await handleResult(ctl, await RoBought.stock.detectLive(config, signal), 'page')) === 'stop') return;
      }
    }

    for (;;) {
      const ctx = ctl.ctx; // re-read: state updates (e.g. burstUntil) replace it
      try {
        const delay = nextCheckDelay({
          now: Date.now(),
          burstUntil: ctx.state.burstUntil || 0,
          burstSec: config.burstIntervalSec,
          restockSec: config.restockIntervalSec,
          jitterPct: config.jitterPct,
          minBurstSec: LIMITS.BURST_INTERVAL_MIN,
          minRestockSec: LIMITS.RESTOCK_INTERVAL_MIN,
          backoffUntil: mem.backoffUntil,
        });
        mem.nextCheckAt = Date.now() + delay;
        note(ctx, describe());
        report(ctx);
        await sleep(delay, signal);

        if (mem.method === 'reload') {
          goToProduct(ctx);
          return;
        }
        if ((await fetchCheck(ctl)) === 'stop') return;
      } catch (e) {
        if (isAbort(e, signal)) return;
        // Unexpected failure: never spin. Record it and back off.
        recordCheck('error', 'Unexpected error while checking');
        applyBackoff(ctx, null);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // waiting: scheduled drop
  // ---------------------------------------------------------------------------

  // Offsets under half a second are measurement slack, not a wrong clock: don't alarm anyone.
  const NOTABLE_OFFSET_MS = 500;
  const clockLabel = (ms) => (Math.abs(ms) >= NOTABLE_OFFSET_MS ? ` (store clock ${ms > 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s)` : '');

  function describeClock(est) {
    if (!est.samples) return 'Could not read the store clock; using your computer clock.';
    if (Math.abs(est.offsetMs) < NOTABLE_OFFSET_MS) return `Your clock matches the store (checked with ${est.samples} samples).`;
    const secs = (Math.abs(est.offsetMs) / 1000).toFixed(1);
    return `Your clock is ${secs}s ${est.offsetMs > 0 ? 'behind' : 'ahead of'} the store — correcting for it.`;
  }

  async function runCountdown(ctl) {
    const { ctx } = ctl;
    const signal = ctl.ac.signal;
    const { config } = ctx;
    const adapter = RoBought.adapters.forUrl(config.productUrl);

    // Already live (early drop, or the page was reloaded)? Act now.
    if (adapter.isProductPage(location.href, config.productUrl)) {
      const r = RoBought.stock.detect(document, config);
      if (r.state === 'in_stock') {
        recordCheck(r.state, r.detail, r.price);
        report(ctx);
        await ctx.send(MESSAGES.AVAILABLE, { detail: r.detail, price: r.price, source: r.source });
        return;
      }
    }

    const dropAt = config.dropTime + config.fireOffsetMs;
    for (;;) {
      const fireAt = dropAt - (mem.clockOffsetMs ?? 0);
      const remaining = fireAt - Date.now();
      if (remaining <= 0) break;

      const needClock = mem.clockOffsetMs === null;
      if (needClock && remaining <= WATCH.CLOCK_CHECK_LEAD_MS && remaining > WATCH.CLOCK_CHECK_MIN_LEAD_MS) {
        note(ctx, 'Checking the store clock…');
        const est = await RoBought.clock.measureOffset(config.productUrl, signal);
        mem.clockOffsetMs = est.offsetMs;
        mem.clock = est;
        report(ctx, { event: { level: 'info', text: describeClock(est) } });
        continue;
      }
      note(ctx, `Drop at ${timeOf(config.dropTime)}${clockLabel(mem.clockOffsetMs ?? 0)}.`);
      if (needClock && remaining > WATCH.CLOCK_CHECK_LEAD_MS) {
        await sleep(Math.min(remaining - WATCH.CLOCK_CHECK_LEAD_MS, WATCH.COARSE_CHUNK_MS), signal);
        continue;
      }
      await RoBought.clock.waitUntil(fireAt, signal);
      break;
    }

    // Fire: tell the coordinator (status -> watching, burst window), then load the page.
    mem.firedAt = Date.now();
    leaving = true; // ignore the status change this triggers; the reload continues the run
    report(ctx);
    await ctx.send(MESSAGES.DROP_FIRED, { firedAt: mem.firedAt, clockOffsetMs: mem.clockOffsetMs ?? 0 });
    goToProduct(ctx);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start, keep, or stop the controller to match the run state.
   * @param {null | {state: object, config: object, watch: object|null,
   *   send: (type: string, payload?: object) => Promise<any>, onNote: (text: string) => void}} ctx
   */
  function sync(ctx) {
    if (leaving) return;
    const want = ctx && ctx.config ? MODE_FOR_STATUS[ctx.state.status] || null : null;
    if (ctl && ctl.mode === want) {
      ctl.ctx = ctx; // e.g. burstUntil changed
      return;
    }
    stop();
    if (!want) return;
    if (!mem || mem.runId !== ctx.state.runId) mem = freshMem(ctx.state.runId, ctx.watch);
    const current = { mode: want, ctx, ac: new AbortController() };
    ctl = current;
    const run = want === 'countdown' ? runCountdown : runWatch;
    run(current).catch((e) => {
      if (!isAbort(e, current.ac.signal)) console.warn('[Ro-Bought] watcher stopped:', e);
    });
  }

  function stop() {
    if (!ctl) return;
    ctl.ac.abort();
    ctl = null;
  }

  /** Page restored from the back/forward cache: it may run the watcher again. */
  function revive() {
    leaving = false;
  }

  RoBought.watcher = Object.freeze({ sync, stop, revive });
})();
