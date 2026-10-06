'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RoBought = require('./load-shared');

const { jitter, parseRetryAfter, backoffDelay, nextCheckDelay, estimateClockOffset } = RoBought.timing;

test('jitter stays within ±pct and never below the floor', () => {
  assert.equal(jitter(45_000, 20, 20_000, () => 0), 36_000);   // -20 %
  assert.equal(jitter(45_000, 20, 20_000, () => 1), 54_000);   // +20 %
  assert.equal(jitter(45_000, 0, 0, () => 0.123), 45_000);
  assert.equal(jitter(20_000, 50, 20_000, () => 0), 20_000);   // floor wins
});

test('Retry-After: seconds or HTTP date, capped at 1 hour', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('Tue, 06 Oct 2026 12:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('Tue, 06 Oct 2026 11:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('999999', now), 3_600_000);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('back-off doubles, honours Retry-After, caps at 15 minutes', () => {
  assert.equal(backoffDelay(1, 45_000), 90_000);
  assert.equal(backoffDelay(2, 45_000), 180_000);
  assert.equal(backoffDelay(1, 3_000, 30_000), 30_000);
  assert.equal(backoffDelay(10, 45_000), 900_000);
});

test('next check: burst interval inside the window, restock interval after, back-off wins', () => {
  const base = { burstSec: 3, restockSec: 45, jitterPct: 0, minBurstSec: 2, minRestockSec: 20, rand: () => 0.5 };
  assert.equal(nextCheckDelay({ ...base, now: 1000, burstUntil: 5000 }), 3000);
  assert.equal(nextCheckDelay({ ...base, now: 6000, burstUntil: 5000 }), 45_000);
  assert.equal(nextCheckDelay({ ...base, now: 1000, burstUntil: 0, backoffUntil: 100_000 }), 99_000);
});

/** Simulates HEAD samples against a server whose clock is `skew` ms ahead, with `rtt` ms round trips. */
function samplesFor(skew, { start = 1_700_000_000_123, rtt = 40, gap = 1200, n = 5 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = start + i * gap;
    const serverRead = t0 + rtt / 2 + skew;          // server reads its clock mid-flight
    out.push({ t0, t1: t0 + rtt, serverMs: Math.floor(serverRead / 1000) * 1000 });
  }
  return out;
}

test('clock offset: never early — the estimate is at or below the true offset, within ~300 ms', () => {
  // A lower offset means firing later in local time, so "<= true offset" means "never early".
  for (const skew of [0, 3000, -2500, 1400, 60_000, 250, -250]) {
    for (const start of [1_700_000_000_000, 1_700_000_000_123, 1_700_000_000_777]) {
      for (const rtt of [10, 40, 200]) {
        const est = estimateClockOffset(samplesFor(skew, { start, rtt }));
        assert.equal(est.consistent, true);
        assert.ok(est.offsetMs <= skew, `skew ${skew}, start ${start}, rtt ${rtt}: ${est.offsetMs} would fire early`);
        assert.ok(skew - est.offsetMs <= 300 + rtt, `skew ${skew}, rtt ${rtt}: ${est.offsetMs} is too late`);
      }
    }
  }
});

test('clock offset: no samples or nonsense input falls back to zero', () => {
  assert.equal(estimateClockOffset([]).offsetMs, 0);
  assert.equal(estimateClockOffset([{ t0: 5, t1: 1, serverMs: 0 }]).samples, 0);
  assert.equal(estimateClockOffset(samplesFor(24 * 3_600_000)).offsetMs, 600_000); // capped at ±10 min
  assert.equal(estimateClockOffset(samplesFor(-24 * 3_600_000)).offsetMs, -600_000);
});
