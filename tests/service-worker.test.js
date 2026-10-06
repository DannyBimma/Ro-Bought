'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { createFakeChrome, sendMessage, settle } = require('./fake-chrome');

const EXT = join(__dirname, '..', 'extension');
const fake = createFakeChrome();
const ORIGIN = `chrome-extension://${fake.chrome.runtime.id}`;

globalThis.chrome = fake.chrome;
globalThis.self = { location: { origin: ORIGIN } };
globalThis.importScripts = (...paths) => {
  for (const p of paths) {
    const file = join(EXT, 'background', p);
    vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file });
  }
};
const swPath = join(EXT, 'background', 'service-worker.js');
vm.runInThisContext(readFileSync(swPath, 'utf8'), { filename: swPath });

const { STORAGE_KEYS, MESSAGES, WATCHDOG_ALARM, PREWARN_ALARM } = globalThis.RoBought.constants;
const PRODUCT = 'https://www.example-store.com/product/123';
const PATTERNS = ['https://example-store.com/*', 'https://www.example-store.com/*'];

const page = { id: fake.chrome.runtime.id, origin: ORIGIN, url: `${ORIGIN}/popup/popup.html` };
const content = (tabId, url = PRODUCT) => ({
  id: fake.chrome.runtime.id, tab: { id: tabId }, frameId: 0, url, origin: new URL(url).origin,
});
const send = (type, sender = page, extra = {}) => sendMessage(fake.chrome, { type, ...extra }, sender);
const runState = () => fake.store.get(STORAGE_KEYS.RUN_STATE);
const runTab = () => runState().tabId;
const notified = (id) => fake.calls.notifications.filter((n) => n.id === `robought-${id}`);
const captcha = { kind: 'captcha', label: 'A Google reCAPTCHA appeared', signature: 'captcha:recaptcha:/product/123' };

async function saveConfig(over = {}) {
  await fake.chrome.storage.local.set({
    [STORAGE_KEYS.CONFIG]: { productUrl: PRODUCT, triggerMode: 'restock', ...over },
  });
}

