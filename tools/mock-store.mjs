// A tiny in-memory "store" for rehearsing drops, restocks and checkout without a real retailer.
// Used by tools/serve.mjs (manual testing) and tests/e2e/run.mjs (automated).
//
// Product and stock
//   /store/product.html        server-rendered product page (JSON-LD + Add to cart form)
//   /store/spa.html            client-rendered product page (stock is fetched after load)
//   /store/api/stock           JSON stock endpoint used by spa.html
// Checkout (plain GET forms, like many real stores' full-page flows)
//   /store/cart/add            adds the product, then redirects to the cart
//   /store/cart.html           cart with one quantity field per line
//   /store/checkout/address.html → payment.html → review.html → /store/checkout/place
//   /store/checkout/thankyou.html?order=…
// Control
//   /__control?stock=in|out&price=…&tax=…&dropIn=<s>&dropAt=<epoch ms>&skewMs=…&fail=429:2:5
//              &extraItem=1&reviewCaptcha=1&bankCheck=1&placeFails=1&addFails=1&placeLabel=…
//              &promo=simple|stubborn|off&reset=1
//   /__control/log             recent requests (for checking polite intervals)

const LOG_MAX = 2000;
const SKU = 'console';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createMockStore() {
  const initial = () => ({
    stock: 'out', price: 499.99, tax: 30, dropAt: 0, skewMs: 0,
    reviewCaptcha: false, bankCheck: false, placeFails: false, addFails: false,
    promo: '', // '' | 'simple' (has "No thanks") | 'stubborn' (only "Show me the deal")
    placeLabel: 'Place your order', // the final button's text (change it to test taught buttons)
  });
  let state = initial();
  let cart = [];   // [{ sku, name, price, qty }]
  let orders = []; // [{ id, items, total, t }]
  let failQueue = []; // [{ status, retryAfter }]
  let log = [];

  const inStock = () => state.stock === 'in' || (state.dropAt > 0 && Date.now() >= state.dropAt);
  const cartTotal = () => cart.reduce((sum, l) => sum + l.price * l.qty, 0);
  const orderTotal = () => Math.round((cartTotal() + (cart.length ? state.tax : 0)) * 100) / 100;

  function set(patch) {
    if (patch.stock === 'in' || patch.stock === 'out') state.stock = patch.stock;
    for (const key of ['price', 'tax', 'dropAt', 'skewMs']) {
      if (patch[key] !== undefined && Number.isFinite(Number(patch[key]))) state[key] = Number(patch[key]);
    }
    if (patch.promo !== undefined) state.promo = ['simple', 'stubborn'].includes(patch.promo) ? patch.promo : '';
    for (const key of ['reviewCaptcha', 'bankCheck', 'placeFails', 'addFails']) {
      if (patch[key] !== undefined) state[key] = patch[key] === true || patch[key] === '1' || patch[key] === 'true';
    }
    if (typeof patch.placeLabel === 'string' && patch.placeLabel.trim()) state.placeLabel = patch.placeLabel.trim().slice(0, 40);
    if (patch.extraItem === true || patch.extraItem === '1') {
      cart.push({ sku: 'cable', name: 'HDMI cable', price: 9.99, qty: 1 });
    }
    return snapshot();
  }

  /** The next `count` product-page GETs answer `status` (e.g. 429) with Retry-After. */
  function failNext(status, count = 1, retryAfter = null) {
    for (let i = 0; i < count; i++) failQueue.push({ status, retryAfter });
  }

  function reset() {
    state = initial();
    cart = [];
    orders = [];
    failQueue = [];
    log = [];
  }

  const snapshot = () => ({
    ...state, inStock: inStock(), pendingFailures: failQueue.length,
    cart: cart.map((l) => ({ sku: l.sku, qty: l.qty })), orders: orders.length,
  });
  const requests = (filter = () => true) => log.filter(filter);

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------

  function nav() {
    let links = '<a href="/store/cart.html">Cart</a> ';
    for (let i = 1; i <= 40; i++) links += `<a href="/store/category-${i}.html">Category ${i}</a> `;
    return `<nav>${links}</nav>`;
  }

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | Mock Store</title></head>
<body>${nav()}<main>${body}</main></body></html>`;

  function productPage() {
    const available = inStock();
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Mock Console 1TB',
      offers: {
        '@type': 'Offer',
        price: state.price.toFixed(2),
        priceCurrency: 'USD',
        availability: `https://schema.org/${available ? 'InStock' : 'OutOfStock'}`,
      },
    };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock Console 1TB | Mock Store</title>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script></head>
<body>${nav()}<main><h1>Mock Console 1TB</h1><p class="price">$${esc(state.price.toFixed(2))}</p>
<p id="availability">${available ? 'In stock' : 'Out of stock'}</p>
${adFrame()}
${promoDialog()}
<form id="atc-form" action="/store/cart/add" method="get"${state.promo ? ' style="display:none"' : ''}>
  <input type="hidden" name="sku" value="${SKU}">
  <label>Quantity <select name="quantity"><option value="1">1</option><option value="2">2</option></select></label>
  <button id="add-to-cart" type="submit"${available ? '' : ' disabled'}>Add to cart</button>
