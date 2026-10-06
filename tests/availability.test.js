'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RoBought = require('./load-shared');

const { schemaState, parsePrice, offersFromJsonLd } = RoBought.availability;

test('schema.org availability values', () => {
  assert.equal(schemaState('https://schema.org/InStock'), 'in_stock');
  assert.equal(schemaState('http://schema.org/PreOrder'), 'in_stock');
  assert.equal(schemaState('LimitedAvailability'), 'in_stock');
  assert.equal(schemaState('in stock'), 'in_stock');
  assert.equal(schemaState('https://schema.org/OutOfStock'), 'out_of_stock');
  assert.equal(schemaState('SoldOut'), 'out_of_stock');
  assert.equal(schemaState('BackOrder'), 'out_of_stock');
  assert.equal(schemaState('InStoreOnly'), 'out_of_stock');
  assert.equal(schemaState('out_of_stock'), 'out_of_stock');
  assert.equal(schemaState('maybe'), null);
  assert.equal(schemaState(42), null);
});

test('price parsing', () => {
  assert.equal(parsePrice('$499.99'), 499.99);
  assert.equal(parsePrice('$1,299.99'), 1299.99);
  assert.equal(parsePrice('1,299'), 1299);
  assert.equal(parsePrice('USD 49'), 49);
  assert.equal(parsePrice('1.299,99 €'), 1299.99);
  assert.equal(parsePrice('49,99'), 49.99);
  assert.equal(parsePrice(' 59.00 '), 59);
  assert.equal(parsePrice(12.5), 12.5);
  assert.equal(parsePrice('Free'), null);
  assert.equal(parsePrice(''), null);
});

test('offers: any buyable offer wins, at its lowest price', () => {
  const ld = {
    '@type': 'ProductGroup',
    hasVariant: [
      { '@type': 'Product', offers: { availability: 'https://schema.org/OutOfStock', price: '399.99' } },
      { '@type': 'Product', offers: [{ availability: 'InStock', price: '549.99' }, { availability: 'InStock', price: '499.99' }] },
    ],
  };
  assert.deepEqual(offersFromJsonLd(ld), { state: 'in_stock', price: 499.99 });
  assert.deepEqual(offersFromJsonLd({ offers: { availability: 'SoldOut', price: 10 } }), { state: 'out_of_stock', price: 10 });
  assert.equal(offersFromJsonLd({ '@type': 'Product', name: 'x' }), null);
  assert.equal(offersFromJsonLd(null), null);
});
