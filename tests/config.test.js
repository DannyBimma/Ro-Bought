'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RoBought = require('./load-shared');

const { validate, armProblems, defaults } = RoBought.config;
const { parseProductUrl, scopePatterns, inScope } = RoBought.url;

const valid = (over = {}) => ({
  productUrl: 'https://www.example-store.com/product/123',
  triggerMode: 'restock',
  ...over,
});

test('accepts a minimal restock config and applies defaults', () => {
  const r = validate(valid());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.config.restockIntervalSec, defaults().restockIntervalSec);
  assert.equal(r.config.stopBeforePlaceOrder, true);
});

test('rejects http (non-localhost), credentials and garbage URLs; allows localhost http', () => {
  assert.equal(parseProductUrl('http://www.example.com/p'), null);
  assert.equal(parseProductUrl('https://user:pw@example.com/p'), null);
  assert.equal(parseProductUrl('javascript:alert(1)'), null);
  assert.equal(parseProductUrl('not a url'), null);
  assert.ok(parseProductUrl('http://localhost:8080/product'));
});

test('site scope covers bare host + www (port and path ignored), nothing broader', () => {
  assert.deepEqual(scopePatterns('https://www.amazon.com/dp/B0TEST?x=1'),
    ['https://amazon.com/*', 'https://www.amazon.com/*']);
  assert.deepEqual(scopePatterns('https://amazon.com/dp/B0TEST'),
    ['https://amazon.com/*', 'https://www.amazon.com/*']);
  assert.deepEqual(scopePatterns('https://store.nintendo.co.uk/en_GB/p'),
    ['https://store.nintendo.co.uk/*', 'https://www.store.nintendo.co.uk/*']);
  assert.deepEqual(scopePatterns('http://localhost:8080/p'), ['http://localhost/*']);
  assert.deepEqual(scopePatterns('not a url'), []);

  assert.ok(inScope('https://amazon.com/gp/cart', 'https://www.amazon.com/dp/B0TEST'));
  assert.ok(inScope('https://www.amazon.com/x', 'https://www.amazon.com/y'));
  assert.ok(!inScope('https://smile.amazon.com/x', 'https://www.amazon.com/y'));
  assert.ok(!inScope('https://accounts.nintendo.com/login', 'https://www.nintendo.com/us/store/p'));
  assert.ok(!inScope('http://www.amazon.com/x', 'https://www.amazon.com/y'));
  assert.ok(!inScope('https://evil.example.net/x', 'https://www.example.com/x'));
});

test('refuses ticket URLs and ticket product names', () => {
  assert.equal(validate(valid({ productUrl: 'https://www.ticketmaster.com/event/1' })).ok, false);
  assert.equal(validate(valid({ productName: '2 tickets, floor seats' })).ok, false);
});

test('enforces polite network limits', () => {
  assert.equal(validate(valid({ restockIntervalSec: 5 })).ok, false);
  assert.equal(validate(valid({ burstIntervalSec: 1 })).ok, false);
  assert.equal(validate(valid({ jitterPct: 90 })).ok, false);
  assert.equal(validate(valid({ restockIntervalSec: '60' })).config.restockIntervalSec, 60);
});

test('scheduled mode needs a drop time; arming needs it in the future', () => {
  assert.equal(validate(valid({ triggerMode: 'scheduled' })).ok, false);
  const now = Date.UTC(2026, 0, 1);
  const r = validate(valid({ triggerMode: 'scheduled', dropTime: now + 60_000 }));
  assert.equal(r.ok, true);
  assert.deepEqual(armProblems(r.config, now), []);
  assert.equal(armProblems(r.config, now + 120_000).length, 1);
});

test('auto-purchase requires a max price ceiling', () => {
  assert.equal(validate(valid({ stopBeforePlaceOrder: false })).ok, false);
  const r = validate(valid({ stopBeforePlaceOrder: false, maxTotalPrice: '549.999' }));
  assert.equal(r.ok, true);
  assert.equal(r.config.maxTotalPrice, 550);
});

test('drops unknown and hostile keys', () => {
  const raw = JSON.parse('{"productUrl":"https://www.example-store.com/p","triggerMode":"restock","__proto__":{"polluted":true},"evil":1}');
  const r = validate(raw);
  assert.equal(r.ok, true);
  assert.equal(Object.hasOwn(r.config, 'evil'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(r.config.polluted, undefined);
});
