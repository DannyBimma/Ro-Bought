// Pure helpers for staying informed about a drop: Google Alerts queries and feeds, and
// calendar reminders. No DOM, no chrome.* — unit-tested in Node and usable in the service
// worker (which has no DOMParser).
(() => {
  'use strict';

  const QUERY_MAX = 300;
  const FEED_MAX_ENTRIES = 50;
  const TEXT_MAX = 300;

  // Google Alerts RSS feeds look like https://www.google.com/alerts/feeds/<user>/<alert>.
  const FEED_URL_RE = /^https:\/\/www\.google\.com\/alerts\/feeds\/\d{5,30}\/\d{5,30}$/;
  const FEED_PERMISSION = 'https://www.google.com/alerts/feeds/*';

  /** A Google Alerts query that catches restock / release news for a product. */
  function suggestQuery(productName) {
    const name = String(productName || '').replace(/["\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return '';
    return `"${name}" (restock OR "back in stock" OR "in stock" OR "release date" OR preorder OR "pre-order" OR drop)`;
  }

  /** Google Alerts with the query filled in (the user still clicks "Create alert"). */
  function alertsPageUrl(query) {
    return `https://www.google.com/alerts?q=${encodeURIComponent(String(query || '').slice(0, QUERY_MAX))}&hl=en`;
  }

  /** @returns {string|null} the normalised feed URL, or null if it isn't a Google Alerts feed */
  function parseFeedUrl(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    return FEED_URL_RE.test(s) ? s : null;
  }

  // ---------------------------------------------------------------------------
  // Atom (Google Alerts feeds are Atom). A small, bounded parser: no DOM, no recursion.
  // ---------------------------------------------------------------------------

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    });
  }

  /** Feed text (often HTML-escaped HTML, e.g. "&lt;b&gt;Switch&lt;/b&gt;") → plain text. */
  function plainText(raw, max = TEXT_MAX) {
    let s = String(raw || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    s = decodeEntities(s);
    s = s.replace(/<[^>]{0,500}>/g, ' ');
    s = decodeEntities(s); // double-escaped entities ("&amp;amp;")
    return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function element(body, tag) {
    const m = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1] : '';
  }

  function attribute(body, tag, attr) {
    const m = body.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
  }

  /**
   * Google Alerts links go through google.com/url?url=<target>. Return the real article URL,
   * and only http(s) URLs at all.
   * @returns {string|null}
   */
  function articleUrl(link) {
    let u;
    try {
      u = new URL(link);
    } catch {
      return null;
    }
    if (u.hostname === 'www.google.com' && u.pathname === '/url') {
      const target = u.searchParams.get('url') || u.searchParams.get('q');
      if (target) return articleUrl(target);
    }
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  }

  const ENTRY_MAX_CHARS = 20_000;

  /**
   * Linear-time scan with indexOf (a lazy regex over the whole feed can go quadratic on a
   * malformed feed full of unclosed <entry> tags). Each entry body is capped before the small
   * per-field regexes run on it.
   * @param {string} xml
   * @returns {Array<{id: string, title: string, url: string|null, published: string, summary: string}>}
   */
  function parseAtom(xml) {
    const out = [];
    const text = String(xml || '');
    const lower = text.toLowerCase();
    let pos = 0;
    while (out.length < FEED_MAX_ENTRIES) {
      const open = lower.indexOf('<entry', pos);
      if (open === -1) break;
      if (!/^<entry[\s>/]/.test(lower.slice(open, open + 7))) {
        pos = open + 6; // a look-alike such as <entryfoo>: keep scanning after it
        continue;
      }
      const openEnd = lower.indexOf('>', open);
      const close = openEnd === -1 ? -1 : lower.indexOf('</entry>', openEnd);
      if (close === -1) break;
      pos = close + 8;
      const body = text.slice(openEnd + 1, Math.min(close, openEnd + 1 + ENTRY_MAX_CHARS));
      const link = attribute(body, 'link', 'href');
      const id = plainText(element(body, 'id'), 200) || link;
      if (!id) continue;
      out.push({
        id,
        title: plainText(element(body, 'title'), 200) || '(untitled)',
        url: articleUrl(link),
        published: plainText(element(body, 'published') || element(body, 'updated'), 40),
        summary: plainText(element(body, 'content') || element(body, 'summary'), TEXT_MAX),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Calendar reminders for a scheduled drop
  // ---------------------------------------------------------------------------

  const REMIND_BEFORE_MS = 10 * 60_000;
  const EVENT_AFTER_MS = 15 * 60_000;
  const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  function reminderText({ productName, productUrl }) {
    return {
      title: `Drop: ${productName || 'product'} (Ro-Bought)`.slice(0, 120),
      details: `Ro-Bought is armed for this drop. Have Chrome open with the store tab in front, your computer awake, and your cart empty.\n${productUrl || ''}`,
    };
  }

  /** "Add to Google Calendar" link: from 10 min before the drop to 15 min after. */
  function googleCalendarUrl({ productName, productUrl, dropTime }) {
    const { title, details } = reminderText({ productName, productUrl });
    const dates = `${utcStamp(dropTime - REMIND_BEFORE_MS)}/${utcStamp(dropTime + EVENT_AFTER_MS)}`;
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${dates}&details=${encodeURIComponent(details)}`;
  }

  const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

  /** An .ics file (Apple Calendar, Outlook, …) with a 10-minute alarm. */
  function icsFile({ productName, productUrl, dropTime, now = Date.now(), uid }) {
    const { title, details } = reminderText({ productName, productUrl });
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ro-Bought//Drop reminder//EN',
      'BEGIN:VEVENT',
      `UID:${uid || `${dropTime}@ro-bought`}`,
      `DTSTAMP:${utcStamp(now)}`,
      `DTSTART:${utcStamp(dropTime - REMIND_BEFORE_MS)}`,
      `DTEND:${utcStamp(dropTime + EVENT_AFTER_MS)}`,
      `SUMMARY:${icsEscape(title)}`,
      `DESCRIPTION:${icsEscape(details)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape(title)}`,
      'TRIGGER:-PT10M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
  }

  RoBought.alerts = Object.freeze({
    FEED_PERMISSION, suggestQuery, alertsPageUrl, parseFeedUrl, parseAtom, plainText, articleUrl,
    googleCalendarUrl, icsFile,
  });
})();