async function armFresh() {
  if (['completed', 'aborted', 'error'].includes(runState()?.status)) await send(MESSAGES.RESET);
  if (['paused', 'watching', 'waiting', 'executing', 'awaiting_user'].includes(runState()?.status)) await send(MESSAGES.DISARM);
  const res = await send(MESSAGES.ARM);
  assert.deepEqual(res, { ok: true });
  await settle();
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

test('refuses to arm without config or without site access', async () => {
  assert.match((await send(MESSAGES.ARM)).error, /Configure a product/);
  await saveConfig();
  assert.match((await send(MESSAGES.ARM)).error, /Site access/);
  fake.granted.add(PATTERNS[0]); // only one of the two site patterns
  assert.match((await send(MESSAGES.ARM)).error, /Site access/);
});

test('arms: scoped content script, pinned tab, keep-awake, watchdog alarm', async () => {
  fake.granted.add(PATTERNS[1]);
  await armFresh();
  assert.equal(runState().status, 'watching');
  assert.ok(runState().runId);

  const reg = fake.registered.get('robought-retailer');
  assert.deepEqual(reg.matches, PATTERNS);
  assert.equal(reg.allFrames, false);
  assert.ok(reg.js.includes('content/guards.js'));

  const tab = fake.tabs.get(runTab());
  assert.equal(tab.url, PRODUCT);
  assert.equal(tab.autoDiscardable, false);
  assert.equal(fake.calls.keepAwake.at(-1), 'display');
  assert.equal(fake.calls.badge.at(-1), 'ON');
  assert.ok(fake.alarms.has(WATCHDOG_ALARM));
});

test('cannot double-arm or reset while active', async () => {
  assert.match((await send(MESSAGES.ARM)).error, /Already armed/);
  assert.match((await send(MESSAGES.RESET)).error, /Disarm before/);
});

// ---------------------------------------------------------------------------
// Sender validation
// ---------------------------------------------------------------------------

test('rejects page-only commands from content and content from other sites', async () => {
  assert.match((await send(MESSAGES.ARM, content(runTab()))).error, /not allowed/);
  assert.match((await send(MESSAGES.RESET, content(runTab()))).error, /not allowed/);
  const evil = await send(MESSAGES.GUARD_STATUS, content(runTab(), 'https://evil.example.net/x'), { guard: captcha });
  assert.match(evil.error, /not allowed/);
  assert.equal(runState().status, 'watching');
});

test('accepts the bare-domain variant of the retailer (amazon.com vs www.amazon.com)', async () => {
  const res = await send(MESSAGES.CONTENT_HELLO, content(runTab(), 'https://example-store.com/cart'));
  assert.equal(res.ok, true);
  assert.equal(res.tabId, runTab());
});

test('another tab on the same site cannot take over or pause the run', async () => {
  const other = await fake.chrome.tabs.create({ url: `${PRODUCT}?other`, active: false });
  const hello = await send(MESSAGES.CONTENT_HELLO, content(other.id), { ticketReason: null });
  assert.equal(hello.ok, true);
  assert.equal(hello.tabId, other.id);
  assert.equal(hello.config.productUrl, PRODUCT); // settings, so it could take over later
  assert.equal(hello.watch, null);                // but no run memory
  assert.notEqual(runTab(), other.id);

  const guard = await send(MESSAGES.GUARD_STATUS, content(other.id), { guard: captcha });
  assert.match(guard.error, /Not the run tab/);
  const resume = await send(MESSAGES.DISARM, content(other.id));
  assert.match(resume.error, /Not the run tab/);
  assert.equal(runState().status, 'watching');
});

// ---------------------------------------------------------------------------
// Guards: pause, clear, resume
// ---------------------------------------------------------------------------

test('an on-page CAPTCHA pauses the run, notifies and focuses the tab', async () => {
  fake.calls.focused.length = 0;
  const res = await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: captcha });
  assert.deepEqual(res, { ok: true });
  await settle();
  const s = runState();
  assert.equal(s.status, 'paused');
  assert.equal(s.pause.kind, 'captcha');
  assert.equal(s.pause.from, 'watching');
  assert.equal(s.pause.cleared, false);
  assert.equal(notified('paused').at(-1).requireInteraction, true);
  assert.match(notified('paused').at(-1).message, /never solves CAPTCHAs/);
  // Regression: a relative iconUrl resolves against /background/ and every notification fails.
  assert.equal(notified('paused').at(-1).iconUrl, `${ORIGIN}/icons/icon128.png`);
  assert.ok(fake.calls.focused.includes(runTab()));
  assert.equal(fake.calls.badge.at(-1), '!');
});

test('repeat reports of the same guard do not re-notify', async () => {
  const before = notified('paused').length;
  const events = runState().events.length;
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: captcha });
  assert.equal(notified('paused').length, before);
  assert.equal(runState().events.length, events);
});

test('guard gone -> "looks clear"; Resume continues with no acknowledgement', async () => {
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: null });
  assert.equal(runState().status, 'paused');
  assert.equal(runState().pause.cleared, true);

  assert.deepEqual(await send(MESSAGES.RESUME), { ok: true });
  assert.equal(runState().status, 'watching');
  assert.equal(runState().ackSignature, null);
  assert.equal(runState().pause, null);
});

test('"Resume anyway" acknowledges that exact guard only', async () => {
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: captcha });
  assert.equal(runState().status, 'paused');
  assert.deepEqual(await send(MESSAGES.RESUME, content(runTab())), { ok: true }); // from the in-page panel
  assert.equal(runState().status, 'watching');
  assert.equal(runState().ackSignature, captcha.signature);

  // Same guard again: ignored.
  const again = await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: captcha });
  assert.equal(again.ignored, true);
  assert.equal(runState().status, 'watching');

  // A different guard still pauses.
  const queue = { kind: 'queue', label: 'A queue or waiting room is showing', signature: 'queue:queue-text:/' };
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: queue });
  assert.equal(runState().status, 'paused');
  assert.equal(runState().pause.kind, 'queue');
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: null });
  await send(MESSAGES.RESUME);
});

