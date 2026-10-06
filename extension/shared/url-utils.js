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

  /**
   * Chrome match pattern covering the product's origin (any port, any path).
   * Chrome match patterns cannot carry a port, so localhost:8080 becomes http://localhost/*.
   */
  function originPattern(url) {
    const u = url instanceof URL ? url : parseProductUrl(url);
    if (!u) return null;
    return `${u.protocol}//${u.hostname}/*`;
  }

  /** True when both URLs share scheme + hostname (port ignored, matching originPattern). */
  function sameHost(a, b) {
    try {
      const ua = a instanceof URL ? a : new URL(a);
      const ub = b instanceof URL ? b : new URL(b);
      return ua.protocol === ub.protocol && ua.hostname === ub.hostname;
    } catch {
      return false;
    }
  }

  RoBought.url = Object.freeze({ parseProductUrl, originPattern, sameHost });
})();
