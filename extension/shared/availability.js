// Pure availability helpers: schema.org availability values, offers in JSON-LD, and price
// parsing. No DOM — unit-tested in Node. DOM extraction lives in content/availability.js.
(() => {
  'use strict';

  // Buyable online right now (pre-orders count: many drops are pre-orders).
  const IN_STOCK = new Set(['instock', 'limitedavailability', 'onlineonly', 'preorder', 'presale', 'availablefororder', 'available']);
  // Not buyable online. BackOrder is excluded on purpose: it means "order now, ship who knows when".
  const OUT_OF_STOCK = new Set(['outofstock', 'soldout', 'discontinued', 'instoreonly', 'backorder', 'oos', 'unavailable', 'notavailable']);

  /** Maps "https://schema.org/InStock", "InStock", "in stock", "out_of_stock"... to a state. */
  function schemaState(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim().replace(/^.*[/#:]/, '').replace(/[\s_-]+/g, '').toLowerCase();
    if (IN_STOCK.has(key)) return 'in_stock';
    if (OUT_OF_STOCK.has(key)) return 'out_of_stock';
    return null;
  }

  /**
   * Parses a displayed price ("$1,299.99", "USD 49", "1.299,99 €") into a number.
   * @returns {number|null}
   */
  function parsePrice(input) {
    if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
    if (typeof input !== 'string') return null;
    const m = input.match(/\d[\d.,\s]*/);
    if (!m) return null;
    let s = m[0].replace(/\s/g, '').replace(/[.,]$/, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
      // Both present: whichever comes last is the decimal separator.
      s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
    } else if (lastComma !== -1) {
      // Only commas: "1,299" is thousands, "49,99" is decimal.
      s = /,\d{2}$/.test(s) && s.indexOf(',') === lastComma ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if (lastDot !== -1 && /\.\d{3}$/.test(s) && s.indexOf('.') !== lastDot) {
      s = s.replace(/\./g, ''); // "1.299.000"
    }
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const NODE_LIMIT = 5000;

  /**
   * Finds offers in parsed JSON-LD and summarises them. If any offer is buyable, the result
   * is in_stock with the lowest buyable price.
   * @returns {{state: 'in_stock'|'out_of_stock', price: number|null} | null}
   */
  function offersFromJsonLd(root) {
    const stack = [root];
    let visited = 0;
    let sawOut = false;
    let outPrice = null;
    let bestIn = null;
    while (stack.length && visited < NODE_LIMIT) {
      const node = stack.pop();
      visited++;
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node) && 'availability' in node) {
        const state = schemaState(Array.isArray(node.availability) ? node.availability[0] : node.availability);
        const price = parsePrice(node.price ?? node.lowPrice ?? null);
        if (state === 'in_stock') {
          if (bestIn === null || (price !== null && (bestIn.price === null || price < bestIn.price))) bestIn = { price };
        } else if (state === 'out_of_stock') {
          sawOut = true;
          if (outPrice === null) outPrice = price;
        }
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
    if (bestIn) return { state: 'in_stock', price: bestIn.price };
    if (sawOut) return { state: 'out_of_stock', price: outPrice };
    return null;
  }

  RoBought.availability = Object.freeze({ schemaState, parsePrice, offersFromJsonLd });
})();
