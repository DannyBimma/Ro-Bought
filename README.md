 # 🤖 Ro-Bought

**A purchase bot that gives innocent consumers a chance to beat rotten, dirty scalpers at their own game.**

A free and open source add-on/extension for Google Chrome. It watches **one product** on **one online store** at
a time for the user. The instant a targeted product can be bought, it goes through the store's checkout procedure using
a **logged-in account** faster than any human, and matching the speed of the fastest horse in a scalper’s stable. It buys
**one unit of one item, once**, and then stops. This tool is strictly designed to beat soulless resellers, without giving users
the power to become the very thing they swore to destroy.  

It was inspired by the scalp rats who have bought the Nintendo Switch 2 Zelda special edition out to oblivion. And for 
everyday consumers who keep losing sneakers, consoles and collectibles to grimy resellers' bots. It is **not** a scalping
tool and it adheres to online consumer laws and etiquette: it refuses to buy event tickets, never goes around CAPTCHAs or
queues, and only ever buys one item for one person.

By default it will stop **one click short** of clicking purchase (this can be configured in the options). After it fills the cart and
walks through the checkout process, highlights the final **”Place Order”** button, and alerts the user to click it. Fully automatic
purchasing is there if the user so desires, with strict safety checks and guardrails on spending.

---

## Contents

