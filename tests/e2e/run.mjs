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

const server = await startServer({ root: join(ROOT, 'tests', 'fixtures'), port: 0 });
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
  const waitState = (pred, what) => waitUntil(async () => {
    const s = await state();
    return pred(s) ? s : null;
  }, { what });
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
    await waitState((s) => s.status === 'armed', 'resume');
  };

  console.log(`Ro-Bought e2e — Chrome ${swTarget.url.split('/')[2]} on ${BASE}`);

  await step('configure + arm opens the product tab and connects', async () => {
    const reg = await sw(`
      await chrome.storage.local.set({ config: { productUrl: '${BASE}/product.html', triggerMode: 'restock' } });
      return await syncContentScripts();`);
    assert.equal(reg.registered, true, JSON.stringify(reg));
    assert.deepEqual(await sw('return await arm();'), { ok: true });
    await waitState((s) => s.status === 'armed' && s.tabId && connected(s), 'tab to connect');
  });

  await step('status panel renders in a closed shadow root', async () => {
    const p = await waitUntil(async () => {
      const r = await panel();
      if (r?.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
      return r?.present ? r : null;
    }, { what: 'panel' });
    assert.equal(p.shadowMode, 'closed');
    assert.ok(p.texts.includes('Armed'), p.texts.join(' | '));
    assert.ok(p.buttons.some((b) => b.action === 'disarm'));
  });

  await step('ordinary product page with hidden password field + invisible reCAPTCHA badge does not pause', async () => {
    await stays('armed');
    const presence = await sw("return (await chrome.storage.session.get('presence')).presence;");
    assert.ok(presence && presence.tabId === (await state()).tabId, 'presence recorded');
  });

  await step('book titled "The Waiting Room" (full page) does not pause', async () => {
    await go('/book.html');
    await stays('armed');
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
    const s = await waitState((x) => x.status === 'armed', 'resume via panel');
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
    await stays('armed');
  });

  await step('hidden reCAPTCHA frame stays ignored; revealing it later pauses', async () => {
    await go('/product.html?inject=recaptchaHidden');
    await stays('armed', 1200);
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
    const after = await waitState((x) => x.status === 'armed' && x.tabId !== before.tabId && connected(x), 'reconnect');
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
    await waitState((s) => s.status === 'armed' && connected(s), 'arm');
    await go('/guards/event.html');
    const s = await waitState((x) => x.status === 'aborted', 'abort');
    assert.match(s.message, /event or ticket/);
    assert.match((await sw('return await arm();')).error, /Reset for a new run/);
    assert.deepEqual(await sw('return await reset();'), { ok: true });
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
