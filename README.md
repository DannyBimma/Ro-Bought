# Ro-Bought
A Chrome extension that gives regular honest users the power to combat scalpers, and purchase a desired product at bot speed.

It watches **one product** from **one retailer** at any given time. The moment the product can be bought, it runs
the retailer's normal checkout in the user's own **logged-in session**, faster than you could
click. It buys **one unit, once**, and then stops.

> **Status:** All 5 phases complete (v0.5.0). The build plan is in [docs/PLAN.md](docs/PLAN.md) and
> the security review in [SECURITY.md](SECURITY.md).

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

## How checkout works

When the product can be bought, Ro-Bought clicks through the store's normal checkout:
**Add to cart → cart → checkout steps ("Use this address", "Use this payment method", …) → final review.**

- **Stop one click short (the default):** at the final review it highlights the **Place order** button
  and hands over to you. When the confirmation page appears, the run finishes.
- **Automatic purchase (opt-in, needs a max price):** it clicks **Place order** only if all of
  these hold:
  - the order total is shown and is at or below your max;
  - the cart was checked and holds exactly this one product, quantity 1;
  - it hasn't already clicked Place order in this run.

  That last check is a once-only lock, saved before the click, so a reload, crash or restart can
  never cause a second order. If the order doesn't confirm, it hands over to you and does not retry.
- **What it never does:** type anything (cards, passwords, codes), click "Buy now" / "Order now" /
  1-Click, accept upsells, trials or warranties, or remove items from your cart. Anything unexpected
  pauses (fix it and click **Resume**) or hands the purchase to you.
- **Why not "Buy now" / "Order now"?** On Amazon these can be an instant purchase that skips the
  review page, and with it the max-price check, the one-item check and the once-only lock. So
  Ro-Bought always goes through the cart, even when a quicker-looking button exists.
- **Your cart must be empty.** When you arm, Ro-Bought reads your cart once in the background and
  warns you straight away if anything is in it. On Amazon, "Save for later" moves items out of the
  cart without deleting them. During checkout it pauses if the cart holds anything else.
- **When Add to cart is hidden**, Ro-Bought pauses so you can reveal it, then you click Resume.
  Two common causes:
  - A Prime deal selects the Prime price, so Amazon shows "Join Prime" instead of Add to cart.
  - A pop-up covers the button. If the pop-up has an obvious close / "No thanks" / "Not now"
    button, Ro-Bought closes it itself.

  To skip the pause on drop day, teach **"Click first, before Add to cart"**: pick the
  **Regular price** option (click its text) or the pop-up's close button. Ro-Bought then clicks it
  before Add to cart, and leaves an option alone if it's already selected. "Join Prime" can't be
  taught.
- If the item sells out again between "in stock" and "add to cart", it goes back to watching.

### Store presets and "Teach buttons"

- **Amazon.com** and **Nintendo's US store** (`nintendo.com/us/store`) have built-in presets. They're
  written from these stores' known page structure but haven't been checked against the live sites, so
  **do a dry run first** with "Stop one click short" ticked.
- For **any store** (and to make the presets exact), teach Ro-Bought the real buttons:
  1. Open the store in a tab, click ⚡ → **Teach buttons**.
  2. Click **Pick** next to a button, then click that button on the page. Ro-Bought remembers it,
     and nothing on the page is pressed while picking.
  3. Add the product to your cart and walk through checkout to the final review page, picking each
     button on the way. **Don't place the order.** **Test** shows what Ro-Bought would click.

  Taught buttons always win over the presets. Clear them in the options.

  Tips:
  - Each step has its own button. Don't teach one button for two steps; Ro-Bought warns if you do.
  - **Proceed to checkout** is the cart page's button, and **Place order** is the final review page's
    button.
  - **Copy page report** (in the teach panel) copies a list of the buttons, pop-ups and frames
    Ro-Bought sees on the current page: labels and ids only, no page text, digits masked. Paste it to
    the developer when a step stalls.
- **Guest checkout can't be automated.** It needs your address and card typed in, and Ro-Bought never
  types those. For Nintendo, create a Nintendo Account with a saved address and payment method, and
  sign in before the drop. A taught "Guest checkout" button is harmless for signed-in users (it isn't
  on their page, so the built-in buttons are used), but it won't get a guest through checkout.

## Notifications: sound, Google Alerts and reminders

All in the options page under **Notifications**. You can change them even while a run is active.

- **Sound:** a short alert when Ro-Bought needs you (a pause, or the final click), finds stock, or
  places an order. **Test sound** plays it. Switch it off if you prefer silence.
