// Minimal in-memory stand-in for the chrome.* APIs the service worker uses.
// Runs in the same realm as the code under test, like Chrome does.
'use strict';

function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    dispatch: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
    listeners,
  };
}

function storageArea(areaName, onChanged) {
  const store = new Map();
  return {
    store,
    async get(keys) {
      const list = keys == null ? [...store.keys()] : [].concat(keys);
      const out = {};
      for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: store.get(k), newValue: structuredClone(v) };
        store.set(k, structuredClone(v));
      }
      await onChanged.dispatch(changes, areaName);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (!store.has(k)) continue;
        changes[k] = { oldValue: store.get(k) };
        store.delete(k);
      }
      if (Object.keys(changes).length) await onChanged.dispatch(changes, areaName);
    },
  };
}

function createFakeChrome({ extensionId = 'testextensionid' } = {}) {
  const granted = new Set();
  const registered = new Map();
  const tabs = new Map();
  const alarms = new Map();
  let nextTabId = 1;
  const calls = { keepAwake: [], badge: [], notifications: [], cleared: [], focused: [], reloaded: [], tabMessages: [], openOptions: 0 };

  const onChanged = event();
  const local = storageArea('local', onChanged);
  const session = storageArea('session', onChanged);

  // Mirrors Chrome: without host permission for the tab's site, `url` is hidden.
  const visibleTab = (t) => {
    const copy = { ...t };
    const allowed = [...granted].some((p) => t.url.startsWith(p.replace(/\*$/, '')));
    if (!allowed) delete copy.url;
    return copy;
  };

  const tabsApi = {
    onRemoved: event(),
    onUpdated: event(),
    async query({ url, active }) {
      let list = [...tabs.values()];
      if (active) list = list.filter((t) => t.active);
      if (url) {
        const prefixes = [].concat(url).map((u) => u.replace(/\*$/, ''));
        list = list.filter((t) => prefixes.some((p) => t.url.startsWith(p)));
      }
      return list.map(visibleTab);
    },
    async get(id) {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return visibleTab(tab);
    },
    async create({ url, active }) {
      if (active) for (const t of tabs.values()) t.active = false;
      const tab = { id: nextTabId++, windowId: 1, url, active: !!active, autoDiscardable: true, discarded: false };
      tabs.set(tab.id, tab);
      return visibleTab(tab);
    },
    async update(id, props) {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      if (props.active) {
        for (const t of tabs.values()) t.active = false;
        calls.focused.push(id);
      }
      Object.assign(tab, props);
      return visibleTab(tab);
    },
    async reload(id) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      tabs.get(id).discarded = false;
      calls.reloaded.push(id);
    },
    async remove(id) {
      tabs.delete(id);
      await tabsApi.onRemoved.dispatch(id, { windowId: 1, isWindowClosing: false });
    },
    sendMessageReply: { ok: true },
    async sendMessage(tabId, msg) {
      calls.tabMessages.push({ tabId, msg });
      if (!tabs.has(tabId)) throw new Error('Could not establish connection.');
      return tabsApi.sendMessageReply;
    },
  };

  const chrome = {
    runtime: {
      id: extensionId,
      getURL: (path) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, '')}`,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
      openOptionsPage: () => { calls.openOptions++; return Promise.resolve(); },
    },
    storage: { onChanged, local, session },
    action: {
      setBadgeText: async ({ text }) => { calls.badge.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
    power: {
      requestKeepAwake: (level) => calls.keepAwake.push(level),
      releaseKeepAwake: () => calls.keepAwake.push('release'),
    },
    notifications: {
      create: async (id, opts) => { calls.notifications.push({ id, ...opts }); return id; },
      clear: async (id) => { calls.cleared.push(id); return true; },
      onClicked: event(),
    },
    alarms: {
      create: async (name, info) => { alarms.set(name, { name, ...info }); },
      get: async (name) => alarms.get(name),
      clear: async (name) => alarms.delete(name),
      onAlarm: event(),
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.filter((i) => registered.has(i)).map((i) => registered.get(i)),
      registerContentScripts: async (list) => { for (const s of list) registered.set(s.id, s); },
      unregisterContentScripts: async ({ ids }) => { for (const i of ids) registered.delete(i); },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((o) => granted.has(o)),
      onRemoved: event(),
    },
    tabs: tabsApi,
    windows: { update: async () => ({}) },
  };

  return { chrome, store: local.store, session: session.store, granted, registered, tabs, alarms, calls };
}

/** Delivers a runtime message the way Chrome does and resolves with the response. */
function sendMessage(chrome, msg, sender) {
  return new Promise((resolve) => {
    let handled = false;
    for (const fn of chrome.runtime.onMessage.listeners) {
      if (fn(msg, sender, resolve) === true) handled = true;
    }
    if (!handled) resolve(undefined);
  });
}

/** Lets queued promise callbacks (fire-and-forget listeners) run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

module.exports = { createFakeChrome, sendMessage, settle };
