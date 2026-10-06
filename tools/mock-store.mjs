// A tiny in-memory "store" for rehearsing drops and restocks without a real retailer.
// Used by tools/serve.mjs (manual testing) and tests/e2e/run.mjs (automated).
//
//   /store/product.html  server-rendered product page (JSON-LD + Add to cart button)
//   /store/spa.html      client-rendered product page (stock is fetched after load)
//   /store/api/stock     JSON stock endpoint used by spa.html
//   /__control?stock=in|out&price=…&dropIn=<seconds>&dropAt=<epoch ms>&skewMs=…&fail=429:2:5&reset=1
//   /__control/log       recent requests (for checking polite intervals)

const LOG_MAX = 2000;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createMockStore() {
  const initial = () => ({ stock: 'out', price: 499.99, dropAt: 0, skewMs: 0 });
  let state = initial();
  let failQueue = []; // [{ status, retryAfter }]
  let log = [];

  const inStock = () => state.stock === 'in' || (state.dropAt > 0 && Date.now() >= state.dropAt);

  function set(patch) {
    if (patch.stock === 'in' || patch.stock === 'out') state.stock = patch.stock;
    for (const key of ['price', 'dropAt', 'skewMs']) {
      if (patch[key] !== undefined && Number.isFinite(Number(patch[key]))) state[key] = Number(patch[key]);
    }
    return snapshot();
  }

  /** The next `count` product-page GETs answer `status` (e.g. 429) with Retry-After. */
  function failNext(status, count = 1, retryAfter = null) {
    for (let i = 0; i < count; i++) failQueue.push({ status, retryAfter });
  }

  function reset() {
    state = initial();
    failQueue = [];
    log = [];
  }

  const snapshot = () => ({ ...state, inStock: inStock(), pendingFailures: failQueue.length });
  const requests = (filter = () => true) => log.filter(filter);

  function nav() {
    let links = '';
    for (let i = 1; i <= 40; i++) links += `<a href="/store/category-${i}.html">Category ${i}</a> `;
    return `<nav>${links}</nav>`;
  }

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
<button id="add-to-cart"${available ? '' : ' disabled'}>Add to cart</button></main></body></html>`;
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
      (inStock ? '<button id="add-to-cart">Add to cart</button>' : '<button id="notify">Notify me</button>');
  }, 400);
</script></body></html>`;
  }

  function send(res, req, status, type, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      Date: new Date(Date.now() + state.skewMs).toUTCString(),
      ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

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
    if (url.pathname === '/store/product.html') {
      send(res, req, 200, 'text/html; charset=utf-8', productPage());
    } else if (url.pathname === '/store/spa.html') {
      send(res, req, 200, 'text/html; charset=utf-8', spaPage());
    } else if (url.pathname === '/store/api/stock') {
      send(res, req, 200, 'application/json', JSON.stringify({ inStock: inStock(), price: state.price }));
    } else {
      entry.status = 404;
      send(res, req, 404, 'text/plain', 'Not found');
    }
    return true;
  }

  return { handle, set, failNext, reset, snapshot, requests };
}
