// Pure timing helpers: jitter, polite back-off, Retry-After parsing, and clock-offset
// estimation. No DOM, no chrome.* — unit-tested in Node.
(() => {
  'use strict';

  const BACKOFF_MAX_MS = 15 * 60_000;
  const RETRY_AFTER_MAX_MS = 60 * 60_000;
  const CLOCK_OFFSET_MAX_MS = 10 * 60_000;

  /** baseMs ± pct%, never below floorMs. `rand` is injectable for tests. */
  function jitter(baseMs, pct, floorMs = 0, rand = Math.random) {
    const factor = 1 + ((rand() * 2 - 1) * pct) / 100;
    return Math.max(floorMs, Math.round(baseMs * factor));
  }

  /**
   * Retry-After is either delta-seconds or an HTTP date.
   * @returns {number|null} milliseconds to wait (capped at 1 h), or null if absent/invalid
   */
  function parseRetryAfter(value, now = Date.now()) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, RETRY_AFTER_MAX_MS);
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    return Math.min(Math.max(0, at - now), RETRY_AFTER_MAX_MS);
  }

  /** Exponential back-off (base × 2^level), honouring Retry-After, capped at 15 min. */
  function backoffDelay(level, baseMs, retryAfterMs = null) {
    const exp = baseMs * 2 ** Math.max(0, Math.min(level, 10));
    return Math.min(BACKOFF_MAX_MS, Math.max(retryAfterMs ?? 0, exp));
  }

  /**
   * How long to wait before the next availability check.
   * Inside the post-drop burst window the (shorter) burst interval applies; otherwise the
   * restock interval. An active back-off always wins.
   */
  function nextCheckDelay({ now, burstUntil, burstSec, restockSec, jitterPct, minBurstSec, minRestockSec, backoffUntil = 0, rand }) {
    const inBurst = burstUntil && now < burstUntil;
    const baseMs = (inBurst ? burstSec : restockSec) * 1000;
    const floorMs = (inBurst ? minBurstSec : minRestockSec) * 1000;
    const delay = jitter(baseMs, jitterPct, floorMs, rand);
    return Math.max(delay, backoffUntil > now ? backoffUntil - now : 0);
  }

  /**
   * Estimates (server clock − local clock) from HTTP `Date` headers.
   *
   * A `Date` header has 1-second resolution: if the server read its clock somewhere between
   * our local send (t0) and receive (t1) times and reported second S, then the true offset
   * lies in (S − t1, S + 1000 − t0). Intersecting samples taken at different sub-second
   * phases narrows the window.
   *
   * The returned offset is the window's LOW end: the latest local moment at which the store's
   * clock has certainly reached the drop time. Firing a fraction of a second late costs
   * almost nothing. Firing early means the first reload still shows "out of stock" and the
   * next check comes a whole retry interval later, so the estimate is never early.
   *
   * @param {Array<{t0: number, t1: number, serverMs: number}>} samples
   * @returns {{offsetMs: number, lowMs: number|null, highMs: number|null, samples: number, consistent: boolean}}
   */
  function estimateClockOffset(samples) {
    const valid = (samples || []).filter(
      (s) => Number.isFinite(s.t0) && Number.isFinite(s.t1) && Number.isFinite(s.serverMs) && s.t1 >= s.t0,
    );
    if (!valid.length) return { offsetMs: 0, lowMs: null, highMs: null, samples: 0, consistent: false };

    let lo = -Infinity;
    let hi = Infinity;
    for (const { t0, t1, serverMs } of valid) {
      const second = Math.floor(serverMs / 1000) * 1000;
      lo = Math.max(lo, second - t1);
      hi = Math.min(hi, second + 1000 - t0);
    }
    const clamp = (v) => Math.max(-CLOCK_OFFSET_MAX_MS, Math.min(CLOCK_OFFSET_MAX_MS, Math.round(v)));

    if (lo > hi) {
      // Inconsistent samples (e.g. different CDN edges). Fall back to the median midpoint.
      const mids = valid
        .map(({ t0, t1, serverMs }) => Math.floor(serverMs / 1000) * 1000 + 500 - (t0 + t1) / 2)
        .sort((a, b) => a - b);
      return { offsetMs: clamp(mids[Math.floor(mids.length / 2)]), lowMs: null, highMs: null, samples: valid.length, consistent: false };
    }
    return { offsetMs: clamp(lo), lowMs: Math.round(lo), highMs: Math.round(hi), samples: valid.length, consistent: true };
  }

  RoBought.timing = Object.freeze({
    BACKOFF_MAX_MS, jitter, parseRetryAfter, backoffDelay, nextCheckDelay, estimateClockOffset,
  });
})();
