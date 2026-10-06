# Ro-Bought
A Chrome extension that gives regular honest users the power to combat scalpers, and purchase a desired product at bot speed.

It watches **one product** from **one retailer** at any given time. The moment the product can be bought, it runs
the retailer's normal checkout in the user's own **logged-in session**, faster than you could
click. It buys **one unit, once**, and then stops.

> **Status:** Phase 3 of 5. Safety core, page guards, and both triggers (scheduled drop and
> restock watch). When the product can be bought, Ro-Bought currently hands the checkout to you
> with a loud notification. Automatic checkout arrives in Phase 4. See [docs/PLAN.md](docs/PLAN.md).

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension/`** folder.
4. The options page opens. Enter the product URL and click **Save and grant site access**.
   Chrome asks for access to that one site only.
5. Pin the ⚡ icon and use the pop-up to **Arm** or **Disarm**.

After pulling new code, click the reload icon on the extension card in `chrome://extensions`.

## How the triggers work

- **Restock watch:** every interval (default 45 s, ±20 % jitter, never under 20 s), Ro-Bought
  quietly reads the product page's source in the background. If the store renders its stock with
  JavaScript (as Nintendo's store does), it reloads the page instead. When the product looks buyable,
  it reloads the page to confirm before acting. If the store answers "too many requests"
  (HTTP 429/503), it backs off and honours `Retry-After`.
- **Scheduled drop:** a minute before the drop it reads the store's clock (five `HEAD` requests)
  and corrects for any difference. It fires at the exact moment, never early, and reloads the page.
  If the product isn't live yet, it retries every few seconds for a short window, then falls back
  to the restock interval. A notification two minutes before the drop brings the tab to the front.
- **Max price:** if the product is in stock above your max, Ro-Bought keeps watching instead.

## What users must do during a drop

- Keep **Chrome open** and the retailer tab **in the foreground**. Chrome slows down timers in
  background tabs.
- Keep the computer **awake and plugged in**. The extension asks the OS to keep the display awake
  while armed, but it can't stop a closed lid or a manual sleep.
- Be **signed in** to the retailer with a **saved address and payment method**. Extensions can't
  read Chrome's saved cards, by design.
- If a CAPTCHA, "press and hold" check, queue/waiting room, sign-in or card-details prompt
  appears, or the tab leaves the store's site, the bot **pauses and hands control to you**. It never
  tries to get around these. Deal with it yourself, then click **Resume** in the ⚡ panel in the
  corner of the store page or in the pop-up.

## Ground rules (enforced in code)

- No CAPTCHA solving, no queue skipping, no fingerprint, header, or IP spoofing, no proxies.
- One account, one product, one unit, one purchase per run. Re-arming after a finished run
  needs an explicit reset.
- **No event tickets.** Ticket sites and ticket listings are refused everywhere: in the options,
  when arming, in the pop-up, and at runtime. Automated ticket buying is restricted by law in many
  places (for example, the US BOTS Act 2016).
- Polite polling. Restock checks run every ≥20 s (default 45 s ±20 % jitter), retries after a
  drop run every ≥2 s within a capped window, and the bot backs off on HTTP 429/503.

## Development

There's no build step and no dependencies. Plain JavaScript runs as-is.

```sh
npm test          # unit tests: guards, config, timing, availability, service worker logic
npm run e2e       # end-to-end in a real browser (needs CHROME_PATH, see below)
npm run serve     # fixtures + mock store on http://localhost:8080 for trying things by hand
npm run icons     # regenerate extension/icons/*.png
```

The unit tests run the real `service-worker.js` against an in-memory fake of the `chrome.*`
APIs (`tests/fake-chrome.js`). Node 22+ is required.

### Rehearsing a drop with the mock store

`npm run serve` also runs a fake store whose stock you control from a browser tab:

1. In the options, set the product URL to `http://localhost:8080/store/product.html`
   (or `/store/spa.html` for a client-rendered store), save, and arm.
2. Restock: open `http://localhost:8080/__control?stock=in` (and `?stock=out` to reset).
3. Scheduled drop: set the drop 2 minutes ahead in the options, arm, then open
   `http://localhost:8080/__control?dropIn=120` so the store goes live at the same moment.
   Add `&skewMs=3000` to give the store a clock 3 s ahead of yours.
4. Polite back-off: `http://localhost:8080/__control?fail=429:2:30` makes the next two checks
   answer "too many requests, retry in 30 s".
5. `http://localhost:8080/__control/log` lists the requests the store received.

### End-to-end tests

The e2e test loads the extension into **Chrome for Testing**, serves the fixture pages in
`tests/fixtures/` (CAPTCHA, queue, sign-in, event pages and so on) plus the mock store, and drives
everything over the DevTools protocol. It runs a throwaway copy of the extension with the polite
interval floors lowered so it finishes in about a minute and a half. Regular Chrome ignores
`--load-extension`, so install Chrome for Testing once:

```sh
npx @puppeteer/browsers install chrome@stable
CHROME_PATH="/path/to/Google Chrome for Testing" npm run e2e     # HEADED=1 to watch it
```

## License

GPL-3.0. See [LICENSE](LICENSE).