</form>
<form action="/store/buy-now" method="get"><button id="buy-now-button" type="submit"${available ? '' : ' disabled'}>Buy now</button></form>
<form action="/store/order-now" method="get"><button id="order-now" type="submit"${available ? '' : ' disabled'}>Order now</button></form>
</main></body></html>`;
  }

  /** Like Amazon's ad frames: visible, with a long encoded name that happens to contain "3ds". */
  function adFrame() {
    const name = `ape_Detail_ad_${'a1b2'.repeat(12)}x3dsq${'c3d4'.repeat(30)}`;
    return `<iframe title="Advertisement" name="${name}" src="about:blank" width="300" height="250"></iframe>`;
  }

  /** A deal pop-up that hides Add to cart until it's dismissed. */
  function promoDialog() {
    if (!state.promo) return '';
    const button = state.promo === 'simple'
      ? '<button id="promo-close" type="button">No thanks</button>'
      : '<button id="promo-ok" type="button">Show me the deal</button>';
    return `<div id="promo" role="dialog" aria-modal="true" style="position:fixed;top:20%;left:20%;width:60%;padding:20px;background:#fff;border:2px solid #333;z-index:10">
  <h2>Prime Big Deal Days</h2><p>Members save more on this item.</p>${button}</div>
<script>
  document.querySelector('#promo button').addEventListener('click', () => {
    document.getElementById('promo').remove();
    document.getElementById('atc-form').style.display = '';
  });
