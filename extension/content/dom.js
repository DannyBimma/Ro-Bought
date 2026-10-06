// Small DOM helpers for the content script. No state, no listeners.
(() => {
  'use strict';

  /**
   * True if the element is actually rendered for the user: not display:none,
   * visibility:hidden or opacity:0 (itself or via an ancestor), at least `minSize` px in
   * both dimensions, and not parked far off-screen (a common trick for hidden widgets).
   */
  function isVisible(el, minSize = 1) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      const visible = el.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        checkOpacity: true,       // older spelling (Chrome < 121)
        checkVisibilityCSS: true, // older spelling (Chrome < 121)
      });
      if (!visible) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < minSize || r.height < minSize) return false;
    if (r.bottom + window.scrollY <= 0 || r.right + window.scrollX <= 0) return false;
    return true;
  }

  /** Whitespace-collapsed text content, capped so huge nodes can't cost much. */
  function textOf(el, max = 300) {
    const raw = el && el.textContent ? el.textContent : '';
    return raw.slice(0, max * 4).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /** First element matching `selector` that is visible, checking at most `limit` matches. */
  function firstVisible(root, selector, minSize = 1, limit = 8) {
    const list = root.querySelectorAll(selector);
    const n = Math.min(list.length, limit);
    for (let i = 0; i < n; i++) {
      if (isVisible(list[i], minSize)) return list[i];
    }
    return null;
  }

  RoBought.dom = Object.freeze({ isVisible, textOf, firstVisible });
})();