test('rejects malformed guard reports', async () => {
  const res = await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: { kind: 'solve-it', label: 'x' } });
  assert.match(res.error, /Invalid guard/);
  assert.equal(runState().status, 'watching');
});

test('resume with nothing paused is refused', async () => {
  assert.match((await send(MESSAGES.RESUME)).error, /Nothing to resume/);
});

// ---------------------------------------------------------------------------
// Tab-level guards
// ---------------------------------------------------------------------------

test('leaving the retailer site (queue, sign-in, payment page) pauses; returning clears', async () => {
  await armFresh();
  const id = runTab();
  // Off-site: Chrome hides the URL because we have no permission there.
  await fake.chrome.tabs.onUpdated.dispatch(id, { status: 'complete' }, { id });
  await settle();
  assert.equal(runState().status, 'paused');
  assert.equal(runState().pause.kind, 'offsite');
  assert.match(runState().pause.label, /left www\.example-store\.com/);

  // Back on the retailer: the content script reports no guard.
  await fake.chrome.tabs.onUpdated.dispatch(id, { status: 'complete' }, { id, url: PRODUCT });
  await send(MESSAGES.GUARD_STATUS, content(id), { guard: null });
  assert.equal(runState().pause.cleared, true);
  await send(MESSAGES.RESUME);
  assert.equal(runState().status, 'watching');
  assert.equal(runState().ackSignature, null); // tab-level pauses are never acknowledged
});

test('in-site navigation and other tabs do not pause', async () => {
  const id = runTab();
  await fake.chrome.tabs.onUpdated.dispatch(id, { status: 'complete' }, { id, url: 'https://example-store.com/cart' });
  await fake.chrome.tabs.onUpdated.dispatch(id + 100, { status: 'complete' }, { id: id + 100 });
  await fake.chrome.tabs.onUpdated.dispatch(id, { title: 'x' }, { id });
  await settle();
  assert.equal(runState().status, 'watching');
});

test('closing the retailer tab pauses; Resume reopens it', async () => {
  const oldId = runTab();
  fake.calls.focused.length = 0;
  await fake.chrome.tabs.remove(oldId);
  await settle();
  assert.equal(runState().status, 'paused');
  assert.equal(runState().pause.kind, 'tab_closed');
  assert.ok(!fake.calls.focused.includes(oldId));

  await send(MESSAGES.GUARD_STATUS, content(oldId), { guard: null }); // stale tab can't clear it
  assert.equal(runState().status, 'paused');

  assert.deepEqual(await send(MESSAGES.RESUME), { ok: true });
  await settle();
  assert.equal(runState().status, 'watching');
  assert.notEqual(runTab(), oldId);
  assert.equal(fake.tabs.get(runTab()).url, PRODUCT);
});

test('a discarded tab pauses; Resume reloads it', async () => {
  const id = runTab();
  fake.tabs.get(id).discarded = true;
  await fake.chrome.tabs.onUpdated.dispatch(id, { discarded: true }, { id, url: PRODUCT });
  await settle();
  assert.equal(runState().pause.kind, 'discarded');
  await send(MESSAGES.RESUME);
  assert.ok(fake.calls.reloaded.includes(id));
  assert.equal(runState().status, 'watching');
});

// ---------------------------------------------------------------------------
// Presence + watchdog
// ---------------------------------------------------------------------------