</script>`;
  }

  function spaPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock Console (SPA) | Mock Store</title></head>
<body>${nav()}<main id="app"><h1>Mock Console 1TB</h1><p>Loading…</p></main>
<script>
  setTimeout(async () => {
    const res = await fetch('/store/api/stock', { cache: 'no-store' });
    const { inStock, price } = await res.json();
    const app = document.getElementById('app');
    app.innerHTML = '<h1>Mock Console 1TB</h1><p class="price">$' + price.toFixed(2) + '</p>' +
      (inStock
        ? '<form action="/store/cart/add" method="get"><input type="hidden" name="sku" value="console"><button id="add-to-cart" type="submit">Add to cart</button></form>'
        : '<button id="notify">Notify me</button>');
  }, 400);
</script></body></html>`;
  }

  function cartPage() {
    if (!cart.length) return page('Cart', '<h1>Shopping cart</h1><p>Your cart is empty.</p>');
    const lines = cart.map((l) => `<div class="cart-line" data-sku="${esc(l.sku)}">${esc(l.name)} — $${l.price.toFixed(2)}
      <label>Qty <input name="qty-${esc(l.sku)}" type="number" value="${l.qty}" min="0"></label></div>`).join('');
    return page('Cart', `<h1>Shopping cart</h1><form action="/store/checkout/address.html" method="get">${lines}
      <p>Subtotal: $${cartTotal().toFixed(2)}</p><button type="submit" id="checkout">Proceed to checkout</button></form>`);
  }

  const addressPage = () => page('Delivery address', `<h1>Choose a delivery address</h1>
    <form action="/store/checkout/payment.html" method="get">
      <label><input type="radio" name="address" value="home" checked> Jo Shopper, 1 Main St, Springfield</label>
      <button type="submit">Use this address</button></form>`);

  const paymentPage = () => page('Payment', `<h1>Choose a payment method</h1>
    <form action="/store/checkout/review.html" method="get">
      <label><input type="radio" name="card" value="visa" checked> Visa ending 4242</label>
      <button type="submit">Use this payment method</button></form>`);

  function reviewPage(error) {
    const lines = cart.map((l) => `<li>${esc(l.name)} × ${l.qty} — $${(l.price * l.qty).toFixed(2)}</li>`).join('');
    const captcha = state.reviewCaptcha
      ? '<div id="px-captcha" style="width:300px;height:60px;border:1px solid #999">Press &amp; Hold</div>'
      : '';
    const bank = state.bankCheck
      ? '<iframe title="3-D Secure authentication" src="about:blank" width="400" height="400"></iframe>'
      : '';
    return page('Review your order', `<h1>Review your order</h1>
      ${error ? `<p role="alert" class="error">${esc(error)}</p>` : ''}
      <section><h2>Ship to</h2><p>Jo Shopper, 1 Main St, Springfield</p></section>
      <section><h2>Pay with</h2><p>Visa ending 4242</p></section>
      <ul>${lines}</ul>
      <div class="row"><span>Items:</span> <span>$${cartTotal().toFixed(2)}</span></div>
      <div class="row"><span>Estimated tax:</span> <span>$${state.tax.toFixed(2)}</span></div>
      <div class="row"><strong>Order total:</strong> <strong>$${orderTotal().toFixed(2)}</strong></div>
      ${captcha}${bank}
      <form action="/store/checkout/place" method="get"><button type="submit" id="place-order">${esc(state.placeLabel)}</button></form>`);
  }

  const thankYouPage = (id) => page('Thank you', `<h1>Thank you, your order has been placed</h1><p>Order number: ${esc(id)}</p>`);

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  function send(res, req, status, type, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      Date: new Date(Date.now() + state.skewMs).toUTCString(),
      ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const redirect = (res, req, location) => send(res, req, 302, 'text/plain', '', { Location: location });
  const html = (res, req, body) => send(res, req, 200, 'text/html; charset=utf-8', body);

  /** @returns {boolean} true if the request was handled */
  function handle(req, res, url) {
    if (url.pathname === '/__control') {
      const q = Object.fromEntries(url.searchParams);
      if (q.reset) reset();
      if (q.dropIn !== undefined && Number.isFinite(Number(q.dropIn))) {
        q.dropAt = Date.now() + Number(q.dropIn) * 1000; // "go live in N seconds"
      }
      if (q.fail) {
        const [status, count, retryAfter] = q.fail.split(':').map(Number);
        failNext(status, count || 1, Number.isFinite(retryAfter) ? retryAfter : null);
      }
      set(q);
      send(res, req, 200, 'application/json', JSON.stringify(snapshot(), null, 2));
      return true;
    }
    if (url.pathname === '/__control/log') {
      send(res, req, 200, 'application/json', JSON.stringify(log.slice(-200), null, 2));
      return true;
    }
    if (!url.pathname.startsWith('/store/')) return false;

    const entry = {
      t: Date.now(),
      method: req.method,
      path: url.pathname,
      mode: req.headers['sec-fetch-mode'] || '',
      status: 200,
    };
    log.push(entry);
    if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);

    const isPage = url.pathname === '/store/product.html' || url.pathname === '/store/spa.html';
    if (isPage && req.method === 'GET' && failQueue.length) {
      const { status, retryAfter } = failQueue.shift();
      entry.status = status;
      send(res, req, status, 'text/html; charset=utf-8', `<h1>${status}</h1>`, retryAfter !== null ? { 'Retry-After': String(retryAfter) } : {});
      return true;
    }

    switch (url.pathname) {
      case '/store/product.html': html(res, req, productPage()); break;
      case '/store/spa.html': html(res, req, spaPage()); break;
      case '/store/api/stock':
        send(res, req, 200, 'application/json', JSON.stringify({ inStock: inStock(), price: state.price }));
        break;
      case '/store/cart/add': {
        if (state.addFails || !inStock()) {
          // Lost the race: someone else got the last one.
          state.addFails = false;
          state.stock = 'out';
          state.dropAt = 0;
          redirect(res, req, '/store/product.html?soldout=1');
          break;
        }
        const qty = Math.max(1, Number(url.searchParams.get('quantity')) || 1);
        const line = cart.find((l) => l.sku === SKU);
        if (line) line.qty += qty;
        else cart.push({ sku: SKU, name: 'Mock Console 1TB', price: state.price, qty });
        redirect(res, req, '/store/cart.html');
        break;
      }
      case '/store/order-now':
      case '/store/buy-now': {
        // An instant purchase, like Amazon's 1-Click "Buy now". Ro-Bought must never press it.
        const id = `INSTANT-${1000 + orders.length + 1}`;
        orders.push({ id, items: [{ sku: SKU, name: 'Mock Console 1TB', price: state.price, qty: 1 }], total: state.price, t: Date.now(), instant: true });
        redirect(res, req, `/store/checkout/thankyou.html?order=${id}`);
        break;
      }
      case '/store/cart.html': html(res, req, cartPage()); break;
      case '/store/checkout/address.html': html(res, req, addressPage()); break;
      case '/store/checkout/payment.html': html(res, req, paymentPage()); break;
      case '/store/checkout/review.html': html(res, req, reviewPage('')); break;
      case '/store/checkout/place': {
        if (!cart.length) {
          redirect(res, req, '/store/cart.html');
        } else if (state.placeFails) {
          html(res, req, reviewPage('Something went wrong. Please try again.'));
        } else {
          const id = `MOCK-${1000 + orders.length + 1}`;
          orders.push({ id, items: cart.map((l) => ({ ...l })), total: orderTotal(), t: Date.now() });
          cart = [];
          redirect(res, req, `/store/checkout/thankyou.html?order=${id}`);
        }
        break;
      }
      case '/store/checkout/thankyou.html': html(res, req, thankYouPage(url.searchParams.get('order') || '')); break;
      default:
        entry.status = 404;
        send(res, req, 404, 'text/plain', 'Not found');
    }
    return true;
  }

  return { handle, set, failNext, reset, snapshot, requests, orders: () => orders.map((o) => ({ ...o })) };
}
