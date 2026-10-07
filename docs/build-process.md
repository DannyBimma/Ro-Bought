# Ro-Bought: build process and developer guide

This guide is for people working **on** Ro-Bought: changing the code, running the tests, or
preparing a release. To simply **use** the extension, see the main [README](../README.md).

Related documents:
- [PLAN.md](PLAN.md): the phased build plan, architecture decisions and what each phase delivered.
- [SECURITY.md](../SECURITY.md): the security review, threat model, permissions and stored data.

## At a glance

- A **Manifest V3** Chrome extension written in **plain JavaScript**. There's no build step,
  bundler, framework or runtime dependency: the `extension/` folder is loaded into Chrome as-is.
- **Node 22+** is needed only for the tests and dev tools. `npm install` isn't required (there are no
  dependencies).
- Modules are classic scripts that share one global namespace, `RoBought`, loaded in a fixed order.
  This lets the same files run in the service worker (`importScripts`), extension pages (`<script>`),
  content scripts (the isolated world) and Node (`vm`, for unit tests).

## Project structure

```
extension/                  ← the extension (load this folder in Chrome)
  manifest.json
  background/service-worker.js   coordinator: run state, purchase lock, alarms, notifications, alerts feed
  content/                  runs in the store tab only
    main.js                 handshake, guard observer, heartbeat, panel wiring
    guards.js               CAPTCHA / bot-check / queue / sign-in / payment / ticket detection
    watcher.js, clock.js    restock checks, scheduled-drop countdown and precise firing
    stock.js, adapters.js   stock reading; Amazon.com, Nintendo US and generic store adapters
    checkout.js, finder.js  the checkout engine and button finding (incl. never-click rules)
    teach.js, overlay.js    "Teach buttons" mode and the in-page status panel
    dom.js                  small DOM helpers
  shared/                   loaded everywhere (and in Node tests)
    constants.js, config.js, url-utils.js, ticket-guard.js,
    timing.js, availability.js, alerts.js
  options/, popup/          the settings page and the toolbar popup
  offscreen/                hidden page that plays the alert sound
  icons/                    generated PNGs (see "Icons")
tests/
  *.test.js                 unit tests (node --test)
  fake-chrome.js            in-memory fake of the chrome.* APIs used by the service worker
  load-shared.js            loads extension/shared/*.js into Node
  e2e/run.mjs               end-to-end test in Chrome for Testing
  fixtures/                 pages imitating CAPTCHAs, queues, sign-in, ticket pages, …
tools/
  serve.mjs                 local server for the fixtures + mock store
  mock-store.mjs            a fake store with controllable stock, failures and checkout
  make-icons.mjs            draws the 🤖 icons
docs/
  PLAN.md, build-process.md
```

## Loading a development copy

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the
   `extension/` folder.
2. After changing code, click the **reload** arrow on Ro-Bought's card. Content-script changes take
   effect on the next page load in the store tab.
3. Debugging:
   - **Service worker:** click "service worker" on the extension card to open its DevTools.
   - **Content scripts:** in the store tab's DevTools, choose the "Ro-Bought" context in the
     console dropdown.

## Scripts

```sh
npm test          # unit tests: guards, config, timing, availability, alerts, service worker logic
npm run e2e       # end-to-end in a real browser (needs CHROME_PATH, see below)
npm run serve     # fixtures + mock store on http://localhost:8080 for trying things by hand
npm run icons     # regenerate extension/icons/*.png
```

## How it works (technical summary)

[PLAN.md](PLAN.md) has the full design. In short:

- **Responsibilities:**
  - **Content script (the executor):** keeps the precise clock, checks stock, runs checkout steps
    and page guards.
  - **Service worker (the coordinator):** the only writer of run state. It owns arm/disarm, the
    once-only purchase lock, notifications, alarms (2-minute pre-drop warning, 1-minute watchdog,
    30-minute alerts feed), keep-awake, and content-script registration.
  - **Offscreen document:** plays sounds only.
- **Restock watch:**
  - Every interval (default 45 s, ±20 % jitter, never under 20 s) it fetches the product page's
    source and parses it with `DOMParser`.
  - Client-rendered stores switch to page reloads.
  - "In stock" in the source is confirmed on the live page before acting.
  - HTTP 429/503 back off exponentially, honouring `Retry-After`.
- **Scheduled drop:**
  - At T−60 s, five `HEAD` requests estimate the store's clock offset from the `Date` header.
    The estimate uses the low end of the uncertainty window, so it's never early.
  - The countdown uses chunked timers, then `requestAnimationFrame`, then a `MessageChannel` loop.
  - At T it reloads, then runs a burst window of fast, polite retries before falling back to the
    restock interval.
- **Checkout:**
  - A stage machine across page loads: product → cart → checkout steps → review → confirmation.
  - Buttons come from taught selectors, then retailer presets, then exact-text matches, always
    filtered by the never-click rules.
  - "Place order" requires the service worker's once-only lock: automatic purchase on, cart
    checked, total within the max.
- **Guards:** visible CAPTCHAs, bot checks, queues, sign-in, card fields, 3-D Secure, leaving the
  site, a closed or discarded tab, and ticket pages → pause or abort and hand control back to the
  user.

