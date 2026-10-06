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

function createFakeChrome({ extensionId = 'testextensionid' } = {}) {
  const store = new Map();
  const granted = new Set();
  const registered = new Map();
  const tabs = new Map();
  let nextTabId = 1;
  const calls = { keepAwake: [], badge: [], notifications: [], openOptions: 0 };

  const onChanged = event();
  const chrome = {
    runtime: {
      id: extensionId,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
      openOptionsPage: () => { calls.openOptions++; return Promise.resolve(); },
    },
    storage: {
      onChanged,
      local: {
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
          await onChanged.dispatch(changes, 'local');
        },
      },
    },
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
      clear: async () => true,
      onClicked: event(),
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
    tabs: {
      async query({ url, active }) {
        let list = [...tabs.values()];
        if (active) list = list.filter((t) => t.active);
        if (url) {
          const prefix = url.replace(/\*$/, '');
          list = list.filter((t) => t.url.startsWith(prefix));
        }
        return list.map((t) => ({ ...t }));
      },
      async create({ url, active }) {
        if (active) for (const t of tabs.values()) t.active = false;
        const tab = { id: nextTabId++, windowId: 1, url, active: !!active, autoDiscardable: true };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(id, props) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        if (props.active) for (const t of tabs.values()) t.active = false;
        Object.assign(tab, props);
        return { ...tab };
      },
    },
    windows: { update: async () => ({}) },
  };

  return { chrome, store, granted, registered, tabs, calls };
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

module.exports = { createFakeChrome, sendMessage };
