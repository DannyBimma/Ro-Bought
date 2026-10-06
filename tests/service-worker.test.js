'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { createFakeChrome, sendMessage } = require('./fake-chrome');

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

const { STORAGE_KEYS, MESSAGES } = globalThis.RoBought.constants;
const PRODUCT = 'https://www.example-store.com/product/123';
const PATTERN = 'https://www.example-store.com/*';

const page = { id: fake.chrome.runtime.id, origin: ORIGIN, url: `${ORIGIN}/popup/popup.html` };
const content = (tabId = 1, url = PRODUCT) => ({
  id: fake.chrome.runtime.id, tab: { id: tabId }, frameId: 0, url, origin: new URL(url).origin,
});
const send = (type, sender = page, extra = {}) => sendMessage(fake.chrome, { type, ...extra }, sender);
const runState = () => fake.store.get(STORAGE_KEYS.RUN_STATE);

async function saveConfig(over = {}) {
  await fake.chrome.storage.local.set({
    [STORAGE_KEYS.CONFIG]: { productUrl: PRODUCT, triggerMode: 'restock', ...over },
  });
}

test('refuses to arm without config or without site access', async () => {
  assert.match((await send(MESSAGES.ARM)).error, /Configure a product/);
  await saveConfig();
  assert.match((await send(MESSAGES.ARM)).error, /Site access/);
});

test('arms: registers scoped content script, opens pinned tab, keeps awake', async () => {
  fake.granted.add(PATTERN);
  const res = await send(MESSAGES.ARM);
  assert.deepEqual(res, { ok: true });
  assert.equal(runState().status, 'armed');
  assert.ok(runState().runId);

  const reg = fake.registered.get('robought-retailer');
  assert.deepEqual(reg.matches, [PATTERN]);
  assert.equal(reg.allFrames, false);

  const tab = fake.tabs.get(runState().tabId);
  assert.equal(tab.url, PRODUCT);
  assert.equal(tab.autoDiscardable, false);
  assert.equal(fake.calls.keepAwake.at(-1), 'display');
  assert.equal(fake.calls.badge.at(-1), 'ON');
});

test('cannot double-arm or reset while active', async () => {
  assert.match((await send(MESSAGES.ARM)).error, /Already armed/);
  assert.match((await send(MESSAGES.RESET)).error, /Disarm before/);
});

test('rejects page-only commands from content scripts and content from other hosts', async () => {
  assert.match((await send(MESSAGES.DISARM, content())).error, /not allowed/);
  const res = await send(MESSAGES.CONTENT_HELLO, content(1, 'https://evil.example.net/x'));
  assert.match(res.error, /not allowed/);
  assert.equal(runState().status, 'armed');
});

test('a ticket detected at runtime aborts the run and blocks re-arming until reset', async () => {
  const res = await send(MESSAGES.CONTENT_HELLO, content(), { ticketReason: 'Looks like a ticket.' });
  assert.deepEqual(res, { ok: true });
  assert.equal(runState().status, 'aborted');
  assert.equal(fake.calls.keepAwake.at(-1), 'release');
  assert.match((await send(MESSAGES.ARM)).error, /Reset for a new run/);
  assert.deepEqual(await send(MESSAGES.RESET), { ok: true });
  assert.equal(runState().status, 'idle');
});

test('disarm stops the run and releases the tab', async () => {
  await send(MESSAGES.ARM);
  const tabId = runState().tabId;
  await send(MESSAGES.DISARM);
  assert.equal(runState().status, 'idle');
  await new Promise((r) => setImmediate(r));
  assert.equal(fake.tabs.get(tabId).autoDiscardable, true);
});

test('Chrome restart disarms an active run instead of resuming silently', async () => {
  await send(MESSAGES.ARM);
  await fake.chrome.runtime.onStartup.dispatch();
  assert.equal(runState().status, 'idle');
  assert.match(runState().message, /restarted/);
});

test('revoking site access disarms and unregisters the content script', async () => {
  await send(MESSAGES.ARM);
  fake.granted.delete(PATTERN);
  await fake.chrome.permissions.onRemoved.dispatch({ origins: [PATTERN] });
  assert.equal(runState().status, 'idle');
  assert.equal(fake.registered.has('robought-retailer'), false);
  fake.granted.add(PATTERN);
});

test('refuses to arm while the active tab is a ticket site', async () => {
  await fake.chrome.tabs.create({ url: 'https://www.ticketmaster.com/event/1', active: true });
  assert.match((await send(MESSAGES.ARM)).error, /disabled on ticket sites/);
});

test('refuses to arm a scheduled drop in the past', async () => {
  await fake.chrome.tabs.create({ url: 'https://news.example.org/', active: true });
  await saveConfig({ triggerMode: 'scheduled', dropTime: Date.now() - 1000 });
  assert.match((await send(MESSAGES.ARM)).error, /in the past/);
});