test('a hidden retailer tab triggers one "bring it to front" notice per cooldown', async () => {
  const before = notified('hidden').length;
  await send(MESSAGES.PRESENCE, content(runTab()), { visible: false });
  await send(MESSAGES.PRESENCE, content(runTab()), { visible: false });
  assert.equal(notified('hidden').length, before + 1);
  await send(MESSAGES.PRESENCE, content(runTab()), { visible: true });
  assert.ok(fake.calls.cleared.includes('robought-hidden'));
});

test('watchdog warns when the tab has gone quiet', async () => {
  const s = runState();
  await fake.chrome.storage.local.set({ [STORAGE_KEYS.RUN_STATE]: { ...s, activeSince: Date.now() - 600_000 } });
  await fake.chrome.storage.session.set({
    [STORAGE_KEYS.PRESENCE]: { tabId: s.tabId, at: Date.now() - 600_000, visible: true },
  });
  const before = notified('stale').length;
  await fake.chrome.alarms.onAlarm.dispatch({ name: WATCHDOG_ALARM });
  await settle();
  assert.equal(notified('stale').length, before + 1);
  assert.equal(runState().status, 'watching'); // a warning, not a pause
});

test('watchdog pauses if the tab vanished without an onRemoved event', async () => {
  fake.tabs.delete(runTab());
  await fake.chrome.alarms.onAlarm.dispatch({ name: WATCHDOG_ALARM });
  await settle();
  assert.equal(runState().pause.kind, 'tab_closed');
});

// ---------------------------------------------------------------------------
// Ticket guard, disarm, lifecycle
// ---------------------------------------------------------------------------

test('a ticket page in the run tab aborts the run and blocks re-arming until reset', async () => {
  await armFresh();
  await send(MESSAGES.CONTENT_HELLO, content(runTab()), { ticketReason: 'This page is marked up as an event or ticket listing.' });
  await settle();
  assert.equal(runState().status, 'aborted');
  assert.equal(fake.calls.keepAwake.at(-1), 'release');
  assert.ok(!fake.alarms.has(WATCHDOG_ALARM));
  assert.match((await send(MESSAGES.ARM)).error, /Reset for a new run/);
  assert.deepEqual(await send(MESSAGES.RESET), { ok: true });
  assert.equal(runState().status, 'idle');
});

test('disarm stops the run, releases the tab and the watchdog', async () => {
  await armFresh();
  const tabId = runTab();
  await send(MESSAGES.DISARM);
  await settle();
  assert.equal(runState().status, 'idle');
  assert.equal(fake.tabs.get(tabId).autoDiscardable, true);
  assert.ok(!fake.alarms.has(WATCHDOG_ALARM));
});

test('Chrome restart disarms an active run instead of resuming silently', async () => {
  await armFresh();
  await fake.chrome.runtime.onStartup.dispatch();
  assert.equal(runState().status, 'idle');
  assert.match(runState().message, /restarted/);
});

test('revoking site access disarms and unregisters the content script', async () => {
  await armFresh();
  fake.granted.delete(PATTERNS[1]);
  await fake.chrome.permissions.onRemoved.dispatch({ origins: [PATTERNS[1]] });
  assert.equal(runState().status, 'idle');
  assert.equal(fake.registered.has('robought-retailer'), false);
  fake.granted.add(PATTERNS[1]);
});

test('refuses to arm while the active tab is a ticket site', async () => {
  await fake.chrome.tabs.create({ url: 'https://www.ticketmaster.com/event/1', active: true });
  fake.granted.add('https://www.ticketmaster.com/*'); // so the fake exposes the URL, as activeTab would
  assert.match((await send(MESSAGES.ARM)).error, /disabled on ticket sites/);
  fake.granted.delete('https://www.ticketmaster.com/*');
});

test('refuses to arm a scheduled drop in the past', async () => {
  await saveConfig({ triggerMode: 'scheduled', dropTime: Date.now() - 1000 });
  assert.match((await send(MESSAGES.ARM)).error, /in the past/);
});

// ---------------------------------------------------------------------------
// Triggers (Phase 3)
// ---------------------------------------------------------------------------