- **Google Alerts:** hear about a drop or restock the moment it's announced.
  1. **Copy and open Google Alerts** opens Google Alerts with a ready-made search for your product
     (also copied to your clipboard). Click **Create alert** for email alerts.
  2. Optional: to get alerts in Chrome as well, choose **Show options → Deliver to → RSS feed**,
     create the alert, and paste the RSS link into Ro-Bought. It checks the feed every 30 minutes and
     notifies you of new results. Clicking a notification opens the article.
- **Reminders:** for a scheduled drop, **Add to Google Calendar** or **Download .ics** (Apple Calendar,
  Outlook) creates an event from 10 minutes before the drop with an alarm. Ro-Bought also notifies you
  two minutes before the drop.
- **Activity:** the options page shows the full activity log, with **Copy log** for sharing when
  something looks wrong.

## What users must do during a drop

- Keep **Chrome open** and the retailer tab **in the foreground**. Chrome slows down timers in
  background tabs.
- Keep the computer **awake and plugged in**. The extension asks the OS to keep the display awake
  while armed, but it can't stop a closed lid or a manual sleep.
- Be **signed in** to the retailer with a **saved address and payment method**, and **empty your
  cart** beforehand. Extensions can't read Chrome's saved cards, by design.
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

## Troubleshooting

- **"Ro-Bought can't reach the retailer tab":** the tab was closed, discarded, or the computer slept.
  Reload the store tab (or Disarm and Arm again).
- **It paused and I don't know why:** read the pause message in the ⚡ panel or the popup, and the
  **Activity** log in the options. Pauses always say what to do next.
- **A checkout step stalls on a store:** teach that step's button (⚡ → **Teach buttons**). If it still
  stalls, use **Copy page report** in the teach panel and share it with the developer.
- **Add to cart is "hidden":** the store is showing a pop-up or a buying option (such as a Prime deal)
  over it. Pick the regular-price option or close the pop-up, then Resume. Teach it as "Click first,
  before Add to cart" to make it automatic.
- **"Your cart already has N items":** empty the cart before the drop (on Amazon, "Save for later").
- **No sound:** check the Notifications switch and **Test sound**, and that your Mac isn't muted.
- **The Google Alerts feed shows an error:** paste the feed link again and click **Save notification
  settings**. Chrome asks for access to Google Alerts feeds once.
- **e2e tests show a macOS Keychain prompt:** click Deny. The test launcher uses `--use-mock-keychain`
  so it shouldn't appear.

## Development

There's no build step and no dependencies. Plain JavaScript runs as-is.

```sh
npm test          # unit tests: guards, config, timing, availability, alerts, service worker logic
npm run e2e       # end-to-end in a real browser (needs CHROME_PATH, see below)
npm run serve     # fixtures + mock store on http://localhost:8080 for trying things by hand
npm run icons     # regenerate extension/icons/*.png
```

The unit tests run the real `service-worker.js` against an in-memory fake of the `chrome.*`
APIs (`tests/fake-chrome.js`). Node 22+ is required.

### Rehearsing a drop with the mock store

`npm run serve` also runs a fake store, with a full checkout (cart → address → payment → review →
"Place your order" → thank-you page), whose behaviour you control from a browser tab:

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
   - `placeFails=1`: "Place order" fails.
   - `addFails=1`: sold out at add-to-cart.
   - `placeLabel=Finish`: the final button has wording only a taught button matches.
   - `promo=simple` / `promo=stubborn`: a deal pop-up hides Add to cart (with or without a "No thanks").
   - `promo=radio`: Prime-deal buying options, with the Prime price selected (shows "Join Prime");
     picking "Regular price" reveals Add to cart.
   - `bankCheck=1`: a 3-D Secure frame on the final review.
   - `reset=1`: start over.
6. `http://localhost:8080/__control` shows the store state, including the cart and how many orders were
   placed. `http://localhost:8080/__control/log` lists the requests the store received.

### End-to-end tests

The e2e test loads the extension into **Chrome for Testing**, serves the fixture pages in
`tests/fixtures/` (CAPTCHA, queue, sign-in, event pages and so on) plus the mock store, and drives
everything over the DevTools protocol. It runs a throwaway copy of the extension with the polite
interval floors lowered so it finishes in a few minutes. Regular Chrome ignores
`--load-extension`, so install Chrome for Testing once. The harness launches it with
`--use-mock-keychain`, so it never asks for your macOS login password. If an older run left a
"Chromium Safe Storage" Keychain prompt, click Deny.

```sh
npx @puppeteer/browsers install chrome@stable
CHROME_PATH="/path/to/Google Chrome for Testing" npm run e2e     # HEADED=1 to watch it
```

## License

GPL-3.0. See [LICENSE](LICENSE).