1. [What you need](#what-you-need)
2. [Install Ro-Bought (Windows, Mac, Linux)](#install-ro-bought)
3. [Your first run, step by step](#your-first-run-step-by-step)
4. [Settings explained](#the-settings-explained)
5. [Drop day: checklist](#on-drop-day-checklist)
6. [Reading the 🤖 icon and the status panel](#reading-the--icon-and-the-status-panel)
7. [Ro-Bought pauses (and what to do)](#when-ro-bought-pauses)
8. [Teach buttons: making it work on any store](#teach-buttons)
9. [Notifications: sound, Google Alerts and calendar reminders](#notifications)
10. [Store tips: Amazon, Nintendo and others](#store-tips)
11. [Ro-Bought rules](#what-ro-bought-will-never-do)
12. [Privacy](#privacy)
13. [Troubleshooting](#troubleshooting)
14. [Updating or removing Ro-Bought](#updating-or-removing-ro-bought)
15. [For devs](#for-developers)

---

## What you need

- A **computer** running Windows, macOS or Linux. Phones and tablets can't run Chrome add-ons.
- **Google Chrome**, free from [google.com/chrome](https://www.google.com/chrome/). Other browsers
  built on Chrome (Microsoft Edge, Brave) may work but I have not and do not care to use or test them.
- An **account at the store** you're buying from, with your **delivery address and payment card saved** 
  in that account. Ro-Bought **NEVER** inputs or saves card numbers or passwords, so they must already be
  saved within an account on the store itself.
- A few minutes to set things up, and ideally a **practice run** before the real drop.

## Install Ro-Bought

Ro-Bought isn't on the Chrome Web Store. So you have to load it into Chrome yourself, which should take about
two minutes for a complete noob (no offence to noobs). Chrome calls this process ”loading an unpacked extension",
and it's completely normal for cool add-ons like this that people get from GitHub.

### 1. Download it

1. On this GitHub page, click the green **Code** button, then **Download ZIP**.
2. Find the downloaded file (usually in your **Downloads** folder). It's should called:
   `Ro-Bought-main.zip`. Or something of the like.

### 2. Unzip it

| Windows | Mac | Linux |
| --- | --- | --- |
| Right-click the ZIP → **Extract All…** → **Extract**. | Double-click the ZIP. A folder appears next to it. | Right-click the ZIP → **Extract Here** (or run `unzip Ro-Bought-main.zip` in a terminal). |

You should now have a folder called **Ro-Bought-main**.

> **Important:** DO NOT leave this folder in downloads. Move somewhere it can live
> permanently on your machine, such as your **Documents** folder, before the next step.
> Chrome runs Ro-Bought straight from this folder. If you delete or move it later,
> Ro-Bought stops working, and you'd need to load it again (and redo your settings).

Inside **Ro-Bought-main** there's a folder called **extension**. That's the one you'll load into Chrome.
On Windows, the unzipped folder sometimes contains *another* `Ro-Bought-main` folder; just open it
until you see the **extension** folder.

### 3. Load it into Chrome

1. Open Chrome. Click the address bar at the top, type **`chrome://extensions`** and press **Enter**.
   (Or open Chrome's **⋮** menu → **Extensions** → **Manage Extensions**.)
2. In the top-right corner, turn on **Developer mode**.
3. Click **Load unpacked** (top-left).
4. In the window that opens, find the **Ro-Bought-main** folder, click once on the **extension**
   folder inside of it, and click **Select** (Windows/Linux) or **Open** (Mac).
5. Ro-Bought appears in your extensions list, and its settings page opens in a new tab.

### 4. Pin the 🤖 button to your toolbar (the latest version of Chrome may pin it automatically)

Click the **puzzle-piece** icon at the top-right of Chrome, then click the **pin** next to
**Ro-Bought**. The 🤖 button now stays visible in your toolbar.

> Chrome may sometimes warn you about extensions in developer mode when it starts. That's expected
> for add-ons loaded in this manner. Keep Ro-Bought turned on… 🫦

## Your first run, step by step

**Tip:** do a practice run first. Pick any cheap item that's in stock and sleclt **Stop one click
short** in the options menu. Ro-Bought should add it to your cart and stop at **Place order**
without buying anything. Afterwards, remove the item from your cart.

### 1. Tell Ro-Bought what to buy

Open the settings page: click the 🤖 button → **Options**.

1. In the store, open the product's page and copy its address from the address bar
   (**Ctrl+C** on Windows/Linux, **⌘+C** on Mac).
2. Paste it into **Product page URL**.
3. Optionally, type the **Product name**. This is used for notifications and Google Alerts.
4. Under **Store preset** you'll see which store Ro-Bought recognised: Amazon.com, the Nintendo US
   store, or "Generic store" for everything else (I didn’t have time to ID every online store in the world).

### 2. Choose when it should buy

- **Scheduled drop:** if you know the release date and time. Enter it in **Drop date and time**, in
  your own time zone.
- **Restock watch:** if you don't know when it'll be restocked. Ro-Bought checks the page regularly.

### 3. Choose how far it goes

- **Stop one click short** (ticked, recommended): Ro-Bought does everything up to the final
  **Place order** button, highlights it, and you click it.
- Untick it for **fully automatic purchase**. You then *must* set a **Max order total**, and
  Ro-Bought will only buy if the final total, including tax and shipping, is at or below it.

### 4. Save

Click **Save and grant site access**. Chrome asks whether Ro-Bought may access that store's
website; click **Allow**. Ro-Bought only ever gets access to that one store.

### 5. Arm it

Click the 🤖 button → **Arm**. A tab with the product opens, the 🤖 button shows **ON**, and a small
**Ro-Bought panel** appears in the bottom-right corner of the store page. Once all of those things happen
you're all set and ready to fight the scalpers.

### 6. What happens next

- **Scheduled drop:** two minutes before the drop, you get a notification and the store tab comes to
  the front. At the exact moment, Ro-Bought reloads the page. If it isn't live yet, it keeps
  retrying every few seconds.
- **Restock watch:** Ro-Bought quietly checks the product every 45 seconds or so.
- **When it can be bought:** you hear a sound and the 🤖 button shows **GO**. Ro-Bought adds the item
  to your cart, checks the cart, and goes through checkout.
- **Stop one click short:** you hear a sound, the **Place order** button is highlighted, and the
  panel says **Ready — your click**. Check the order and click “Place Order/Buy Now” yourself.
- **When the order goes through,** the 🤖 button shows **✓** and you get an "Order placed!"
  notification.

When a run is finished, click **Reset for a new run** in the popup before setting up the next one.
**Disarm (stop now)** stops a run at any time.

## The settings explained

All of these are on the settings page (🤖 → **Options**). Leave the advanced numbers at their
defaults unless you have a reason to change them.

| Setting | What it means |
| --- | --- |
| **Product page URL** | The address of the product's page on the store. |
| **Product name** | Optional. Used in notifications and to suggest a Google Alerts search. |
| **Scheduled drop / Restock watch** | Buy at a known time, or watch for stock to come back. |
| **Drop date and time** | When the product goes on sale, in your time zone. Ro-Bought also checks the store's own clock and corrects for any difference. |
| **Add to Google Calendar / Download .ics** | Puts the drop in your calendar, with a reminder 10 minutes before. |
| **Fire offset (ms)** | Fine-tuning for the exact moment Ro-Bought fires. Leave it at **0**. |
| **Retry interval / window after the drop** | If the product isn't live yet at the drop time, how often to retry (default every 3 s) and for how long (default 180 s). |
| **Restock check interval** | How often to check for stock (default 45 s, never faster than 20 s, to be polite to the store). |
| **Jitter (±%)** | Varies the timing slightly so checks don't look robotic even though they are. Default 20 %. |
| **Stop one click short** | Ro-Bought stops at the final **Place order** button and you click it. Recommended. |
| **Max order total** | The most you'll pay, including tax and shipping. Required for automatic purchase; a good safety net either way. |
| **Buttons** | The buttons you've taught (see [Teach buttons](#teach-buttons)), with **Clear** to remove one. |
| **Notifications** | Sound alerts, Google Alerts and its feed (see [Notifications](#notifications)). You can change these during a run. |
| **Activity** | A log of everything Ro-Bought did, with **Copy log** and **Clear log**. |

While a run is active, the product and purchase settings are locked. Disarm first to change them.

## On drop day: checklist

- **Plugged in and awake.** Ro-Bought keeps your screen awake while it's armed, but it can't stop
  your computer sleeping if you close a laptop lid or put it to sleep yourself.
  - **Mac:** keep the lid open.
  - **Windows:** Settings → System → Power, and set sleep to "Never" for the day.
  - **Linux:** check your power settings.
- **Chrome open, with the store tab in front.** Chrome slows down tabs that are hidden or minimised,
  which can make Ro-Bought late. It warns you if the tab goes into the background.
- **Signed in** to the store, with your **address and payment card saved** in your account.
- **Empty cart.** Ro-Bought buys only your one product, and pauses if anything else is in the cart.
  It checks this when you arm and warns you straight away. On Amazon, **Save for later** moves items
  out of the cart without deleting them.
- **Sound on** (Notifications → **Test sound**), so you hear when it needs you.
- **Practised once** with "Stop one click short" ticked, and taught any buttons it needed.
- **Stay nearby.** If a CAPTCHA or queue appears, only you can deal with it.

## Reading the 🤖 icon and the status panel

The small badge on the 🤖 toolbar button shows what's happening:

| Badge | Meaning |
| --- | --- |
| *(none)* | Off. Not armed. |
| **ON** | Armed: waiting for the drop or watching for a restock. |
| **GO** | It's in stock and Ro-Bought is checking out right now. Hands off that tab for a moment. |
| **!** | **It needs you.** It's paused, or it's waiting for your final click. |
| **✓** | Order placed. The run is finished. |
| **×** | Stopped for safety: an event-ticket page was detected, or the run was stopped after Ro-Bought had already clicked Place order (check your orders). Click **Reset for a new run** to start again. |

Click the 🤖 button for the **popup**. It shows the product, the store, the trigger, a live
countdown or the last check result, any pause message, and buttons: **Arm**, **Disarm (stop now)**,
**Resume**, **Reset for a new run**, **Teach buttons** and **Options**. **Activity** at the bottom
lists recent events.

On the store page, the **Ro-Bought panel** in the bottom-right corner shows the same status and the
next step. Click **–** to shrink it out of the way.

## When Ro-Bought pauses

Ro-Bought never tries to get around security checks, and it never types personal details. When it
meets one, it **pauses**: you hear a sound, the store tab comes to the front, and the panel and
popup tell you what to do. Deal with it, then click **Resume**.

| What you'll see | What to do |
| --- | --- |
| A **CAPTCHA**, "press & hold", or "verify you are human" | Complete it yourself, then **Resume**. |
| A **queue or waiting room** | Wait your turn in that tab, then **Resume**. |
| A **sign-in** page, or a request for a code | Sign in yourself, then **Resume**. |
| A request for **card details**, a security code, or your bank's check (3-D Secure) | Fill it in yourself, then **Resume**, or just finish the order by hand. |
| **"The retailer tab left …"** | The tab went to another site (often a queue or sign-in page). Handle it, return to the store, then **Resume**. |
| **"Add to cart is on the page but hidden"** | Pick the regular-price option or close the pop-up covering it, then **Resume**. To make this automatic, see [Teach buttons](#teach-buttons). |
| **"Your cart has other items"** | Remove them (or Save for later), then **Resume**. |
| **"Couldn't find …"** | Do that one step yourself, then **Resume**, or teach Ro-Bought that button for next time. |
| **The retailer tab was closed** | Click **Resume** to reopen it. |

- **Resume** appears once the problem is gone. **Resume anyway** appears if the check is still
  showing and you want Ro-Bought to carry on regardless.
- If the product **sells out again** while it's adding to cart, Ro-Bought simply goes back to
  watching.
- If an **event-ticket page** is detected, the run stops completely (×). Automated ticket buying is
  restricted by law in many places.

## Teach buttons

Every store's checkout looks a little different. Ro-Bought already knows Amazon.com and the Nintendo
US store for the most part, and it can find common buttons ("Add to cart", "Proceed to checkout",
"Place your order") on most other stores by their wording from reading the HTML. If it ever can't find a
button, **teach it once** and it will remember.

1. Make sure Ro-Bought isn't armed. Open the store in a tab.
2. Click the 🤖 button → **Teach buttons**. A teach panel appears on the page.
3. Click **Pick** next to a button's name, then click that button on the page. Ro-Bought remembers it.
   **Nothing on the page is actually pressed while you pick.**
4. Click **Test** to highlight what Ro-Bought would click on the current page.
5. To teach the later steps, add the product to your cart yourself and walk through checkout as far
   as the **final review page**, teaching each button on the way. **Don't place the order.**
6. Click **Done** when finished.

The buttons you can teach:

- **Click first, before Add to cart** (optional): a pop-up's close button, or the buying option to
  choose first. For example, Amazon's **Regular price** option during Prime deals (click the
  option's text).
- **Add to cart** (product page)
- **Proceed to checkout** (cart page)
- **Continue / Use this address / Use this payment** (checkout pages; up to 3)
- **Place order** (final review page)
- **Order total amount** (final review page; lets Ro-Bought check your max price)
- **Order confirmation message** (thank-you page)

Tips:
- Each step has its own button. Don't teach the same button for two steps; Ro-Bought warns you if
  you do.
- Never teach **Buy now**, **Order now** or **1-Click** buttons. On some stores they buy instantly and
  skip the review page (and Ro-Bought's safety checks), so Ro-Bought refuses to learn or click them.
- Taught buttons are listed in **Options → Buttons**, where **Clear** removes them. If you change to
  a different store, they're cleared automatically.
- Stuck? In the teach panel, **Copy page report** copies a list of the buttons Ro-Bought can see on
  that page (no personal details). Share any issues with me in a GitHub issue.

## Notifications

They all live on the settings page under **Notifications**. You can change these even while Ro-Bought is armed.

### Sound

Ro-Bought plays a short system sound when it finds stock, when it needs you (a pause or the final click),
and a happy system chime when an order is placed. Click **Test sound** to hear it. Untick the box if you’re
not about all that jazz.

### Google Alerts: hear about a drop the moment it's announced

Google Alerts emails you (or RSS feeds you) new web results for a search, which is handy for spotting
restock or release-date news.

1. Ro-Bought suggests a search in **Search to watch**, based on your product name. You can edit it.
2. Click **Copy and open Google Alerts**. Google Alerts opens with the search filled in (it's also on
   your clipboard if you need to paste it).
3. Click **Create alert** on Google's page to get alerts by **email**. That's it.

**Optional: get alerts inside Chrome too.**

1. On Google Alerts, click **Show options** → **Deliver to** → **RSS feed**, then **Create alert**.
2. Next to your new alert, right-click the **RSS** icon → **Copy link address**.
3. Paste it into **Google Alerts RSS link** in Ro-Bought, and click **Save notification settings**.
   Chrome asks for access to Google Alerts feeds once; click **Allow**.

Ro-Bought then checks the feed every 30 minutes and pops up a notification for each new result.
Click a notification to open the article. Recent results are listed on the settings page, and
**Check feed now** checks immediately.

### Calendar reminders

For a scheduled drop, **Add to Google Calendar** (or **Download .ics** for Apple Calendar, Outlook and
others) creates an event starting 10 minutes before the drop, with a reminder. Ro-Bought also
notifies you two minutes before the drop.

## Store tips

### Amazon.com

- Use the normal product page address (it contains `/dp/`).
- **Empty your cart** before the drop. **Save for later** keeps the items without deleting them.
- During **Prime deals**, Amazon may pre-select the Prime price and show **Join Prime** instead of
  Add to cart. Teach **Click first, before Add to cart** → the **Regular price** option, and
  Ro-Bought picks it automatically. (It will never click Join Prime.)
- Ro-Bought ignores "See All Buying Options" listings from other sellers. These are often resellers
  at higher prices.

### Nintendo US or Canadian store (nintendo.com/us/store)

- **Create a Nintendo Account**, save your address and payment method in it, and **sign in** before
  the drop.
- **Guest checkout can't be automated**, because it needs your details typed in and Ro-Bought never
  types personal details.

### Any other store

- It usually works out of the box for stores with standard buttons. Do a practice run with "Stop one
  click short" ticked, and teach any button it can't find.
- Some stores add steps (a shipping-speed choice, an upsell page). Teach their "Continue" buttons.
  Ro-Bought never accepts upsells, trials, subscriptions or warranties.

## What Ro-Bought will never do

- **Never** solve or get around CAPTCHAs, "press & hold" checks, queues or waiting rooms.
- **Never** type passwords, codes, card numbers or addresses.
- **Never** buy more than **one unit, once** per run. Once it has clicked Place order, it will never
  click it again in that run, even if the page reloads or Chrome restarts. To buy again, you must
  click **Reset for a new run**.
- **Never** use more than one account, hide its identity, or use proxies.
- **Never** click "Buy now", "Order now" or 1-Click buttons, sign-ups, trials, subscriptions or
  warranty add-ons.
- **Never** buy **event tickets**. Ticket websites and ticket listings are refused everywhere. In the
  US the BOTS Act (2016) and many state laws restrict automated ticket buying, and similar rules
  exist in the UK and elsewhere.
- **Never** hammer the store. Checks are spaced out (at least 20 seconds for restock watching, at
  least 2 seconds right after a drop), and Ro-Bought slows down whenever the store asks it to.

## Privacy

- Everything stays **on your computer**. Ro-Bought has no servers and sends your data nowhere.
- It only talks to the **one store** you chose (and to Google Alerts, if you add a feed).
- It stores your settings, the taught buttons, and a short activity log. It never stores passwords,
  card numbers, addresses or cookies. It can't even read the cards saved in Chrome; that's blocked
  for all extensions.
- For the full details, see the [security review](SECURITY.md).

## Troubleshooting

**The Load unpacked window doesn't show an "extension" folder.**
You're probably one level too high. Open **Ro-Bought-main** (and, on Windows, possibly another
**Ro-Bought-main** inside it) until you see the folder named **extension**, then select that one.

**Chrome says "Manifest file is missing or unreadable".**
You selected the wrong folder. Choose the **extension** folder, the one containing a file called
`manifest.json`.

**Arm is greyed out.**
Save a valid product first (🤖 → Options → **Save and grant site access**). Arm is also disabled while
you're looking at an event-ticket website.

**It says "Site access for the retailer has not been granted".**
Open Options and click **Save and grant site access** again, then click **Allow** when Chrome asks.

**"Ro-Bought can't reach the retailer tab".**
The tab was closed or reloaded, or your computer slept. Reload the store tab, or Disarm and Arm again.

**It paused and I'm not sure why.**
Read the message in the Ro-Bought panel or the popup; it always says what to do. The **Activity** log
in Options shows the full story.

**It can't find a button on a store.**
Use [Teach buttons](#teach-buttons). If it still struggles, use **Copy page report** and share it.

**"Your cart already has items".**
Remove them before the drop (on Amazon, use **Save for later**).

**You don't hear any sound.**
Check the box in **Notifications**, click **Test sound**, and make sure your computer isn't muted.

**The Google Alerts feed shows an error.**
Paste the RSS link again, click **Save notification settings**, and allow access when asked.

**Ro-Bought stopped working after I moved or deleted the folder.**
Chrome runs Ro-Bought from that folder. Put it back, or load it again (see [Install](#install-ro-bought)).

## Updating or removing Ro-Bought

**To update:** download the new ZIP from GitHub and unzip it. Replace the contents of your existing
**Ro-Bought-main** folder with the new files, keeping the **same location** so your settings are
kept. Then go to `chrome://extensions` and click the **reload** arrow (↻) on Ro-Bought's card.

**To remove:** go to `chrome://extensions` and click **Remove** on Ro-Bought's card. You can then
delete the folder.

## For developers

How Ro-Bought is built, how to run its tests, and the mock store used for rehearsals:
- [docs/build-process.md](docs/build-process.md): development setup, tests and releases.
- [docs/PLAN.md](docs/PLAN.md): the design and the phased build plan.
- [SECURITY.md](SECURITY.md): the security review.

## License

Free and open source under the GPL-3.0 licence. See [LICENSE](LICENSE). 