test('a scheduled arm starts "waiting" and sets the 2-minute pre-warning alarm', async () => {
  const dropTime = Date.now() + 10 * 60_000;
  await saveConfig({ triggerMode: 'scheduled', dropTime, burstIntervalSec: 3, burstWindowSec: 60 });
  await armFresh();
  assert.equal(runState().status, 'waiting');
  assert.equal(fake.alarms.get(PREWARN_ALARM).when, dropTime - 120_000);
});

test('the pre-warning notifies and brings the retailer tab forward', async () => {
  fake.calls.focused.length = 0;
  await fake.chrome.alarms.onAlarm.dispatch({ name: PREWARN_ALARM });
  await settle();
  assert.match(notified('prewarn').at(-1).title, /Drop in 2 minutes/);
  assert.ok(fake.calls.focused.includes(runTab()));
});

test('watch reports are sanitised, kept per run, and handed back on hello', async () => {
  const res = await send(MESSAGES.WATCH_REPORT, content(runTab()), {
    watch: { method: 'reload', clockOffsetMs: 1200, checks: 3, lastResult: 'out_of_stock', lastDetail: 'x'.repeat(500), evil: 'y', backoffLevel: 99 },
    event: { level: 'warn', text: 'The store said slow down (HTTP 429). Backing off for 8s.' },
  });
  assert.deepEqual(res, { ok: true });
  const hello = await send(MESSAGES.CONTENT_HELLO, content(runTab()));
  assert.equal(hello.config.triggerMode, 'scheduled');
  assert.equal(hello.watch.runId, runState().runId);
  assert.equal(hello.watch.method, 'reload');
  assert.equal(hello.watch.clockOffsetMs, 1200);
  assert.equal(hello.watch.lastDetail.length, 200);
  assert.equal(hello.watch.backoffLevel, 10);
  assert.equal(Object.hasOwn(hello.watch, 'evil'), false);
  assert.ok(runState().events.some((e) => e.level === 'warn' && /HTTP 429/.test(e.text)));

  const other = await fake.chrome.tabs.create({ url: PRODUCT, active: false });
  assert.match((await send(MESSAGES.WATCH_REPORT, content(other.id), { watch: {} })).error, /Not the active run tab/);
  const status = await send(MESSAGES.GET_STATUS);
  assert.equal(status.watch.checks, 3);
});

test('DROP_FIRED moves waiting -> watching with a burst window, once', async () => {
  const res = await send(MESSAGES.DROP_FIRED, content(runTab()), { clockOffsetMs: 1200 });
  assert.deepEqual(res, { ok: true });
  const s = runState();
  assert.equal(s.status, 'watching');
  assert.equal(s.burstUntil - s.firedAt, 60_000);
  assert.ok(s.events.some((e) => /store clock \+1\.2s/.test(e.text)));
  assert.match((await send(MESSAGES.DROP_FIRED, content(runTab()))).error, /Not waiting/);
});

test('AVAILABLE starts the checkout (executing) and brings the tab forward', async () => {
  fake.calls.focused.length = 0;
  const res = await send(MESSAGES.AVAILABLE, content(runTab()), { detail: 'Structured data says in stock', price: 499.99, source: 'json-ld' });
  assert.deepEqual(res, { ok: true });
  await settle();
  const s = runState();
  assert.equal(s.status, 'executing');
  assert.deepEqual(s.checkout.visits, {});
  assert.match(s.message, /499\.99/);
  assert.ok(notified('available').length);
  assert.ok(fake.calls.focused.includes(runTab()));
  assert.equal(fake.calls.badge.at(-1), 'GO');
  assert.match((await send(MESSAGES.AVAILABLE, content(runTab()), { detail: 'again' })).error, /Not watching/);
});

