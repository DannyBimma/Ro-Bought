# Ro-Bought — Build Plan

An unpacked Manifest V3 Chrome extension that watches **one product page** at **one
retailer**. When the product can be bought, it runs the retailer's normal checkout in
the user's own logged-in session, faster than a person could click. It buys **one unit,
once**, and then stops.

Plain JavaScript only, with no build step and no runtime dependencies. Load it from
`chrome://extensions` → Developer mode → Load unpacked → select the `extension/` folder.

---

## 1. Architecture decisions

### 1.1 Where the precise clock lives: the retailer tab's content script

| Option | Verdict |
| --- | --- |
| Background service worker | ❌ Chrome stops it after ~30 s idle, so its timers can't be trusted. |
| `chrome.alarms` | ❌ Minimum period is ~30 s and alarms fire late. Only good for coarse wake-ups. |
| Offscreen document | ⚠️ Stays alive, but it **can't touch the retailer page**, so every action needs an extra message hop. It is also a hidden document, so its timers aren't guaranteed to be precise. Chrome allows only one, and it needs a justified `reason`. |
| **Content script in the retailer tab** | ✅ **Chosen.** It runs in the same page it has to click. A foreground tab gets full-precision timers and `requestAnimationFrame`, and there's no message hop at the moment that matters. |

Each part has one job:

- **Content script (the executor):** keeps the millisecond countdown, checks
  availability, runs the checkout steps and the page safety guards.
- **Service worker (the coordinator):** the only process that writes run state. It handles
  arm/disarm, the once-only purchase lock, notifications, content-script registration,
  coarse alarms (2-minute pre-drop warning and a 1-minute watchdog), and keeping the
  machine awake.
- **Offscreen document:** used only to play an audible alert (`AUDIO_PLAYBACK`) when the
  bot hands control back to the user. It is not used for timing.

Precise-fire algorithm (built in Phase 3, `content/clock.js` + `shared/timing.js`):

1. At T−60 s, send five `HEAD` requests to the product URL, 1.2 s apart (so they land at
   different sub-second phases). Each `Date` header (1-second resolution) bounds the clock offset
   to an interval, and the intersection of those intervals narrows it to a few hundred ms.
   Cached responses (`Age > 0`) are ignored.
2. Use the interval's **low end**: the latest moment by which the store's clock has certainly
   reached T. The bot is never early. A fraction of a second late costs nothing, while early
   means the first reload still shows "out of stock". In e2e tests against a store clock 3 s
   ahead, it fired +65 to +153 ms after the store's moment. Users can add a manual fire offset.
3. Wait with timers in ≤30 s chunks, re-anchored each time so sleep or clock changes are
   corrected. Switch to `requestAnimationFrame` for the last 1.5 s, then a `MessageChannel`
   macrotask loop for the last ~20 ms.
4. At T, tell the service worker (waiting → watching, burst window starts) and reload the
   product page; that page load is the first check. If the product isn't buyable yet, run a
   polite **burst window** (every ≥2 s plus jitter, up to 10 min), then fall back to the restock
   interval.

### 1.2 Least-privilege permissions

- Required: `storage`, `alarms`, `notifications`, `scripting`, `activeTab`, `power`,
  `offscreen` (offscreen is added in Phase 5).
- **No blanket host access.** `optional_host_permissions` declares `https://*/*`, but the
  extension asks only for the **configured retailer's site**, at the moment the user saves
  the options. "Site" means the bare host plus its `www.` variant (`amazon.com` +
  `www.amazon.com`) and nothing broader. It removes the old site's access when the retailer
  changes.
- Content scripts are registered **dynamically** (`chrome.scripting.registerContentScripts`)
  for that one site, so the extension runs nowhere else.
- No `tabs` permission. Host permission for the retailer is enough to find and focus its tab.
  When the tab leaves the retailer, Chrome hides its URL from us, and that alone tells us it's
  off-site. `activeTab` is enough for the popup's ticket-site check.
- No remote code, no `eval`, and the default MV3 CSP.

### 1.3 State and the once-only guarantee

