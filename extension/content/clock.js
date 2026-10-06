// The precise clock. Lives in the retailer tab (a foreground page keeps full-precision
// timers and requestAnimationFrame; the MV3 service worker does not).
(() => {
  'use strict';

  const { WATCH } = RoBought.constants;

  /** Resolves after `ms`, or rejects with AbortError when `signal` aborts. */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function nextFrame(signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cancelAnimationFrame(id);
        reject(signal.reason);
      };
      const id = requestAnimationFrame(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Waits until the local wall-clock time `targetMs`, as precisely as the page allows:
   * chunked timers far out (re-anchored each chunk, so sleep or clock changes are
   * corrected), animation frames in the last ~1.5 s, then a MessageChannel macrotask
   * loop for the final few milliseconds.
   */
  async function waitUntil(targetMs, signal) {
    for (;;) {
      const remaining = targetMs - Date.now();
      if (remaining <= WATCH.PRECISE_WINDOW_MS) break;
      await sleep(Math.min(remaining - WATCH.PRECISE_WINDOW_MS, WATCH.COARSE_CHUNK_MS), signal);
    }
    // performance.now() is monotonic: anchor once for the final stretch.
    const perfTarget = performance.now() + (targetMs - Date.now());
    while (perfTarget - performance.now() > 20) {
      if (document.visibilityState === 'visible') await nextFrame(signal);
      else await sleep(Math.min(50, perfTarget - performance.now() - 20), signal); // frames don't run when hidden
    }
    const channel = new MessageChannel();
    try {
      while (performance.now() < perfTarget) {
        if (signal.aborted) throw signal.reason;
        await new Promise((resolve) => {
          channel.port1.onmessage = resolve;
          channel.port2.postMessage(0);
        });
      }
    } finally {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    }
  }

  /**
   * Samples the store's `Date` header with a few HEAD requests to the product URL and
   * estimates (store clock − local clock). Cached responses (Age > 0) are skipped: their
   * Date is when the copy was made, not now.
   */
  async function measureOffset(url, signal) {
    const samples = [];
    for (let i = 0; i < WATCH.CLOCK_SAMPLES; i++) {
      if (i) await sleep(WATCH.CLOCK_SAMPLE_GAP_MS, signal);
      const t0 = Date.now();
      let res;
      try {
        res = await fetch(url, {
          method: 'HEAD',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        continue;
      }
      const t1 = Date.now();
      const serverMs = Date.parse(res.headers.get('date') || '');
      const age = Number(res.headers.get('age') || 0);
      if (Number.isFinite(serverMs) && !(age > 0) && t1 - t0 < 3000) samples.push({ t0, t1, serverMs });
    }
    return RoBought.timing.estimateClockOffset(samples);
  }

  RoBought.clock = Object.freeze({ sleep, waitUntil, measureOffset });
})();
