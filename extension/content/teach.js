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
      actions: [{ id: 'done', label: 'Done', variant: 'primary' }],
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
    const res = await s.send(MESSAGES.TEACH_SAVE, { field: field.id, selector, label });
    if (session !== s) return;
    if (res?.ok && res.selectors) {
      s.config = { ...s.config, selectors: res.selectors };
      stopPicking(`Saved ${field.label}: “${shortText(label || selector, 60)}”.`);
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
    const spec = {
      addToCart: all.addToCart, proceedToCheckout: all.proceed, checkoutContinue: all.continue,
      placeOrder: all.placeOrder, orderTotal: all.orderTotal, confirmation: all.confirmation,
    }[fieldId];
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
