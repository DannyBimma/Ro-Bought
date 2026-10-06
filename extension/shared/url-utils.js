(() => {
  'use strict';

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

  /**
   * Parses and validates a product URL. Only https is allowed, except plain http on
   * localhost (used for the offline mock store). Credentials in URLs are rejected.
   * @returns {URL|null}
   */
  function parseProductUrl(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > RoBought.constants.LIMITS.URL_MAX) return null;
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const isLocal = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null;
    if (url.username || url.password) return null;
    if (!url.hostname || (!isLocal && !url.hostname.includes('.'))) return null;
    url.hash = '';
    return url;
  }

  const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

  /** Hostname without a leading "www." — amazon.com and www.amazon.com are one store. */
  function baseHost(hostname) {
    return String(hostname).toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  }

  /**
   * Chrome match patterns for the retailer's site: the bare host plus its www. variant
   * (any port, any path). Nothing broader — other subdomains are out of scope.
   * Chrome match patterns cannot carry a port, so localhost:8080 becomes http://localhost/*.
   * @returns {string[]} empty if the URL is invalid
   */
  function scopePatterns(url) {
    const u = url instanceof URL ? url : parseProductUrl(url);
    if (!u) return [];
    const base = baseHost(u.hostname);
    if (LOCAL_HOSTS.has(base) || IPV4.test(base)) return [`${u.protocol}//${base}/*`];
    return [`${u.protocol}//${base}/*`, `${u.protocol}//www.${base}/*`];
  }

  /** True when `candidate` is on the same retailer site as `productUrl` (see scopePatterns). */
  function inScope(candidate, productUrl) {
    try {
      const c = candidate instanceof URL ? candidate : new URL(candidate);
      const p = productUrl instanceof URL ? productUrl : new URL(productUrl);
      return c.protocol === p.protocol && baseHost(c.hostname) === baseHost(p.hostname);
    } catch {
      return false;
    }
  }

  RoBought.url = Object.freeze({ parseProductUrl, scopePatterns, inScope, baseHost });
})();
