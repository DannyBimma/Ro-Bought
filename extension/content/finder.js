// Finding buttons: taught selectors first, then retailer presets, then exact button text.
// Every candidate must be visible, enabled, and pass the never-click rules.
(() => {
  'use strict';

  const { isVisible } = RoBought.dom;
  const { isDisabled, neverClick } = RoBought.adapters;

  const CLICKABLE = 'button, a[href], input[type="submit"], input[type="button"], input[type="image"], [role="button"]';
  const TEXT_SCAN_LIMIT = 800;

  function labelOf(el) {
    let raw = el.tagName === 'INPUT' ? el.value || el.getAttribute('aria-label') || '' : el.textContent || el.getAttribute('aria-label') || '';
    if (!raw.trim() && el.getAttribute('aria-labelledby')) {
      raw = el.getAttribute('aria-labelledby').split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
    }
    if (!raw.trim()) raw = el.closest('.a-button')?.textContent || ''; // Amazon: label beside the input
    return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** What the user sees for a control: Amazon's near-transparent inputs are drawn by a wrapper. */
  const visualOf = (el) => (el.matches('input.a-button-input') && el.closest('.a-button')) || el;

  function safeAll(root, selector) {
    try {
      return root.querySelectorAll(selector);
    } catch {
      return [];
    }
  }

  /** For clicks: visible, enabled, and allowed. For reads (totals): just visible. */
  function usable(el, forClick) {
    if (!isVisible(visualOf(el), 2)) return false;
    if (!forClick) return true;
    return !isDisabled(el) && !neverClick(el, labelOf(el));
  }

  function bySelectors(doc, selectors, forClick) {
    for (const sel of selectors) {
      const list = safeAll(doc, sel);
      for (let i = 0; i < Math.min(list.length, 10); i++) {
        if (usable(list[i], forClick)) return list[i];
      }
    }
    return null;
  }

  function byText(doc, re, forClick) {
    const list = doc.querySelectorAll(forClick ? CLICKABLE : 'span, div, p, td, dd, strong, b, h1, h2, h3, h4');
    for (let i = 0; i < Math.min(list.length, TEXT_SCAN_LIMIT); i++) {
      if (re.test(labelOf(list[i])) && usable(list[i], forClick)) return list[i];
    }
    return null;
  }

  const exactText = (label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  /**
   * @param {Document} doc
   * @param {{taught?: Array<{selector: string, label: string}>, presets?: string[], text?: RegExp, read?: boolean}} spec
   *   read: the element is read (an order total), not clicked
   * @returns {{el: Element, via: 'taught'|'preset'|'text'} | null}
   */
  function find(doc, spec) {
    const forClick = !spec.read;
    for (const t of spec.taught || []) {
      const el = (t.selector && bySelectors(doc, [t.selector], forClick)) || (t.label && byText(doc, exactText(t.label), forClick));
      if (el) return { el, via: 'taught' };
    }
    const preset = bySelectors(doc, spec.presets || [], forClick);
    if (preset) return { el: preset, via: 'preset' };
    if (spec.text) {
      const el = byText(doc, spec.text, forClick);
      if (el) return { el, via: 'text' };
    }
    return null;
  }

  /**
   * Resolves with the first truthy value of `fn()`, re-checking on DOM changes, or null
   * after `timeoutMs`. Rejects if `signal` aborts. Cleans up its observer and timers.
   */
  function waitFor(fn, timeoutMs, signal) {
    const first = fn();
    if (first) return Promise.resolve(first);
    return new Promise((resolve, reject) => {
      let pending = null;
      const finish = (value, err) => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(pending);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value);
      };
      const recheck = () => {
        pending = null;
        const v = fn();
        if (v) finish(v);
      };
      const observer = new MutationObserver(() => {
        if (pending === null) pending = setTimeout(recheck, 50);
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(fn() || null), timeoutMs);
      const onAbort = () => finish(null, signal.reason);
      if (signal?.aborted) {
        finish(null, signal.reason);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  const waitFind = (doc, spec, timeoutMs, signal) => waitFor(() => find(doc, spec), timeoutMs, signal);

  /** The clickable element a click on `el` belongs to (e.g. the <button> around a <span>). */
  function clickable(el) {
    if (!(el instanceof Element)) return el;
    const wrap = el.closest('.a-button'); // Amazon: the real input sits beside the label
    const inner = wrap && wrap.querySelector('input.a-button-input, input[type="submit"], button');
    return inner || el.closest(CLICKABLE) || el;
  }

  /**
   * Like find(), but ignores visibility: is a usable (enabled, allowed) control present at all?
   * Tells "hidden behind a pop-up or a collapsed panel" apart from "not on the page".
   */
  function findPresent(doc, spec) {
    const ok = (el) => !isDisabled(el) && !neverClick(el, labelOf(el));
    for (const t of spec.taught || []) {
      if (t.selector) for (const el of safeAll(doc, t.selector)) if (ok(el)) return el;
    }
    for (const sel of spec.presets || []) for (const el of safeAll(doc, sel)) if (ok(el)) return el;
    if (spec.text) {
      const list = doc.querySelectorAll(CLICKABLE);
      for (let i = 0; i < Math.min(list.length, TEXT_SCAN_LIMIT); i++) {
        if (spec.text.test(labelOf(list[i])) && ok(list[i])) return list[i];
      }
    }
    return null;
  }

  /**
   * Builds a selector that matches exactly `el`, preferring attributes that survive page
   * updates (stable ids, test ids, names) over positions. Returns null if no unique selector.
   */
  function buildSelector(el) {
    const doc = el.ownerDocument;
    const unique = (sel) => {
      const m = safeAll(doc, sel);
      return m.length === 1 && m[0] === el;
    };
    const quote = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
    const stableId = (id) => !!id && id.length <= 64 && !/\d{3,}|[a-f0-9]{8,}|^:|^ember\d|^react/i.test(id);
    const tag = el.tagName.toLowerCase();

    if (stableId(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    for (const attr of ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-action', 'name', 'aria-label', 'data-feature-id']) {
      const v = el.getAttribute(attr);
      if (v && v.length <= 80 && unique(`${tag}[${attr}=${quote(v)}]`)) return `${tag}[${attr}=${quote(v)}]`;
    }
    if (tag === 'input' && el.value && el.value.length <= 60 && unique(`input[value=${quote(el.value)}]`)) {
      return `input[value=${quote(el.value)}]`;
    }
    const classes = [...el.classList]
      .filter((c) => c.length <= 40 && !/\d{3,}|^css-|^sc-|^jsx-|__[a-z0-9]{5}|[A-Za-z0-9]{6,}_[A-Za-z0-9]{4,}/.test(c))
      .slice(0, 3);
    if (classes.length) {
      const sel = `${tag}.${classes.map((c) => CSS.escape(c)).join('.')}`;
      if (unique(sel)) return sel;
    }
    // Position path from the nearest ancestor with a stable id (or <body>).
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.body && parts.length < 8) {
      if (node !== el && stableId(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (!parent) break;
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      const t = node.tagName.toLowerCase();
      parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(node) + 1})` : t);
      node = parent;
    }
    if (!parts.length) return null;
    if (!parts[0].startsWith('#')) parts.unshift('body');
    const sel = parts.join(' > ');
    return unique(sel) ? sel : null;
  }

  RoBought.finder = Object.freeze({ find, findPresent, waitFor, waitFind, clickable, buildSelector, labelOf, CLICKABLE });
})();