## Unit tests

`npm test` runs the Node test runner over `tests/*.test.js`.

- **Shared modules** (`extension/shared/*.js`) are loaded into Node exactly as the browser loads them
  (`tests/load-shared.js`).
- **`service-worker.test.js`** runs the **real** `service-worker.js` against `tests/fake-chrome.js`.
  That's an in-memory fake of storage, tabs, alarms, notifications, permissions, scripting,
  offscreen and messaging, plus a stubbed `fetch` for the alerts feed.
- DOM-dependent code (content scripts, pages) is covered by the e2e test instead.

## Rehearsing with the mock store

`npm run serve` serves the fixture pages and a fake store, with a full checkout (cart → address →
payment → review → "Place your order" → thank-you page). You control its behaviour from a browser tab:

1. In the options, set the product URL to `http://localhost:8080/store/product.html`
   (or `/store/spa.html` for a client-rendered store), save, and arm.
2. Restock: open `http://localhost:8080/__control?stock=in` (and `?stock=out` to reset).
3. Scheduled drop: set the drop 2 minutes ahead in the options, arm, then open
   `http://localhost:8080/__control?dropIn=120` so the store goes live at the same moment.
   Add `&skewMs=3000` to give the store a clock 3 s ahead of yours.
4. Polite back-off: `http://localhost:8080/__control?fail=429:2:30` makes the next two checks
   answer "too many requests, retry in 30 s".
5. Checkout trouble, one switch at a time (add to `/__control?`):
   - `extraItem=1`: another item is already in the cart.
   - `reviewCaptcha=1`: a "press & hold" check on the final review.
   - `bankCheck=1`: a 3-D Secure frame on the final review.
   - `placeFails=1`: "Place order" fails.
   - `addFails=1`: sold out at add-to-cart.
   - `placeLabel=Finish`: the final button has wording only a taught button matches.
   - `promo=simple` / `promo=stubborn`: a deal pop-up hides Add to cart (with or without a "No thanks").
   - `promo=radio`: Prime-deal buying options, with the Prime price selected (shows "Join Prime");
     picking "Regular price" reveals Add to cart.
   - `reset=1`: start over.
6. `http://localhost:8080/__control` shows the store state (cart, number of orders);
   `http://localhost:8080/__control/log` lists the requests the store received.

The server listens on 127.0.0.1 only. Its control endpoints are unauthenticated by design, and
it is never shipped with the extension.

## End-to-end tests

`tests/e2e/run.mjs` loads the extension into **Chrome for Testing** and serves the fixtures plus the
mock store. It drives everything over the DevTools protocol (zero dependencies; it uses Node's
built-in `WebSocket`) and covers the guards, triggers, checkout, teach mode, sound, and the
options and popup pages.

- It runs a **throwaway copy** of the extension:
  - `localhost` is pre-granted, so no permission prompt appears;
  - the polite-interval floors are lowered so the run takes a few minutes;
  - a couple of checkout timeouts are shortened.

  The real `extension/` folder is never modified.
- Regular Chrome ignores `--load-extension`, so install Chrome for Testing once:

  ```sh
  npx @puppeteer/browsers install chrome@stable
  CHROME_PATH="/path/to/Google Chrome for Testing" npm run e2e     # HEADED=1 to watch it
  ```

- The harness launches Chrome with `--use-mock-keychain`, so on macOS it never asks for your login
  password ("Chromium Safe Storage"). If an older run left that Keychain prompt open, click **Deny**.
- It fails on any console error from the service worker, and checks that no Chrome processes are
  left behind.

## Icons

`npm run icons` draws the 🤖 robot (amber on teal) at 16, 32, 48 and 128 px into `extension/icons/`.
It uses only Node built-ins (zlib PNG encoding, supersampled shapes). To change the design, edit
`inRobot()` and the colours in `tools/make-icons.mjs`. The in-page panel shows the 🤖 emoji
(`content/overlay.js`).

## Releasing a version

1. Bump `version` in **both** `extension/manifest.json` and `package.json`.
2. Run `npm test` and `npm run e2e`.
3. Update `docs/PLAN.md` (what changed) and, if the attack surface changed, `SECURITY.md`.
4. Optionally, to make installation easier for non-technical users, attach a zip of just the
   `extension/` folder to a GitHub Release:

   ```sh
   cd extension && zip -r ../ro-bought-extension.zip . -x '.*' && cd ..
   ```

   Users unzip it and choose that folder in **Load unpacked**.

## Conventions

- Plain JavaScript, no dependencies, no build step. Keep it that way, so anyone can load the folder.
- Never use `innerHTML` or similar sinks. Build DOM with `createElement` and `textContent`.
- Every message handler validates its sender. Every value from a page or from storage is
  re-validated before use.
- Safety rules are not options: no CAPTCHA solving, no queue skipping, no spoofing, no event tickets,
  one unit once, and never-click instant-buy buttons. New features must keep them.
- Match the surrounding style: small modules on the `RoBought` namespace, a short comment for
  anything non-obvious, and a test for every behaviour that protects the user's money.
