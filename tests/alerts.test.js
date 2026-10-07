'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RoBought = require('./load-shared');

const A = RoBought.alerts;

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:idx="urn:atom-extension:indexing">
  <id>tag:google.com,2005:reader/user/01234567890123456789/state/com.google/alerts/98765432109876543210</id>
  <title>Google Alert - "Console X"</title>
  <entry>
    <id>tag:google.com,2013:googlealerts/feed:11111111111111111111</id>
    <title type="html">&lt;b&gt;Console X&lt;/b&gt; restock: retailers get new stock &amp;amp; more</title>
    <link href="https://www.google.com/url?rct=j&amp;sa=t&amp;url=https://news.example.com/console-x-restock&amp;ct=ga&amp;cd=CAIyGg&amp;usg=AOvVaw0"/>
    <published>2026-10-07T12:00:00Z</published>
    <content type="html">The &lt;b&gt;Console X&lt;/b&gt; is back in stock at &lt;script&gt;alert(1)&lt;/script&gt; major stores</content>
  </entry>
  <entry>
    <id>tag:google.com,2013:googlealerts/feed:22222222222222222222</id>
    <title type="html"><![CDATA[Release date announced for Console X]]></title>
    <link href="javascript:alert(1)"/>
    <updated>2026-10-07T13:00:00Z</updated>
  </entry>
</feed>`;

test('suggests a restock/release query and an Alerts link', () => {
  const q = A.suggestQuery('Console X "1TB"');
  assert.equal(q, '"Console X 1TB" (restock OR "back in stock" OR "in stock" OR "release date" OR preorder OR "pre-order" OR drop)');
  assert.equal(A.suggestQuery('  '), '');
  assert.match(A.alertsPageUrl(q), /^https:\/\/www\.google\.com\/alerts\?q=%22Console%20X%201TB%22/);
});

test('accepts only Google Alerts feed URLs', () => {
  assert.ok(A.parseFeedUrl(' https://www.google.com/alerts/feeds/01234567890123456789/98765432109876543210 '));
  for (const bad of [
    'http://www.google.com/alerts/feeds/0123456789/9876543210',
    'https://evil.example/alerts/feeds/0123456789/9876543210',
    'https://www.google.com.evil.example/alerts/feeds/0123456789/9876543210',
    'https://www.google.com/alerts/feeds/abc/def',
    'https://www.google.com/alerts/feeds/0123456789/9876543210?x=1',
    '',
    null,
  ]) {
    assert.equal(A.parseFeedUrl(bad), null, String(bad));
  }
});

test('parses Google Alerts Atom: plain-text titles, real article links, no scripts', () => {
  const entries = A.parseAtom(FEED);
  assert.equal(entries.length, 2);
  const [a, b] = entries;
  assert.equal(a.id, 'tag:google.com,2013:googlealerts/feed:11111111111111111111');
  assert.equal(a.title, 'Console X restock: retailers get new stock & more');
  assert.equal(a.url, 'https://news.example.com/console-x-restock');
  assert.equal(a.published, '2026-10-07T12:00:00Z');
  assert.ok(!/[<>]/.test(a.summary), a.summary);
  assert.equal(b.title, 'Release date announced for Console X');
  assert.equal(b.url, null, 'javascript: links are dropped');
  assert.equal(b.published, '2026-10-07T13:00:00Z');
});

test('feed parsing is bounded and tolerant', () => {
  assert.deepEqual(A.parseAtom(''), []);
  assert.deepEqual(A.parseAtom('<feed><entry></entry></feed>'), []);
  const many = `<feed>${'<entry><id>x</id><title>t</title></entry>'.repeat(500)}</feed>`;
  assert.equal(A.parseAtom(many).length, 50);
  assert.equal(A.plainText('&#x1F600; &#0; &bogus; &lt;i&gt;ok&lt;/i&gt;'), '😀 &bogus; ok');
  assert.equal(A.articleUrl('https://www.google.com/url?url=ftp://x.example/file'), null);
});

test('calendar reminders: Google Calendar link and .ics, 10 min before to 15 min after', () => {
  const dropTime = Date.UTC(2026, 9, 10, 15, 0, 0);
  const url = new URL(A.googleCalendarUrl({ productName: 'Console X', productUrl: 'https://www.example-store.com/p/1', dropTime }));
  assert.equal(url.hostname, 'calendar.google.com');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('dates'), '20261010T145000Z/20261010T151500Z');
  assert.equal(url.searchParams.get('text'), 'Drop: Console X (Ro-Bought)');
  assert.match(url.searchParams.get('details'), /cart empty/);

  const ics = A.icsFile({ productName: 'Console X, 1TB; v2', productUrl: 'https://x.example/p', dropTime, now: Date.UTC(2026, 9, 7) });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261010T145000Z\r\n/);
  assert.match(ics, /DTEND:20261010T151500Z\r\n/);
  assert.match(ics, /SUMMARY:Drop: Console X\\, 1TB\\; v2 \(Ro-Bought\)\r\n/);
  assert.match(ics, /TRIGGER:-PT10M/);
  assert.ok(!/\n(?<!\r\n)/.test(ics.replace(/\r\n/g, '')), 'CRLF line endings only');
});

test('feed parsing stays fast on a hostile feed (no quadratic blow-up)', () => {
  const unclosed = `<feed>${'<entry><title>x</title>'.repeat(80_000)}</feed>`; // ~1.8 MB, never closed
  let t = Date.now();
  assert.deepEqual(A.parseAtom(unclosed), []);
  assert.ok(Date.now() - t < 300, `took ${Date.now() - t} ms`);
  const hugeEntry = `<feed><entry><id>big</id><title>${'<b>'.repeat(200_000)}</title></entry></feed>`;
  t = Date.now();
  const [entry] = A.parseAtom(hugeEntry);
  assert.equal(entry.id, 'big');
  assert.ok(Date.now() - t < 300, `took ${Date.now() - t} ms`);
  assert.deepEqual(A.parseAtom('<feed><entryX><id>no</id></entryX><entry><id>yes</id></entry></feed>').map((e) => e.id), ['yes']);
});