test('"cannot read stock" is told to the user once per run', async () => {
  await saveConfig();
  await armFresh();
  const before = notified(`unreadable-${runState().runId}`).length;
  await send(MESSAGES.WATCH_REPORT, content(runTab()), { watch: {}, unreadable: true });
  await send(MESSAGES.WATCH_REPORT, content(runTab()), { watch: {}, unreadable: true });
  assert.equal(notified(`unreadable-${runState().runId}`).length, before + 1);
});

test('a pause during the countdown resumes back to waiting', async () => {
  await saveConfig({ triggerMode: 'scheduled', dropTime: Date.now() + 30 * 60_000 });
  await armFresh();
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: captcha });
  assert.equal(runState().pause.from, 'waiting');
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: null });
  await send(MESSAGES.RESUME);
  assert.equal(runState().status, 'waiting');
});

test('a drop "fired" implausibly early is refused', async () => {
  // dropTime is 30 minutes away; clock correction is capped at 10 minutes.
  assert.match((await send(MESSAGES.DROP_FIRED, content(runTab()))).error, /Not waiting/);
  assert.equal(runState().status, 'waiting');
});

test('disarming a scheduled run clears the pre-warning alarm', async () => {
  assert.ok(fake.alarms.has(PREWARN_ALARM));
  await send(MESSAGES.DISARM);
  await settle();
  assert.ok(!fake.alarms.has(PREWARN_ALARM));
});

// ---------------------------------------------------------------------------
// Checkout (Phase 4)
// ---------------------------------------------------------------------------

async function startCheckout(over = {}) {
  await saveConfig({ maxTotalPrice: 600, ...over });
  await armFresh();
  await send(MESSAGES.AVAILABLE, content(runTab()), { detail: 'in stock', price: 499.99 });
  assert.equal(runState().status, 'executing');
}
const progress = (stage, extra = {}) => send(MESSAGES.CHECKOUT_PROGRESS, content(runTab()), { stage, ...extra });

test('checkout progress tracks stages and stops a loop after 3 visits', async () => {
  await startCheckout();
  assert.deepEqual(await progress('product'), { ok: true });
  assert.equal(runState().checkout.stage, 'product');
  assert.match(runState().message, /adding it to the cart/);
  await progress('product', { note: 'Clicked "Add to cart".', entered: false }); // a note, not a visit
  assert.equal(runState().checkout.visits.product, 1);
  await progress('product');
  await progress('product');
  const loop = await progress('product');
  assert.equal(loop.ok, false);
  assert.match(loop.error, /keeps landing on the product page/);
  assert.match((await progress('nonsense')).error, /Unknown checkout stage/);
});

test('sold out again at add-to-cart goes back to watching', async () => {
  await startCheckout();
  const res = await progress('product', { soldOut: true, entered: false });
  assert.equal(res.rewatch, true);
  assert.equal(runState().status, 'watching');
  assert.equal(runState().checkout, null);
});

test('a checkout that runs too long is refused', async () => {
  await startCheckout();
  const s = runState();
  await fake.chrome.storage.local.set({ [STORAGE_KEYS.RUN_STATE]: { ...s, checkout: { ...s.checkout, startedAt: Date.now() - 6 * 60_000 } } });
  assert.match((await progress('cart')).error, /taking too long/);
});

test('a stuck step pauses (kind "checkout"); page loads do not "clear" it; Resume retries fresh', async () => {
  await startCheckout();
  await progress('cart');
  const res = await send(MESSAGES.CHECKOUT_HANDOFF, content(runTab()), { mode: 'pause', reason: "Couldn't find \"Proceed to checkout\"", stage: 'cart', path: '/cart' });
  assert.deepEqual(res, { ok: true });
  assert.equal(runState().status, 'paused');
  assert.equal(runState().pause.kind, 'checkout');
  assert.match(notified('paused').at(-1).message, /Do this step yourself/);
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: null });
  assert.equal(runState().pause.cleared, false);
  await send(MESSAGES.RESUME);
  assert.equal(runState().status, 'executing');
  assert.deepEqual(runState().checkout.visits, {});
  assert.equal(runState().ackSignature, null);
});