- `chrome.storage.local` holds `config` (written by the options page) and `runState`
  (written **only** by the service worker, through a serialized promise queue so writes
  can't race).
- Run statuses: `idle → armed → (waiting | watching) → executing → (paused | awaiting_user)
  → completed | aborted | error`.
- **Purchase lock:** before the final "Place order" click, the content script has to *claim*
  the lock from the service worker. The service worker allows one claim per run. A claimed
  lock moves the run to `completed` and blocks re-arming until the user explicitly
  clicks **"Reset for a new run"**. A page reload or service-worker restart can't cause a
  second purchase.
- Cart guard: the bot aborts if the cart quantity isn't 1 or the cart holds other items.
  Optional **max total price** ceiling, which is **required** when fully automatic purchase is on.

### 1.4 Safety guards (these are ground rules, not options)

| Guard | Behaviour |
| --- | --- |
| Ticket sites | Hard blocklist of major ticket brands, plus any hostname label containing `ticket`. These are refused in options, when arming, in the popup ("disabled on ticket sites") and again at runtime in the content script. |
| Ticket products | Refused if the product URL, the name, or the page's structured data (`schema.org` `Event`, `og:type=event`, ticket keywords) indicates a ticket. The user is told why. |
| CAPTCHA / bot challenge | Detects reCAPTCHA, hCaptcha, Turnstile and Cloudflare interstitials, Arkose/FunCaptcha, PerimeterX ("press & hold"), DataDome, AWS WAF, Amazon's "type the characters" page, Akamai, Imperva, GeeTest, and generic "verify you are human" pages. Only **visible** widgets count, so the invisible reCAPTCHA badge doesn't trip it. The bot **pauses**, focuses the tab, sends a notification (a sound arrives in Phase 5), and **never interacts with the challenge**. |
| Queue / waiting room | Detects waiting-room and "you are in line" pages, and Amazon invitation-only items. Queue-it and similar services live on another site, which counts as leaving the retailer. Same response: pause and hand back to the user. |
| Sign-in / card details | A visible password or one-time-code field, Amazon's `/ap/` sign-in and verification pages, card-number/CVV fields and 3-D Secure frames all pause the run. The bot never types credentials or card data. |
| Leaving the site | If the run tab navigates off the retailer (queue, `accounts.nintendo.com`, PayPal, …), is closed, or is discarded, the run pauses. Coming back marks it "looks clear"; the user still decides when to resume. |
| Resume | **Resume** after a check clears. **Resume anyway** while it's still showing records that exact check (kind + rule + page) so it doesn't immediately re-pause. Any other check still pauses. |
| Fingerprinting | The extension never spoofs or changes the user agent, headers, fingerprint, or IP. It sends no proxy traffic. |
| One buyer | One configured product, one tab, one account (the one in the browser), one unit. |
| Polite network | Restock polling defaults to 45 s with ±20 % jitter, and the floor is 20 s. Exponential backoff on 429/503 honours `Retry-After`. The burst window is capped (≥2 s spacing, ≤10 min). |

### 1.5 Platform limits we tell the user about

The extension can't run while Chrome is closed or the machine is asleep. It can't keep a
hidden tab's timers precise, and it can't read Chrome's saved autofill cards. The address
and payment method must be saved **on the retailer account**. The extension mitigates what
it can:

- `chrome.power.requestKeepAwake('display')` while armed, released on disarm or completion.
- Sets `autoDiscardable: false` on the retailer tab so Memory Saver can't discard it.
- A notification when the retailer tab goes into the background (`visibilitychange`, at most
  once a minute), plus a watchdog alarm that warns if the tab goes quiet (for example, the
  machine slept).
- Google Alerts plus a calendar reminder so the user is at the machine for the drop (Phase 5).

### 1.6 Retailer adapters

Retailer page markup changes often, so hard-coded selectors break. The design:

- A **generic adapter** driven by CSS selectors stored in config: add-to-cart, cart
  quantity, proceed-to-checkout, saved address and payment indicators, order total, place
  order, and the order-confirmation marker.
- A **"pick element" helper**: in the retailer tab, the user clicks an element and its
  selector is saved. No coding needed.
- Availability is read from `schema.org` JSON-LD `offers.availability` first, then from the
  configured add-to-cart button state.
- **Presets for Amazon and Nintendo** ship best-effort default selectors, which the user can
  override with the picker. Every other store uses the generic adapter.
- Each step waits with a `MutationObserver` and a timeout. Every observer and timer is
  disconnected or cleared when it settles.

---

## 2. Phases

Each phase ends with a pause so you can review, change, and commit.

### Phase 1 — Scaffold, config, and safety core ✅
- `manifest.json` (MV3, least privilege, optional host permissions), icons.
- Shared classic-script modules under one `RoBought` namespace: constants, URL
  utilities, ticket guard, config schema/validation.
- Options page: product, trigger mode, timing, stop-one-click-short (default **on**), max
  price. Requests the retailer-origin permission on save, revokes the old origin, and shows
  the "keep Chrome open" notice.
- Service worker: serialized run-state store, Arm / Disarm / Reset, dynamic content-script
  registration, keep-awake, tab pinning (`autoDiscardable:false`), message-sender
  validation, and handling for a revoked permission.
- Popup: status, arm/disarm kill switch, ticket-site lockout, foreground notice.
- Content-script stub (handshake only).
- Node unit tests (`node --test`, zero deps) for the guard and the validation.

### Phase 2 — Content runtime and page guards ✅
- Site scope widened from one exact host to bare host + `www.` (Amazon redirects between them).
- Content runtime: handshake, page-level ticket detection (JSON-LD walked with a node budget,
  `og:type`, title/heading), and a guard detector (`content/guards.js`) re-run by a debounced
  `MutationObserver` while armed. Only the run's tab acts; other tabs on the same site stay dormant.
- Pause / clear / Resume / Resume-anyway in the service worker, plus pauses for leaving the site,
  a closed tab or a discarded tab. Resume reopens or reloads the tab when needed.
- In-page status panel in a **closed** shadow root. Its buttons ignore synthetic clicks.
- Heartbeat and visibility reports, a 1-minute watchdog alarm (only while armed), and
  notification cooldowns.
- Cleanup: observer, timers and listeners are released when the run stops, and the content script
  tears itself down if the extension is reloaded.
- Test harness pulled forward from Phase 3: `tools/serve.mjs`, fixture pages in `tests/fixtures/`,
  and `tests/e2e/run.mjs` (Chrome for Testing over CDP, zero dependencies).

### Phase 3 — Triggers ✅
- Arming goes straight to `waiting` (scheduled) or `watching` (restock).
- **Scheduled drop:** a 2-minute pre-warning alarm (notify, then focus the tab), the never-early
  clock offset, precise fire, `DROP_FIRED` → `watching` with a burst window, and an early-live
  check on page load.
- **Restock watch** (`content/watcher.js`): a same-origin `fetch` of the page source parsed with
  `DOMParser`, which never runs scripts or loads subresources.
  - If it says in stock, reload the page and confirm on the live page before acting.
  - If stock can't be read from the source (client-rendered stores), switch to page reloads, with a
    5 s "settle" wait for the buy button.
  - 429/503 back off exponentially and honour `Retry-After`. 403 or a challenge page in the source
    reloads the tab so the live guards can pause. A redirect off-site is shown to the user.
  - One AbortController per run; every sleep, fetch and frame wait is cancellable.
- **Stock detection** (`content/stock.js`, `content/adapters.js`): the Amazon.com adapter (buy box,
  `#availability`, marketplace-only = not a restock, price), the Nintendo US store (structured
  data and button), then JSON-LD offers → meta/microdata → the main buy button. If none of these
  is conclusive the result is `unknown`, never a guess. In stock above the max price keeps watching.
- **Static guard mode** for fetched HTML: only whole-page challenge markers count.
- **Hand-off:** until Phase 4, "in stock" → `awaiting_user`, with a requireInteraction notification
  and the tab focused. Guards, hidden-tab nags and the watchdog stand down while the user is in
  control.
- Watcher memory (method, back-off, clock offset, last result) lives in `storage.session`, so it
  survives the page reloads that are part of the run. The popup shows a live countdown or the
  last-check line.
- **Mock store** (`tools/mock-store.mjs`): server-rendered and client-rendered product pages, plus
  stock, price, scheduled go-live, clock skew and injected 429s, controlled via `/__control`.
  Drives 8 new e2e steps covering polite spacing, back-off, hand-off, price ceiling, reload
  fallback, clock skew and burst.

### Phase 4 — Checkout engine ✅
- **Stage machine** (`content/checkout.js`): each page load classifies itself, checking in this
  order: confirmation → product → interstitial → "added to cart" page → review (a Place order
  button is visible) → cart → checkout step. It then takes exactly one step. Single-page checkouts
  are followed in place (up to 8 steps per page). The engine gets one turn per page load plus one
  per Resume, so a state update can never repeat a click.
- **Finding buttons** (`content/finder.js`): taught selector (or its exact text) → retailer preset
  → exact-phrase text match. Every click candidate must be visible, enabled, and pass the hard
  **never-click** rules: "Buy now"/1-Click/turbo checkout, subscribe, free trial or Prime sign-up,
  warranty/protection add-ons. These rules apply even to taught buttons.
- **Guards before buying:**
  - the cart has exactly one line of quantity 1 (Amazon also checks the ASIN);
  - a product-page quantity picker is set to 1;
  - address and payment aren't shown as missing;
  - the order total is read (taught element → preset → "Order total" text) and is within the max.
  Extra items or a quantity above 1 pause the run. The bot never removes items itself.
- **Place order:** stop-one-click-short highlights the button (an overlay box; the page isn't
  modified) and hands off, and the run completes when the confirmation appears. Auto-purchase
  needs the **once-only purchase lock** from the service worker. The lock is checked again there
  (auto-buy on, total within max, not already taken) and persisted *before* the click.
  - With the lock taken, later page loads only watch for confirmation.
  - No confirmation → hand-off, never a retry.
  - Disarm or a Chrome restart after the lock → `aborted` (needs a Reset).
- **Loop and time limits:** at most 3 entries per stage and 5 minutes per checkout, then pause.
  Resume grants fresh attempts. Sold out at add-to-cart → back to `watching`.
- **Presets:**
  - **Amazon.com:** `#add-to-cart-button`; the cart at `/gp/cart/view.html` with
    `data-asin`/`data-quantity` checks; proceed and continue buttons; Place-order IDs; the grand
    total; `/gp/buy/thankyou`. A Prime interstitial or a duplicate-order page pauses.
  - **Nintendo US:** cart at `/us/cart/`, everything else generic. Its sign-in on
    `accounts.nintendo.com` pauses as off-site.
  - Both are best-effort and unverified against the live sites, so do a dry run first.
- **Teach mode** (`content/teach.js`): ⚡ → Teach buttons opens a panel on the store page with
  Pick and Test per button. Pick swallows the page's pointer and click events in the capture
  phase, so nothing is pressed. It refuses never-click buttons. Selectors prefer stable ids, test
  ids and names over position paths. The options page lists and clears taught buttons. They're
  kept when settings are re-saved and dropped if the store changes.
- **Mock store checkout** plus 11 new e2e steps: one order exactly; over the max at review;
  extra cart items → pause → fix → Resume → buy; a CAPTCHA at review; a failed Place order
  clicked once and never retried; a sold-out race → re-watch → buy; a teach pick that doesn't
  press the button; teach refusing "Buy now"; a taught button needed for unfamiliar wording;
  the options page and popup rendering.

### Phase 4.1 — Fixes from the first live dry runs ✅ (this commit)
Found on Amazon.com and the Nintendo US store with "Stop one click short" ticked:
- **False "3-D Secure" pause on an Amazon product page.** Ad frames carry long encoded names that
  contained "3ds" by chance.
  - The bank-check rule now matches whole tokens in a frame's id, title, short name or address, plus
    known 3-D Secure providers.
  - Card and bank checks run only during checkout (past the product page).
  - The e2e covers an Amazon-style ad frame on every product page and a real "3-D Secure" frame at review.
- **Add to cart hidden behind a Prime deal pop-up.** Previously this was taken for "sold out" and
  would have looped back to watching.
  - The engine now tells "hidden" from "absent". It closes a pop-up via a taught button or an
    obvious close / "No thanks" / "Not now", and otherwise pauses with a clear message.
  - New teachable step, "Click first, before Add to cart". It covers a pop-up's close button
    or a buying option. The re-test showed the real cause was a radio, not a pop-up: during a
    Prime deal the Prime price is pre-selected and "Regular price" reveals Add to cart. Teach mode
    resolves a click on an option's text to its `<label>`, and the engine leaves an
    already-selected option alone. Mock store `promo=radio` plus an e2e step cover it.
- **"Order now" taught as Proceed to checkout and Place order.**
  - "Order now", "Buy it now" and Amazon's `buy-now` ids are now never-click. "Pre-order now" is
    still allowed.
  - The check covers Amazon's button wrapper, where the visible label sits beside the real input.
  - A page only counts as the final review after the cart was checked (or on a known checkout
    address), and the service worker refuses the purchase lock until then.
  - Teaching one button for two steps shows a warning.
- **Other items in the Amazon cart.** Arming now reads the cart once in the background and warns
  straight away, rather than pausing mid-drop.
- **Nintendo guest checkout.** It can't be automated (it needs typed details); documented.
  Signed-in checkout is unaffected by a taught "Guest checkout" button.
- **Teach panel → Copy page report:** labels, ids, pop-ups and frames (no page text, digits masked),
  for diagnosing live pages remotely.
- **Robustness:**
  - A tab that becomes the run tab after its first hello re-introduces itself. This closes an
    arm-time race.
  - Content-script start-up failures are logged instead of failing silently.
  - The e2e launches Chrome for Testing with `--use-mock-keychain`, so it never prompts for the
    macOS Keychain.

### Phase 5 — Alerts and polish
- Google Alerts: build a good query, open `google.com/alerts` prefilled (the user confirms;
  there is no Alerts API). Optionally watch the alert's **RSS feed** URL (a
  `google.com/alerts/feeds/*` optional permission, polled every 30 min) and send a
  notification when there are new items.
- "Add drop to Google Calendar" link for scheduled drops.
- Offscreen-document audible alert.
- Activity log viewer, README hardening, a final security pass.
