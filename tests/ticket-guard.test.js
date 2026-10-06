'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RoBought = require('./load-shared');

const { checkHost, checkUrl, checkText, checkJsonLd } = RoBought.ticketGuard;

test('blocks major ticket sites, including country domains and subdomains', () => {
  for (const host of [
    'www.ticketmaster.com', 'ticketmaster.co.uk', 'concerts.livenation.com', 'www.stubhub.com',
    'seatgeek.com', 'www.vividseats.com', 'www.eventbrite.co.uk', 'www.axs.com', 'axs.co.uk',
    'www.eventim.de', 'dice.fm', 'ra.co', 'www.tickpick.com', 'viagogo.com', 'tixr.com',
    'shop.myticketsite.example', 'tickets.someclub.com',
  ]) {
    assert.ok(checkHost(host), `expected ${host} to be blocked`);
  }
});

test('does not block ordinary retailers', () => {
  for (const host of [
    'www.bestbuy.com', 'www.target.com', 'www.walmart.com', 'www.amazon.co.uk', 'www.nike.com',
    'store.nintendo.com', 'www.pokemoncenter.com', 'www.dicksportinggoods.com', 'diceshop.example.com',
    'www.matrixgames.com', 'universe-of-toys.example',
  ]) {
    assert.equal(checkHost(host), null, `expected ${host} to be allowed`);
  }
});

test('blocks ticket-looking URL paths, allows merch paths', () => {
  assert.ok(checkUrl('https://shop.example.com/tickets/arena-tour-2026'));
  assert.ok(checkUrl('https://shop.example.com/events/123'));
  assert.ok(checkUrl('https://shop.example.com/ticket/987'));
  assert.ok(checkUrl('https://shop.example.com/p/e-ticket-vip'));
  assert.equal(checkUrl('https://www.target.com/p/graco-car-seat/-/A-123'), null);
  assert.equal(checkUrl('https://www.example.com/p/sneaker-event-edition'), null);
  assert.equal(checkUrl('https://www.example.com/ticket-to-ride-board-game/p/1'), null);
});

test('detects ticket product names without catching games or merch', () => {
  assert.ok(checkText('2 Tickets - Arena Tour 2026'));
  assert.ok(checkText('General Admission Festival Pass'));
  assert.ok(checkText('VIP concert ticket'));
  assert.equal(checkText('Ticket to Ride Board Game'), null);
  assert.equal(checkText('Graco Car Seat'), null);
  assert.equal(checkText('Console X 1TB Edition'), null);
  assert.equal(checkText(''), null);
});

test('detects event/ticket structured data, ignores products and sales', () => {
  assert.ok(checkJsonLd({ '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Arena Tour' }));
  assert.ok(checkJsonLd({ '@graph': [{ '@type': 'WebPage' }, { '@type': ['Thing', 'SportsEvent'] }] }));
  assert.ok(checkJsonLd([{ '@type': 'Product', offers: { itemOffered: { '@type': 'https://schema.org/TheaterEvent' } } }]));
  assert.ok(checkJsonLd({ '@type': 'schema:Ticket' }));
  assert.equal(checkJsonLd({ '@type': 'Product', name: 'Console X', offers: { '@type': 'Offer', availability: 'InStock' } }), null);
  assert.equal(checkJsonLd({ '@type': 'SaleEvent', name: 'Prime Day' }), null);
  assert.equal(checkJsonLd(null), null);
});

test('JSON-LD walk is bounded on huge or deeply nested input', () => {
  let deep = { '@type': 'MusicEvent' };
  for (let i = 0; i < 100_000; i++) deep = { child: deep };
  assert.equal(checkJsonLd(deep), null); // event is beyond the node budget: no stack overflow, no hang
  const wide = { items: Array.from({ length: 50_000 }, () => ({ '@type': 'Product' })) };
  const started = Date.now();
  assert.equal(checkJsonLd(wide), null);
  assert.ok(Date.now() - started < 500);
});