test('stop one click short: "ready" hand-off, then the user places the order -> completed', async () => {
  await startCheckout(); // stopBeforePlaceOrder defaults to true
  await progress('review');
  assert.match((await send(MESSAGES.CLAIM_PURCHASE, content(runTab()), { total: 529.99 })).error, /Automatic purchase is off/);
  assert.equal(runState().purchaseLock, null);

  await send(MESSAGES.CHECKOUT_HANDOFF, content(runTab()), { mode: 'final', ready: true, reason: 'Ready: order total 529.99. Check it, then click "Place your order" to buy', stage: 'review' });
  let s = runState();
  assert.equal(s.status, 'awaiting_user');
  assert.equal(s.checkout.ready, true);
  assert.equal(notified('handoff').at(-1).title, 'Ready — your click');

  // While the user is in control, a guard (their CVV prompt) does not pause.
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: { kind: 'payment', label: 'CVV', signature: 'payment:card-entry:/review' } });
  assert.equal(runState().status, 'awaiting_user');

  assert.deepEqual(await send(MESSAGES.ORDER_PLACED, content(runTab()), { detail: 'Thank you' }), { ok: true });
  await settle();
  s = runState();
  assert.equal(s.status, 'completed');
  assert.match(s.message, /Order placed/);
  assert.equal(fake.calls.keepAwake.at(-1), 'release');
  assert.match((await send(MESSAGES.ARM)).error, /Reset for a new run/);
});

test('auto-purchase: the lock is granted once, only within the max price', async () => {
  await send(MESSAGES.RESET);
  await startCheckout({ stopBeforePlaceOrder: false, maxTotalPrice: 600 });
  await progress('review');
  const claim = (total) => send(MESSAGES.CLAIM_PURCHASE, content(runTab()), { total });
  assert.match((await claim(700)).error, /not within your max/);
  assert.match((await claim(null)).error, /not within your max/);
  assert.equal(runState().purchaseLock, null);

  assert.deepEqual(await claim(529.99), { ok: true });
  assert.equal(runState().purchaseLock.total, 529.99);
  assert.equal(runState().checkout.stage, 'placing');
  assert.match((await claim(529.99)).error, /already clicked "Place order" once/);

  assert.deepEqual(await send(MESSAGES.ORDER_PLACED, content(runTab()), { detail: 'Thank you' }), { ok: true });
  assert.equal(runState().status, 'completed');
  assert.match(runState().message, /529\.99/);
});

test('a confirmation page without the lock (while the bot is clicking) is not trusted', async () => {
  await send(MESSAGES.RESET);
  await startCheckout({ stopBeforePlaceOrder: false });
  assert.match((await send(MESSAGES.ORDER_PLACED, content(runTab()), {})).error, /No purchase in progress/);
  assert.equal(runState().status, 'executing');
});

test('disarming after "Place order" was clicked ends the run for good', async () => {
  await send(MESSAGES.CLAIM_PURCHASE, content(runTab()), { total: 529.99 });
  await send(MESSAGES.DISARM);
  assert.equal(runState().status, 'aborted');
  assert.match(runState().message, /check your orders/i);
  assert.match((await send(MESSAGES.ARM)).error, /Reset for a new run/);
});

test('a Chrome restart after "Place order" was clicked also ends the run for good', async () => {
  await send(MESSAGES.RESET);
  await startCheckout({ stopBeforePlaceOrder: false });
  await send(MESSAGES.CLAIM_PURCHASE, content(runTab()), { total: 100 });
  await fake.chrome.runtime.onStartup.dispatch();
  assert.equal(runState().status, 'aborted');
  await send(MESSAGES.RESET);
});

