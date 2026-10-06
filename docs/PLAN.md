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

Precise-fire algorithm (Phase 3):

1. Estimate the offset between the local clock and the retailer's clock from the
   `Date` header on a few spaced `HEAD` requests. Users can also set a manual offset.
2. Use plain `setTimeout` until about T−2 s. After that, use `requestAnimationFrame`, then a
   `MessageChannel` microtask loop for the last ~16 ms.
3. At T, reload or re-check the product. If it isn't buyable yet, enter a short,
   polite **burst window** with retries every ≥2 s plus jitter for up to N minutes,
   then fall back to restock-watch cadence.

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

### Phase 2 — Content runtime and page guards ✅ (this commit)
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

### Phase 3 — Triggers
- Scheduled drop: service-worker pre-warning alarm (T−2 min), server-clock offset
  estimation, precise fire in the content script, polite burst window.
- Restock watch: same-origin `fetch` of the product page with the user's cookies, parsed
  with `DOMParser`. Interval plus jitter, 429/503 backoff with `Retry-After`, and an
  `AbortController` on every request.
- Availability detection (JSON-LD, then the selector).
- Local **mock store** (`tests/fixtures/store/`, served by `tools/serve.mjs`) with stock that
  can be toggled, so drops and restocks can be rehearsed without a real retailer.

### Phase 4 — Checkout engine
- Generic selector adapter, "pick element" helper, stage machine across page loads
  (product → cart → checkout → review → confirmation).
- **Amazon and Nintendo presets.** Amazon covers the add-to-cart and buy box, cart, and
  checkout/place-order pages. Nintendo covers the store product page, cart and checkout.
  Nintendo account sign-in is a hand-off.
- Cart guards (quantity 1, no other items), saved address/payment present, price ceiling.
- Stop-one-click-short (highlight the button, focus, notify) **or** claim the purchase lock,
  then place the order and verify the confirmation.
- End-to-end rehearsal against the mock store.

### Phase 5 — Alerts and polish
- Google Alerts: build a good query, open `google.com/alerts` prefilled (the user confirms;
  there is no Alerts API). Optionally watch the alert's **RSS feed** URL (a
  `google.com/alerts/feeds/*` optional permission, polled every 30 min) and send a
  notification when there are new items.
- "Add drop to Google Calendar" link for scheduled drops.
- Offscreen-document audible alert.
- Activity log viewer, README hardening, a final security pass.
