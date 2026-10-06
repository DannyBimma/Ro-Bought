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

const { STORAGE_KEYS, MESSAGES, WATCHDOG_ALARM } = globalThis.RoBought.constants;
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
  if (['armed', 'paused', 'watching', 'waiting'].includes(runState()?.status)) await send(MESSAGES.DISARM);
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
  assert.equal(runState().status, 'armed');
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
  assert.equal(runState().status, 'armed');
});

test('accepts the bare-domain variant of the retailer (amazon.com vs www.amazon.com)', async () => {
  const res = await send(MESSAGES.CONTENT_HELLO, content(runTab(), 'https://example-store.com/cart'));
  assert.equal(res.ok, true);
  assert.equal(res.tabId, runTab());
});

test('another tab on the same site cannot take over or pause the run', async () => {
  const other = await fake.chrome.tabs.create({ url: `${PRODUCT}?other`, active: false });
  const hello = await send(MESSAGES.CONTENT_HELLO, content(other.id), { ticketReason: null });
  assert.deepEqual(hello, { ok: true, tabId: other.id });
  assert.notEqual(runTab(), other.id);

  const guard = await send(MESSAGES.GUARD_STATUS, content(other.id), { guard: captcha });
  assert.match(guard.error, /Not the run tab/);
  const resume = await send(MESSAGES.DISARM, content(other.id));
  assert.match(resume.error, /Not the run tab/);
  assert.equal(runState().status, 'armed');
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
  assert.equal(s.pause.from, 'armed');
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
  assert.equal(runState().status, 'armed');
  assert.equal(runState().ackSignature, null);
  assert.equal(runState().pause, null);
});

test('"Resume anyway" acknowledges that exact guard only', async () => {
  await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: captcha });
  assert.equal(runState().status, 'paused');
  assert.deepEqual(await send(MESSAGES.RESUME, content(runTab())), { ok: true }); // from the in-page panel
  assert.equal(runState().status, 'armed');
  assert.equal(runState().ackSignature, captcha.signature);

  // Same guard again: ignored.
  const again = await send(MESSAGES.GUARD_STATUS, content(runTab()), { guard: captcha });
  assert.equal(again.ignored, true);
  assert.equal(runState().status, 'armed');

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
  assert.equal(runState().status, 'armed');
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
  assert.equal(runState().status, 'armed');
  assert.equal(runState().ackSignature, null); // tab-level pauses are never acknowledged
});

test('in-site navigation and other tabs do not pause', async () => {
  const id = runTab();
  await fake.chrome.tabs.onUpdated.dispatch(id, { status: 'complete' }, { id, url: 'https://example-store.com/cart' });
  await fake.chrome.tabs.onUpdated.dispatch(id + 100, { status: 'complete' }, { id: id + 100 });
  await fake.chrome.tabs.onUpdated.dispatch(id, { title: 'x' }, { id });
  await settle();
  assert.equal(runState().status, 'armed');
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
  assert.equal(runState().status, 'armed');
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
  assert.equal(runState().status, 'armed');
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
  assert.equal(runState().status, 'armed'); // a warning, not a pause
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
