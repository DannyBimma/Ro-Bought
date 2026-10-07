// Teach mode: the user points at each real button once, and Ro-Bought remembers a selector
// for it. While picking, the page's own clicks are swallowed (capture phase), so picking
// "Place order" can never press it. Ro-Bought refuses to learn buttons it must never click.
(() => {
  'use strict';

  const { MESSAGES, TEACH_FIELDS } = RoBought.constants;
  const F = RoBought.finder;
  const READ_FIELDS = new Set(['orderTotal', 'confirmation']); // read, never clicked

  let session = null; // { config, send, onClose, picking, hovered, note, testTimer }

  const fieldById = (id) => TEACH_FIELDS.find((f) => f.id === id);
  const shortText = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function fallbackText(field) {
    const presetId = RoBought.url.presetFor(session.config.productUrl);
    const adapter = RoBought.adapters.forUrl(session.config.productUrl);
    if (READ_FIELDS.has(field.id)) return 'built-in detection';
    if (field.id === 'dismissPopup') return 'not taught (Ro-Bought tries close / "No thanks" buttons)';
    const presets = adapter.selectors[field.id] || [];
    return presets.length ? `built-in (${RoBought.url.PRESET_NAMES[presetId]})` : 'matched by button text';
  }

  function statusOf(field) {
    const taught = (session.config.selectors || {})[field.id];
    const name = (t) => `“${shortText(t.label || t.selector)}”`;
    if (field.multi) return taught && taught.length ? `taught ${taught.map(name).join(', ')}` : fallbackText(field);
    return taught ? `taught ${name(taught)}` : fallbackText(field);
  }

  function model() {
    if (session.picking) {
      const field = fieldById(session.picking);
      return {
        pill: 'Teach', tone: 'on',
        title: `Click the “${field.label}” on this page`,
        body: 'Ro-Bought remembers it. Nothing on the page is pressed while you pick. Esc cancels.',
        hint: session.note,
        actions: [{ id: 'cancel', label: 'Cancel' }],
      };
    }
    return {
      pill: 'Teach', tone: 'on',
      title: 'Teach Ro-Bought the buttons',
      body: 'Visit each page (product, cart, checkout, final review) and pick the buttons there. Do not place the order.',
      hint: session.note,
      actions: [
        { id: 'done', label: 'Done', variant: 'primary' },
        { id: 'report', label: 'Copy page report' },
      ],
      rows: TEACH_FIELDS.map((f) => {
        const taught = (session.config.selectors || {})[f.id];
        const addMore = f.multi && Array.isArray(taught) && taught.length > 0;
        return {
          text: f.label,
          sub: `${f.where} · ${statusOf(f)}`,
          actions: [
            { id: `pick:${f.id}`, label: addMore ? 'Add' : 'Pick' },
            { id: `test:${f.id}`, label: 'Test' },
          ],
        };
      }),
    };
  }

  function render() {
    if (session) RoBought.overlay.render(model(), onAction);
  }

  function onAction(id) {
    if (!session) return;
    if (id === 'done') close();
    else if (id === 'report') copyReport();
    else if (id === 'cancel') stopPicking('Cancelled.');
    else if (id.startsWith('pick:')) startPicking(id.slice(5));
    else if (id.startsWith('test:')) test(id.slice(5));
  }

  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------

  const CAPTURE = { capture: true };
  const ownOrSynthetic = (e) => !e.isTrusted || RoBought.overlay.isOwnEvent(e);

  function targetFor(el) {
    if (!(el instanceof Element)) return null;
    return READ_FIELDS.has(session.picking) ? el : F.clickable(el);
  }

  function swallow(e) {
    if (ownOrSynthetic(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onMove(e) {
    if (ownOrSynthetic(e)) return;
    const t = targetFor(e.target);
    if (!t || t === session.hovered) return;
    session.hovered = t;
    RoBought.overlay.highlight(t, { tone: 'pick', label: shortText(F.labelOf(t) || t.tagName.toLowerCase(), 50) });
  }

  function onClick(e) {
    if (ownOrSynthetic(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = targetFor(e.target);
    if (t) pick(t);
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    stopPicking('Cancelled.');
  }

  const LISTENERS = [
    ['pointerdown', swallow], ['mousedown', swallow], ['pointerup', swallow], ['mouseup', swallow],
    ['click', onClick], ['dblclick', swallow], ['auxclick', swallow], ['submit', swallow],
    ['pointermove', onMove], ['keydown', onKey],
  ];

  function startPicking(fieldId) {
    if (!fieldById(fieldId)) return;
    stopPicking('');
    session.picking = fieldId;
    session.hovered = null;
    for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, CAPTURE);
    render();
  }

  function stopPicking(note) {
    if (!session) return;
    if (session.picking) {
      for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, CAPTURE);
    }
    session.picking = null;
    session.hovered = null;
    RoBought.overlay.clearHighlight();
    if (note !== undefined) session.note = note;
    render();
  }

  async function pick(el) {
    const field = fieldById(session.picking);
    const isRead = READ_FIELDS.has(field.id);
    const label = isRead ? '' : F.labelOf(el);
    if (!isRead && RoBought.adapters.neverClick(el, label)) {
      stopPicking(`Ro-Bought never clicks “${shortText(label || 'that')}” (instant-buy, upsell or sign-up). Pick a different button.`);
      return;
    }
    const selector = F.buildSelector(el) || '';
    if (!selector && !label) {
      stopPicking("Couldn't describe that element reliably. Try clicking the button itself, or its text.");
      return;
    }
    const s = session;
    // The same button for two different steps is almost always a mistake.
    const twin = TEACH_FIELDS.find((f) => {
      if (f.id === field.id) return false;
      const v = (s.config.selectors || {})[f.id];
      return [].concat(v || []).some((t) => t && selector && t.selector === selector);
    });
    const res = await s.send(MESSAGES.TEACH_SAVE, { field: field.id, selector, label });
    if (session !== s) return;
    if (res?.ok && res.selectors) {
      s.config = { ...s.config, selectors: res.selectors };
      const warning = twin ? ` Note: that's the same button you taught for “${twin.label}”. Each step usually has its own button, so check this.` : '';
      stopPicking(`Saved ${field.label}: “${shortText(label || selector, 60)}”.${warning}`);
    } else {
      stopPicking(res?.error || 'Could not save that.');
    }
  }

  // ---------------------------------------------------------------------------
  // Testing: show what Ro-Bought would use on this page
  // ---------------------------------------------------------------------------

  function test(fieldId) {
    const field = fieldById(fieldId);
    if (!field) return;
    const adapter = RoBought.adapters.forUrl(session.config.productUrl);
    const all = RoBought.checkout.specsFor(session.config, adapter);
    const spec = specFor(all, fieldId);
    clearTimeout(session.testTimer);
    const found = spec && F.find(document, spec);
    if (!found) {
      RoBought.overlay.clearHighlight();
      session.note = `${field.label}: not found on this page.`;
    } else {
      let what = F.labelOf(found.el) || found.el.tagName.toLowerCase();
      if (fieldId === 'orderTotal') {
        const price = RoBought.availability.parsePrice(found.el.textContent || '');
        what = price === null ? `“${shortText(what)}” (no amount read)` : `${price.toFixed(2)}`;
      }
      RoBought.overlay.highlight(found.el, { tone: 'pick', label: `${field.label} (${found.via})` });
      session.note = `${field.label}: found ${what} (${found.via}).`;
      session.testTimer = setTimeout(() => RoBought.overlay.clearHighlight(), 4000);
    }
    render();
  }

  function specFor(all, fieldId) {
    return {
      dismissPopup: all.dismissPopup, addToCart: all.addToCart, proceedToCheckout: all.proceed,
      checkoutContinue: all.continue, placeOrder: all.placeOrder, orderTotal: all.orderTotal,
      confirmation: all.confirmation,
    }[fieldId];
  }

  // ---------------------------------------------------------------------------
  // Page report: what Ro-Bought sees on this page, to paste to the developer.
  // Button/frame descriptions only — no page text, digits masked.
  // ---------------------------------------------------------------------------

  const RELEVANT = /cart|bag|basket|checkout|check out|order|buy|place|purchase|pay|continue|guest|sign|close|dismiss|thanks|not now|deal|prime|ship|deliver|address|payment/i;
  const mask = (v, n = 50) => String(v || '').replace(/\d{3,}/g, '#').replace(/\s+/g, ' ').trim().slice(0, n);

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${mask(el.id, 40)}` : '';
    const name = el.getAttribute('name') ? `[name=${mask(el.getAttribute('name'), 40)}]` : '';
    const cls = [...el.classList].slice(0, 2).map((c) => `.${mask(c, 30)}`).join('');
    const label = F.labelOf(el);
    const flags = [
      RoBought.dom.isVisible(el.closest('.a-button') || el, 2) ? 'visible' : 'hidden',
      RoBought.adapters.isDisabled(el) ? 'disabled' : '',
      RoBought.adapters.neverClick(el, label) ? 'NEVER-CLICK' : '',
    ].filter(Boolean).join(' ');
    return `${tag}${id}${name}${cls} "${mask(label)}" ${flags}`;
  }

  function pageReport() {
    const cfg = session.config;
    const adapter = RoBought.adapters.forUrl(cfg.productUrl);
    const all = RoBought.checkout.specsFor(cfg, adapter);
    const guard = RoBought.guards.detectBlocker(document, location, { checkout: true });
    const lines = [
      'Ro-Bought page report (button and frame details only; check it before sharing)',
      `v${chrome.runtime.getManifest().version} · preset ${RoBought.url.presetFor(cfg.productUrl)} · ${location.hostname}${mask(location.pathname, 80)}`,
      `page type: ${RoBought.checkout.pageTypeFor(cfg) || 'unrecognised'} · guard: ${guard ? `${guard.kind}/${guard.rule}` : 'none'}`,
      '',
      'fields:',
    ];
    for (const f of TEACH_FIELDS) {
      const spec = specFor(all, f.id);
      const found = spec && F.find(document, spec);
      const hidden = !found && spec && !spec.read && F.findPresent(document, spec);
      lines.push(`  ${f.id}: ${found ? `${found.via} → ${describe(found.el)}` : hidden ? `HIDDEN → ${describe(hidden)}` : 'not found'}`);
    }
    lines.push('', 'buttons:');
    let n = 0;
    for (const el of document.querySelectorAll(F.CLICKABLE)) {
      const label = F.labelOf(el);
      if (!RELEVANT.test(`${label} ${el.id} ${el.getAttribute('name') || ''}`)) continue;
      lines.push(`  ${describe(el)}`);
      if (++n >= 40) break;
    }
    lines.push('', 'pop-ups:');
    for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .a-popover-modal, .a-sheet-web')) {
      if (!RoBought.dom.isVisible(d, 50)) continue;
      const buttons = [...d.querySelectorAll(F.CLICKABLE)].slice(0, 6).map((b) => `"${mask(F.labelOf(b), 30)}"`).join(', ');
      lines.push(`  ${d.tagName.toLowerCase()}${d.id ? `#${mask(d.id, 40)}` : ''} buttons: ${buttons || '—'}`);
    }
    lines.push('', 'frames (visible, 100px+):');
    for (const f of document.querySelectorAll('iframe')) {
      if (!RoBought.dom.isVisible(f, 100)) continue;
      let src = '';
      try {
        const u = new URL(f.getAttribute('src') || '', location.href);
        src = `${u.hostname}${mask(u.pathname, 40)}`;
      } catch {
        src = '?';
      }
      lines.push(`  iframe${f.id ? `#${mask(f.id, 30)}` : ''} name=${mask(f.getAttribute('name') || '', 30)} title=${mask(f.title, 30)} src=${src}`);
    }
    return lines.join('\n');
  }

  async function copyReport() {
    const text = pageReport();
    try {
      await navigator.clipboard.writeText(text);
      session.note = 'Copied a page report (button and frame details only). Paste it to the developer.';
    } catch {
      console.info(text); // fallback: visible in DevTools
      session.note = "Couldn't copy (click the page once, then try again). The report is also in this tab's DevTools console.";
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * @param {{config: object, send: Function, onClose: Function}} opts
   */
  function open({ config, send, onClose }) {
    if (session) close();
    session = { config: { ...config }, send, onClose, picking: null, hovered: null, note: '', testTimer: 0 };
    render();
  }

  function close() {
    if (!session) return;
    stopPicking();
    clearTimeout(session.testTimer);
    RoBought.overlay.clearHighlight();
    const { onClose } = session;
    session = null;
    if (onClose) onClose();
  }

  RoBought.teach = Object.freeze({ open, close, isOpen: () => !!session });
})();