test('only the run tab can claim the lock or report an order', async () => {
  await startCheckout({ stopBeforePlaceOrder: false });
  const other = await fake.chrome.tabs.create({ url: PRODUCT, active: false });
  assert.match((await send(MESSAGES.CLAIM_PURCHASE, content(other.id), { total: 1 })).error, /Not the run tab/);
  assert.match((await send(MESSAGES.ORDER_PLACED, content(other.id), {})).error, /Not the run tab/);
  assert.equal(runState().purchaseLock, null);
  await send(MESSAGES.DISARM);
});

// ---------------------------------------------------------------------------
// Teach mode
// ---------------------------------------------------------------------------

test('teach: opens only on the store tab, and only while disarmed', async () => {
  await fake.chrome.tabs.create({ url: 'https://news.example.org/', active: true });
  fake.granted.add('https://news.example.org/*');
  assert.match((await send(MESSAGES.TEACH_OPEN)).error, /Open example-store\.com in this tab first/);
  fake.granted.delete('https://news.example.org/*');

  const store = await fake.chrome.tabs.create({ url: `${PRODUCT}`, active: true });
  assert.deepEqual(await send(MESSAGES.TEACH_OPEN), { ok: true });
  const sent = fake.calls.tabMessages.at(-1);
  assert.equal(sent.tabId, store.id);
  assert.equal(sent.msg.type, MESSAGES.TEACH_OPEN);
  assert.equal(sent.msg.config.productUrl, PRODUCT);

  await armFresh();
  assert.match((await send(MESSAGES.TEACH_OPEN)).error, /Disarm before teaching/);
  assert.match((await send(MESSAGES.TEACH_SAVE, content(store.id), { field: 'placeOrder', selector: '#x', label: 'x' })).error, /Disarm before teaching/);
  await send(MESSAGES.DISARM);
});

test('teach: saves buttons into the config; continues append up to 3; clear removes', async () => {
  const save = (field, selector, label) => send(MESSAGES.TEACH_SAVE, content(runTab()), { field, selector, label });
  const res = await save('placeOrder', '#place-order', 'Place your order');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.selectors.placeOrder, { selector: '#place-order', label: 'Place your order' });
  assert.deepEqual(fake.store.get(STORAGE_KEYS.CONFIG).selectors.placeOrder, { selector: '#place-order', label: 'Place your order' });

  await save('checkoutContinue', '#a', 'Use this address');
  await save('checkoutContinue', '#b', 'Use this payment method');
  await save('checkoutContinue', '#b', 'Use this payment method'); // duplicate: replaced, not added
  await save('checkoutContinue', '#c', 'Continue');
  assert.match((await save('checkoutContinue', '#d', 'Next')).error, /Up to 3/);
  assert.equal(fake.store.get(STORAGE_KEYS.CONFIG).selectors.checkoutContinue.length, 3);

  assert.match((await save('placeOrder', '', '')).error, /could not be saved/);
  assert.match((await save('evilField', '#x', 'x')).error, /could not be saved/);

  // The retailer tab gets the taught buttons with the run settings.
  const hello = await send(MESSAGES.CONTENT_HELLO, content(runTab()));
  assert.equal(hello.config.selectors.placeOrder.selector, '#place-order');
  assert.equal(hello.config.stopBeforePlaceOrder, fake.store.get(STORAGE_KEYS.CONFIG).stopBeforePlaceOrder);

  assert.equal((await send(MESSAGES.TEACH_CLEAR, page, { field: 'checkoutContinue', index: 1 })).ok, true);
  assert.deepEqual(fake.store.get(STORAGE_KEYS.CONFIG).selectors.checkoutContinue.map((e) => e.selector), ['#a', '#c']);
  await send(MESSAGES.TEACH_CLEAR, page, { field: 'placeOrder' });
  assert.equal(fake.store.get(STORAGE_KEYS.CONFIG).selectors.placeOrder, null);
  // Content scripts cannot clear (options page only).
  assert.match((await send(MESSAGES.TEACH_CLEAR, content(runTab()), { field: 'placeOrder' })).error, /not allowed/);
});
