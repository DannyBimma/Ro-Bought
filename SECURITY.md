# Ro-Bought security review

Final review for v0.5.0 (Phase 5). It covers the whole extension, not only the latest changes.

## What we protect against

| Threat | How it's handled |
| --- | --- |
| A website driving the extension | No `externally_connectable` and no `web_accessible_resources`, so pages can't message the extension or load its files. Content scripts run in Chrome's isolated world. |
| The store page tampering with Ro-Bought's UI | The status and teach panels live in **closed** shadow roots and ignore synthetic (`isTrusted: false`) clicks. |
| Buying more than intended | A once-only purchase lock is granted by the service worker and saved *before* the click. It's only granted with automatic purchase on, a checked cart, and a total read and within the max. A reload, crash or restart can never cause a second "Place order". |
| Instant purchases bypassing checks | "Buy now", "Order now", 1-Click and turbo-checkout controls are never clicked, even if taught. The check covers Amazon's split button markup. |
| Sign-ups and upsells | Trials, Prime sign-up, subscriptions, warranties and protection plans are on the never-click list. |
| Anti-bot controls | CAPTCHAs, bot checks, queues, sign-in prompts, card fields and 3-D Secure pause the run and hand control back. Ro-Bought never interacts with them. |
| Abuse of the store | Polite intervals with jitter, back-off on 429/503 that honours `Retry-After`, and one product, one account, one unit. No proxies, no spoofed headers or fingerprints. |
| Event tickets | Refused in the options, when arming, in the popup and at runtime (domains, URLs, product names, structured data). |

## Permissions (least privilege)

- `storage`, `alarms`, `notifications`, `scripting`, `activeTab`, `power`, `offscreen`. None of these
  shows a permission warning except notifications.
- **No host access at install.** `optional_host_permissions` lets the options page ask for exactly the
  configured store (bare host plus `www.`). The old store's access is removed when the store changes.
  Content scripts are registered dynamically for that site only.
- Google Alerts feed: `https://www.google.com/alerts/feeds/*`, requested only if you paste a feed link,
  and removed if you clear it.
- No `tabs`, `webRequest`, `cookies`, `history` or `<all_urls>`.

## Entry points (all validated)

| Entry | Validation |
| --- | --- |
| Service worker `runtime.onMessage` | Extension pages are identified by origin. Store-tab messages must come from the run tab's top frame on the configured site. Each sender type has its own allow-list of message types. Payloads are whitelisted and length-capped (`sanitizeGuard`, `sanitizeWatch`, `cleanText`). |
| Offscreen document | Accepts only `PLAY_SOUND` from the extension's own service worker (no tab sender). |
| Content script `runtime.onMessage` | Accepts only `TEACH_OPEN` from the extension itself (no tab sender), and only while no run is active. |
| Options and popup | Settings are rebuilt from known fields only (`config.validate`, so `__proto__` and unknown keys are dropped). Taught selectors are length-limited. The feed link must match the Google Alerts feed pattern. |
| Fetched HTML (stock checks, cart pre-flight) | Parsed with `DOMParser`, which never runs scripts or loads subresources. Size-capped. Only page-level challenge markers count in fetched pages. |
| Google Alerts feed | Fetched without cookies (`credentials: 'omit'`). Parsed by a linear-time, bounded parser in `shared/alerts.js` with no DOM. Titles become plain text; links are unwrapped from Google's redirect and kept only if `http(s)`. |

## Output and DOM

- No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` or
  string timers anywhere in `extension/`. All text is written with `textContent` or `createElement`.
- Extension pages use the CSP `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
  There are no inline scripts or inline event handlers.
- Links shown from feeds open with `rel="noopener noreferrer"`. Notification clicks open only
  re-validated `http(s)` URLs.

## Data stored (`chrome.storage`, on this machine only)

| Key | Contents |
| --- | --- |
| `config` | Product URL and name, trigger timing, max price, taught button selectors. |
| `runState` | Run status and a 50-entry activity log (product, prices, steps). |
| `alertSettings` / `alertState` | Sound on/off, Alerts query, feed link, recent result titles and links. |

There are **no passwords, card numbers, security codes, addresses or cookies**. Ro-Bought never reads
or types them. Nothing is sent anywhere except requests to the configured store and the Google Alerts
feed you supplied. The feed link works like a password for reading that alert's results, so treat it
accordingly.

Page reports (teach panel) are created only when you click the button. They contain button and frame
descriptions with digits masked, and you should glance at them before sharing.

## Fixed in this review

1. **The feed parser could take quadratic time on a malformed feed.** A feed full of unclosed `<entry>`
   tags made the old regex scan to the end of the input for every one. It now uses a linear
   `indexOf` scan and caps each entry at 20 KB, with a test using a 1.8 MB hostile feed.
2. **The generic "find the cart link" heuristic was too loose.** It accepted any same-site link whose
   path started with `/cart`, which could include a state-changing link such as `/cart/clear`. It now
   accepts only a plain cart page (`/cart`, `/basket/`, `/store/cart.html`) with no query string.

Fixed in earlier phases and covered by tests:
- notification icon path;
- content-script registration race;
- the invisible-reCAPTCHA false positive;
- the substring-based 3-D Secure false positive;
- the "Order now" never-click gap;
- hidden Add to cart being mistaken for "sold out";
- the arm-time handshake race.

## Known limits (by design or out of scope)

- The store's own pages are trusted to describe themselves honestly. A store could show a fake
  "order confirmed" page or hide stock. Ro-Bought acts only on the one store you chose, inside your
  own session.
- The Amazon and Nintendo presets are best-effort and not verified against every live variant. Teach
  buttons override them, and "Stop one click short" is the default.
- `chrome.storage` isn't encrypted beyond your OS account, which is why nothing sensitive is stored.
- Dev tools (`tools/`, `tests/`) are local-only. The mock store listens on 127.0.0.1, its
  control endpoints are unauthenticated by design, and it is never shipped with the extension.
