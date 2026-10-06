// End-to-end test: loads the real extension into Chrome for Testing, serves the fixture
// pages on localhost, and drives everything over the DevTools protocol. Zero dependencies
// (Node >= 22 for the built-in WebSocket).
//
//   CHROME_PATH="/path/to/Google Chrome for Testing" npm run e2e
//
// Branded Chrome ignores --load-extension, so use Chrome for Testing:
//   npx @puppeteer/browsers install chrome@stable
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../../tools/serve.mjs';
import { createMockStore } from '../../tools/mock-store.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHROME = process.env.CHROME_PATH;
const HEADED = process.env.HEADED === '1';

if (!CHROME) {
  console.error('Set CHROME_PATH to a Chrome for Testing binary (npx @puppeteer/browsers install chrome@stable).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = (e) => reject(new Error(`CDP connect failed: ${e.message || e.type}`));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.eventHandlers = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) {
        for (const h of this.eventHandlers) h(msg);
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  close() {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const work = await mkdtemp(join(tmpdir(), 'robought-e2e-'));
const extDir = join(work, 'ext');
await cp(join(ROOT, 'extension'), extDir, { recursive: true });
// Test-only: pre-grant localhost so no permission prompt is needed.
const manifestPath = join(extDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://localhost/*'];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
// Test-only: lower the polite-interval floors so a check doesn't take 20+ s. The real
// extension is never modified; this patches the throwaway copy.
const constantsPath = join(extDir, 'shared', 'constants.js');
let constantsSrc = await readFile(constantsPath, 'utf8');
for (const [from, to] of [
  ['RESTOCK_INTERVAL_MIN: 20,', 'RESTOCK_INTERVAL_MIN: 2,'],
  ['BURST_INTERVAL_MIN: 2,', 'BURST_INTERVAL_MIN: 1,'],
  ['BURST_WINDOW_MIN: 10,', 'BURST_WINDOW_MIN: 3,'],
]) {
  assert.ok(constantsSrc.includes(from), `constants.js no longer contains "${from}"`);
  constantsSrc = constantsSrc.replace(from, to);
}
await writeFile(constantsPath, constantsSrc);

const store = createMockStore();
const server = await startServer({ root: join(ROOT, 'tests', 'fixtures'), port: 0, store });
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

const profile = join(work, 'profile');
const chrome = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  `--user-data-dir=${profile}`,
  `--load-extension=${extDir}`,
  `--disable-extensions-except=${extDir}`,
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

let cdp;
let failed = false;

async function cleanup() {
  try { cdp?.close(); } catch { /* already closed */ }
  chrome.kill();
  server.close();
  await sleep(300);
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

async function waitUntil(fn, { timeout = 8000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

try {
  const portFile = join(profile, 'DevToolsActivePort');
  const [debugPort, browserPath] = await waitUntil(
    async () => {
      const text = await readFile(portFile, 'utf8').catch(() => '');
      const lines = text.trim().split('\n');
      return lines.length >= 2 ? lines : null;
    },
    { timeout: 15000, what: 'Chrome to start' },
  );
  cdp = await Cdp.connect(`ws://127.0.0.1:${debugPort}${browserPath}`);

  // Attach to the extension's service worker.
  const swTarget = await waitUntil(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background/service-worker.js'));
  }, { timeout: 15000, what: 'the extension service worker' });
  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });

  // Any console.error or uncaught exception in the service worker fails the run.
  const swErrors = [];
  cdp.eventHandlers.push((msg) => {
    if (msg.sessionId !== swSession) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      swErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      swErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  await cdp.send('Runtime.enable', {}, swSession);

  /** Evaluate an async function body inside the service worker. */
  async function sw(body) {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    }, swSession);
    if (exceptionDetails) throw new Error(`SW eval failed: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
    return result.value;
  }

  const state = () => sw('return await readRunState();');
  const waitState = (pred, what, timeout = 8000) => waitUntil(async () => {
    const s = await state();
    return pred(s) ? s : null;
  }, { what, timeout });
  const go = (path) => sw(`const s = await readRunState(); await chrome.tabs.update(s.tabId, { url: ${JSON.stringify(path.startsWith('http') ? path : BASE + path)} }); return true;`);

  /** Reads the in-page panel's text and buttons, piercing its closed shadow root. */
  async function panel() {
    const s = await state();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const tabTarget = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(BASE));
    if (!tabTarget) return null;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tabTarget.targetId, flatten: true });
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
      let host = null;
      const walk = (n, fn) => { fn(n); for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, fn); };
      walk(root, (n) => { if (n.nodeName === 'ROBOUGHT-PANEL') host = n; });
      if (!host) return { present: false, tabId: s.tabId };
      const texts = [];
      const buttons = [];
      walk(host, (n) => {
        if (n.nodeType === 3 && n.nodeValue.trim()) texts.push(n.nodeValue.trim());
        if (n.nodeName === 'BUTTON') {
          const attrs = Object.fromEntries((n.attributes || []).reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), []));
          buttons.push({ nodeId: n.nodeId, action: attrs['data-action'] });
        }
      });
      const shadowMode = host.shadowRoots?.[0]?.shadowRootType;
      return { present: true, texts, buttons, shadowMode, sessionId };
    } catch (e) {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      throw e;
    }
  }

  async function clickPanelButton(action) {
    const p = await panel();
    const btn = p.buttons.find((b) => b.action === action);
    assert.ok(btn, `panel button "${action}" exists`);
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: btn.nodeId }, p.sessionId);
    const [x1, y1, , , x3, y3] = model.content;
    const x = (x1 + x3) / 2;
    const y = (y1 + y3) / 2;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, p.sessionId);
    }
    await cdp.send('Target.detachFromTarget', { sessionId: p.sessionId }).catch(() => {});
  }

  const results = [];
  async function step(name, fn) {
    const started = Date.now();
    try {
      await fn();
      results.push(`  ✓ ${name} (${Date.now() - started} ms)`);
      console.log(results.at(-1));
    } catch (e) {
      failed = true;
      console.log(`  ✗ ${name}\n      ${e.message}`);
      console.log(`      state: ${JSON.stringify(await state().catch(() => null))?.slice(0, 600)}`);
      throw e;
    }
  }

  const connected = (s) => s.events.some((e) => e.text === 'Retailer tab connected.' && e.t >= s.activeSince);
  const stays = async (status, ms = 1500) => {
    await sleep(ms);
    const s = await state();
    assert.equal(s.status, status, `expected to stay "${status}"`);
  };
  const clearAndResume = async (path = '/product.html') => {
    await go(path);
    await waitState((s) => s.pause?.cleared, 'pause to clear');
    assert.deepEqual(await sw('return await resume();'), { ok: true });
    await waitState((s) => s.status === 'watching', 'resume');
  };

  console.log(`Ro-Bought e2e — Chrome ${swTarget.url.split('/')[2]} on ${BASE}`);

  await step('configure + arm (restock) opens the product tab and connects', async () => {
    const reg = await sw(`
      await chrome.storage.local.set({ config: { productUrl: '${BASE}/product.html', triggerMode: 'restock' } });
      return await syncContentScripts();`);
    assert.equal(reg.registered, true, JSON.stringify(reg));
    assert.deepEqual(await sw('return await arm();'), { ok: true });
    await waitState((s) => s.status === 'watching' && s.tabId && connected(s), 'tab to connect');
  });

  await step('status panel renders in a closed shadow root', async () => {
    const p = await waitUntil(async () => {
      const r = await panel();
      if (r?.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
      return r?.present ? r : null;
    }, { what: 'panel' });
    assert.equal(p.shadowMode, 'closed');
    assert.ok(p.texts.includes('Watching'), p.texts.join(' | '));
    assert.ok(p.buttons.some((b) => b.action === 'disarm'));
  });

  await step('ordinary product page with hidden password field + invisible reCAPTCHA badge does not pause', async () => {
    await stays('watching');
    const presence = await sw("return (await chrome.storage.session.get('presence')).presence;");
    assert.ok(presence && presence.tabId === (await state()).tabId, 'presence recorded');
  });

  await step('book titled "The Waiting Room" (full page) does not pause', async () => {
    await go('/book.html');
    await stays('watching');
  });

  await step('PerimeterX "press & hold" block page pauses', async () => {
    await go('/guards/px-block.html');
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'challenge');
    assert.match(s.pause.label, /press & hold/i);
  });

  await step('panel shows "Paused — your turn" with Resume anyway; clearing then panel Resume (real click) continues', async () => {
    const p = await panel();
    await cdp.send('Target.detachFromTarget', { sessionId: p.sessionId }).catch(() => {});
    assert.ok(p.texts.includes('Paused — your turn'), p.texts.join(' | '));
    assert.ok(p.texts.includes('Resume anyway'));
    await go('/product.html');
    await waitState((s) => s.pause?.cleared, 'pause to clear');
    await waitUntil(async () => {
      const r = await panel();
      if (r?.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
      return r?.texts?.includes('Resume') ? r : null;
    }, { what: 'panel Resume button' });
    await clickPanelButton('resume');
    const s = await waitState((x) => x.status === 'watching', 'resume via panel');
    assert.equal(s.ackSignature, null);
  });

  await step('Amazon "type the characters" CAPTCHA pauses', async () => {
    await go('/guards/amazon-captcha.html');
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'captcha');
    await clearAndResume();
  });

  await step('waiting-room page pauses as a queue', async () => {
    await go('/guards/waiting-room.html');
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'queue');
    await clearAndResume();
  });

  await step('"Verify you are human" interstitial pauses', async () => {
    await go('/guards/human-check.html');
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'challenge');
    await clearAndResume();
  });

  await step('sign-in page with a visible password field pauses', async () => {
    await go('/guards/signin.html');
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'signin');
    await clearAndResume();
  });

  await step('challenge injected into a live page is caught by the observer', async () => {
    await go('/product.html?inject=px');
    await waitState((s) => connected(s) || s.status === 'paused', 'page');
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'challenge');
  });

  await step('"Resume anyway" acknowledges it: the same check on the same page does not re-pause', async () => {
    assert.deepEqual(await sw('return await resume();'), { ok: true });
    const s = await state();
    assert.ok(s.ackSignature?.startsWith('challenge:perimeterx:'), s.ackSignature);
    await stays('watching');
  });

  await step('hidden reCAPTCHA frame stays ignored; revealing it later pauses', async () => {
    await go('/product.html?inject=recaptchaHidden');
    await stays('watching', 1200);
    await go('/product.html?inject=recaptchaLater');
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'captcha');
    assert.match(s.pause.label, /reCAPTCHA/);
    await clearAndResume();
  });

  await step('leaving the retailer site pauses (offsite); coming back clears it', async () => {
    await go(`http://127.0.0.1:${PORT}/product.html`); // no permission there -> URL hidden
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'offsite');
    await clearAndResume();
    assert.equal((await state()).ackSignature?.startsWith('offsite'), false);
  });

  await step('closing the retailer tab pauses; Resume reopens and reconnects', async () => {
    const before = await state();
    await sw(`await chrome.tabs.remove(${before.tabId}); return true;`);
    const s = await waitState((x) => x.status === 'paused', 'pause');
    assert.equal(s.pause.kind, 'tab_closed');
    assert.deepEqual(await sw('return await resume();'), { ok: true });
    const after = await waitState((x) => x.status === 'watching' && x.tabId !== before.tabId && connected(x), 'reconnect');
    assert.ok(after.tabId);
  });

  await step('disarm from the in-page panel (real click)', async () => {
    await waitUntil(async () => {
      const r = await panel();
      if (r?.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
      return r?.present ? r : null;
    }, { what: 'panel' });
    await clickPanelButton('disarm');
    await waitState((s) => s.status === 'idle', 'disarm');
    const alarm = await sw("return await chrome.alarms.get('robought-watchdog');");
    assert.equal(alarm ?? null, null);
    await waitUntil(async () => {
      const r = await panel();
      if (r?.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
      return r && !r.present;
    }, { what: 'panel to disappear' });
  });

  await step('event/ticket structured data on a page aborts the run', async () => {
    assert.deepEqual(await sw('return await arm();'), { ok: true });
    await waitState((s) => s.status === 'watching' && connected(s), 'arm');
    await go('/guards/event.html');
    const s = await waitState((x) => x.status === 'aborted', 'abort');
    assert.match(s.message, /event or ticket/);
    assert.match((await sw('return await arm();')).error, /Reset for a new run/);
    assert.deepEqual(await sw('return await reset();'), { ok: true });
  });

  // -------------------------------------------------------------------------
  // Phase 3: triggers, against the mock store
  // -------------------------------------------------------------------------

  const STORE_PRODUCT = `${BASE}/store/product.html`;
  const configure = async (over) => {
    const cfg = { productUrl: STORE_PRODUCT, triggerMode: 'restock', restockIntervalSec: 2, jitterPct: 0, ...over };
    const reg = await sw(`await chrome.storage.local.set({ config: ${JSON.stringify(cfg)} }); return await syncContentScripts();`);
    assert.equal(reg.registered, true, JSON.stringify(reg));
  };
  const armRun = async (expectStatus) => {
    assert.deepEqual(await sw('return await arm();'), { ok: true });
    return waitState((s) => s.status === expectStatus && connected(s), `arm -> ${expectStatus}`);
  };
  const disarmRun = async () => {
    await sw('return await disarm();');
    await waitState((s) => s.status === 'idle', 'disarm');
  };
  const pageGets = (since, path = '/store/product.html') =>
    store.requests((r) => r.t >= since && r.path === path && r.method === 'GET');
  const watchInfo = async () => (await sw('return await getStatus();')).watch;
  const gapsOf = (list) => list.slice(1).map((r, i) => r.t - list[i].t);

  await step('restock: background checks of the page source, politely spaced', async () => {
    store.reset();
    await configure({});
    const t0 = Date.now();
    await armRun('watching');
    const fetches = await waitUntil(() => {
      const list = pageGets(t0).filter((r) => r.mode === 'cors');
      return list.length >= 3 ? list : null;
    }, { timeout: 12000, what: '3 background checks' });
    const gaps = gapsOf(fetches);
    assert.ok(gaps.every((g) => g >= 1900), `gaps ${gaps.join(', ')} ms`);
    const w = await watchInfo();
    assert.equal(w.method, 'fetch');
    assert.equal(w.lastResult, 'out_of_stock');
  });

  await step('restock: HTTP 429 with Retry-After backs off, then recovers', async () => {
    store.failNext(429, 1, 5);
    const failed429 = await waitUntil(
      () => store.requests((r) => r.status === 429)[0] || null,
      { timeout: 8000, what: 'the 429' },
    );
    const next = await waitUntil(
      () => pageGets(failed429.t + 1).find((r) => r.mode === 'cors') || null,
      { timeout: 12000, what: 'the check after the 429' },
    );
    assert.ok(next.t - failed429.t >= 4900, `waited only ${next.t - failed429.t} ms`);
    const s = await state();
    assert.ok(s.events.some((e) => /slow down \(HTTP 429\)/.test(e.text)));
    await waitUntil(async () => (await watchInfo())?.backoffLevel === 0, { what: 'back-off to reset' });
  });

  await step('restock: in stock -> page reload confirms -> handed to you', async () => {
    const tIn = Date.now();
    store.set({ stock: 'in' });
    const s = await waitState((x) => x.status === 'awaiting_user', 'hand-off', 10000);
    assert.match(s.message, /In stock now/);
    const after = pageGets(tIn);
    const firstFetch = after.findIndex((r) => r.mode === 'cors');
    const firstNav = after.findIndex((r) => r.mode === 'navigate');
    assert.ok(firstFetch !== -1 && firstNav > firstFetch, `expected fetch then reload: ${after.map((r) => r.mode).join(',')}`);
    const p = await waitUntil(async () => {
      const r = await panel();
      if (r?.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
      return r?.texts?.includes('In stock — your turn') ? r : null;
    }, { what: 'panel "In stock — your turn"' });
    assert.ok(p.buttons.some((b) => b.action === 'disarm'));
    await disarmRun();
  });

  await step('price ceiling: in stock above the max keeps watching; a lower price hands off', async () => {
    store.reset();
    store.set({ stock: 'in', price: 499.99 });
    await configure({ maxTotalPrice: 400 });
    await armRun('watching');
    await waitState((s) => s.events.some((e) => /above your max/.test(e.text)), 'over-price event');
    await stays('watching', 2500);
    store.set({ price: 349 });
    await waitState((s) => s.status === 'awaiting_user', 'hand-off at the lower price', 10000);
    await disarmRun();
  });

  await step('client-rendered store: switches to page reloads, then catches the restock', async () => {
    store.reset();
    await configure({ productUrl: `${BASE}/store/spa.html` });
    const t0 = Date.now();
    await armRun('watching');
    await waitUntil(async () => (await watchInfo())?.method === 'reload', { timeout: 12000, what: 'switch to reload mode' });
    await waitUntil(() => pageGets(t0, '/store/spa.html').filter((r) => r.mode === 'navigate').length >= 3,
      { timeout: 12000, what: 'reload checks' });
    store.set({ stock: 'in' });
    await waitState((s) => s.status === 'awaiting_user', 'hand-off', 12000);
    await disarmRun();
  });

  await step('scheduled drop: corrects for a store clock 3 s ahead and fires on time', async () => {
    store.reset();
    const skew = 3000;
    const dropTime = Date.now() + 16_000;
    const storeDropReal = dropTime - skew; // when the store's own clock reads dropTime
    store.set({ skewMs: skew, dropAt: storeDropReal });
    await configure({ triggerMode: 'scheduled', dropTime, burstIntervalSec: 1, burstWindowSec: 5 });
    await armRun('waiting');
    const w = await waitUntil(async () => {
      const info = await watchInfo();
      return info && info.clockOffsetMs !== null ? info : null;
    }, { timeout: 15000, what: 'clock check' });
    assert.ok(w.clockOffsetMs <= skew && skew - w.clockOffsetMs <= 400, `estimated offset ${w.clockOffsetMs} ms (true ${skew})`);
    assert.ok(store.requests((r) => r.method === 'HEAD').length >= 3, 'HEAD samples');

    const s = await waitState((x) => x.status === 'awaiting_user', 'hand-off after the drop', 20000);
    assert.ok(s.firedAt, 'fired');
    const reload = pageGets(storeDropReal - 2000).find((r) => r.mode === 'navigate');
    const error = reload.t - storeDropReal;
    console.log(`      fire precision vs the store's drop moment: ${error >= 0 ? '+' : ''}${error} ms (clock estimate ${w.clockOffsetMs} ms)`);
    // Never early (small slack for timer/network jitter), and well under a second late.
    assert.ok(error >= -30 && error <= 600, `fired ${error} ms from the store's drop moment`);
    await disarmRun();
  });

  await step('scheduled drop: not live yet at T -> fast burst checks until it is', async () => {
    store.reset();
    const dropTime = Date.now() + 11_000;
    store.set({ dropAt: dropTime + 3000 }); // the store is 3 s late
    await configure({ triggerMode: 'scheduled', dropTime, burstIntervalSec: 1, burstWindowSec: 6 });
    await armRun('waiting');
    const s = await waitState((x) => x.status === 'awaiting_user', 'hand-off', 25000);
    const burst = pageGets(dropTime + 200).filter((r) => r.mode === 'cors' && r.t < dropTime + 3000);
    assert.ok(burst.length >= 2, `only ${burst.length} burst checks`);
    assert.ok(gapsOf(burst).every((g) => g >= 900), `burst gaps ${gapsOf(burst).join(', ')} ms`);
    // Only this run's events: the log carries over from earlier runs.
    const live = s.events.filter((e) => e.t >= dropTime && e.text.startsWith('In stock')).at(-1);
    assert.ok(live, 'an "In stock" event from this run');
    const lag = live.t - (dropTime + 3000);
    console.log(`      handed off ${lag} ms after the store went live`);
    assert.ok(lag >= 0 && lag < 2500, `handed off ${lag} ms after the store went live`);
    await disarmRun();
  });

  await step('no errors logged by the service worker', async () => {
    assert.deepEqual(swErrors, []);
  });

  console.log(`\n${results.length} e2e steps passed.`);
} catch (e) {
  failed = true;
  if (!String(e.message).startsWith('Timed out') && !(e instanceof assert.AssertionError)) console.error(e);
} finally {
  await cleanup();
  process.exit(failed ? 1 : 0);
}
