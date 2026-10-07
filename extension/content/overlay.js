// In-page status panel. Lives in a *closed* shadow root so the retailer's CSS can't
// restyle it and page scripts can't read or click into it. Built with createElement and
// textContent only — no HTML strings.
(() => {
  'use strict';

  const CSS = `
    :host { all: initial; }
    .panel {
      box-sizing: border-box;
      width: 300px;
      max-width: calc(100vw - 32px);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #f1f4f2;
      background: #151a18;
      border: 1px solid #2f3a36;
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      padding: 10px 12px;
    }
    header { display: flex; align-items: center; gap: 8px; }
    .logo { font-size: 15px; line-height: 1; }
    .name { font-weight: 700; flex: 1; }
    .pill {
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
      padding: 2px 7px; border-radius: 999px; background: #3a4440; color: #fff;
    }
    .pill[data-tone="on"] { background: #166552; }
    .pill[data-tone="warn"] { background: #b45309; }
    .pill[data-tone="bad"] { background: #b91c1c; }
    .title { font-weight: 700; margin: 8px 0 2px; }
    .body, .hint { margin: 4px 0 0; overflow-wrap: anywhere; }
    .hint { color: #b5c0bb; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    button {
      font: inherit; font-weight: 600; cursor: pointer;
      padding: 5px 10px; border-radius: 6px;
      border: 1px solid #3a4440; background: #232b28; color: #f1f4f2;
    }
    button[data-variant="primary"] { background: #3fb68f; border-color: #3fb68f; color: #0b1210; }
    button[data-variant="danger"] { background: #b91c1c; border-color: #b91c1c; color: #fff; }
    button.icon { padding: 0 7px; line-height: 20px; }
    button:focus-visible { outline: 2px solid #ffd60a; outline-offset: 1px; }
    .collapsed .title, .collapsed .body, .collapsed .hint, .collapsed .actions, .collapsed .rows { display: none; }
    .panel.wide { width: 380px; }
    .rows { margin-top: 8px; max-height: 50vh; overflow-y: auto; border-top: 1px solid #2f3a36; }
    .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #232b28; }
    .row .what { flex: 1; min-width: 0; }
    .row .sub { color: #b5c0bb; font-size: 11px; overflow-wrap: anywhere; }
    .row button { padding: 3px 8px; font-size: 12px; }
  `;

  const HIGHLIGHT_CSS = `
    :host { all: initial; }
    .box {
      position: fixed; box-sizing: border-box; pointer-events: none;
      border: 3px solid #ffd60a; border-radius: 6px;
      box-shadow: 0 0 0 3px rgba(21, 26, 24, 0.85), 0 0 18px 4px rgba(255, 214, 10, 0.6);
    }
    .box[data-tone="pick"] { border-color: #3fb68f; box-shadow: 0 0 0 2px rgba(21, 26, 24, 0.85); }
    .tag {
      position: absolute; left: -3px; bottom: 100%; margin-bottom: 4px; white-space: nowrap;
      font: 600 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #ffd60a; color: #151a18; padding: 2px 6px; border-radius: 4px;
    }
    .box[data-tone="pick"] .tag { background: #3fb68f; }
  `;

  let host = null;
  let parts = null;
  let collapsed = false;
  let actionHandler = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function build() {
    host = document.createElement('robought-panel');
    for (const [prop, value] of [
      ['all', 'initial'], ['position', 'fixed'], ['right', '16px'], ['bottom', '16px'],
      ['z-index', '2147483647'], ['display', 'block'],
    ]) {
      host.style.setProperty(prop, value, 'important');
    }
    const root = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = CSS;

    const panel = el('section', 'panel');
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.setAttribute('aria-label', 'Ro-Bought');

    const header = el('header');
    const pill = el('span', 'pill');
    const toggle = el('button', 'icon', '–');
    toggle.dataset.action = 'collapse';
    toggle.title = 'Collapse';
    header.append(el('span', 'logo', '🤖'), el('span', 'name', 'Ro-Bought'), pill, toggle);

    const title = el('p', 'title');
    const body = el('p', 'body');
    const hint = el('p', 'hint');
    const actions = el('div', 'actions');
    const rows = el('div', 'rows');
    panel.append(header, title, body, hint, actions, rows);
    root.append(style, panel);

    root.addEventListener('click', (ev) => {
      if (!ev.isTrusted) return; // ignore synthetic clicks
      const button = ev.target instanceof Element ? ev.target.closest('button[data-action]') : null;
      if (!button) return;
      const id = button.dataset.action;
      if (id === 'collapse') {
        collapsed = !collapsed;
        panel.classList.toggle('collapsed', collapsed);
        toggle.textContent = collapsed ? '+' : '–';
        toggle.title = collapsed ? 'Expand' : 'Collapse';
        return;
      }
      if (actionHandler) actionHandler(id);
    });

    parts = { panel, pill, title, body, hint, actions, rows };
    ensureAttached();
  }

  function makeButton({ id, label, variant }) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.action = id;
    if (variant) b.dataset.variant = variant;
    return b;
  }

  /** Re-attach if the page removed us (e.g. a framework re-rendering <html>). */
  function ensureAttached() {
    if (host && !host.isConnected && document.documentElement) document.documentElement.append(host);
  }

  /**
   * @param {null | {pill: string, tone?: string, title?: string, body?: string, hint?: string,
   *   actions?: Array<{id: string, label: string, variant?: string}>,
   *   rows?: Array<{text: string, sub?: string, actions?: Array<{id: string, label: string, variant?: string}>}>}} model
   *   — null hides the panel
   * @param {(actionId: string) => void} [onAction]
   */
  function render(model, onAction) {
    if (!model) {
      remove();
      return;
    }
    if (!host) build();
    actionHandler = onAction || null;
    parts.pill.textContent = model.pill;
    parts.pill.dataset.tone = model.tone || '';
    parts.title.textContent = model.title || '';
    parts.title.hidden = !model.title;
    parts.body.textContent = model.body || '';
    parts.body.hidden = !model.body;
    parts.hint.textContent = model.hint || '';
    parts.hint.hidden = !model.hint;

    const buttons = (model.actions || []).map(makeButton);
    parts.actions.replaceChildren(...buttons);
    parts.actions.hidden = buttons.length === 0;

    const rows = (model.rows || []).map((r) => {
      const row = el('div', 'row');
      const what = el('div', 'what');
      what.append(el('div', '', r.text));
      if (r.sub) what.append(el('div', 'sub', r.sub));
      row.append(what, ...(r.actions || []).map(makeButton));
      return row;
    });
    parts.rows.replaceChildren(...rows);
    parts.rows.hidden = rows.length === 0;
    parts.panel.classList.toggle('wide', rows.length > 0);
    ensureAttached();
  }

  function remove() {
    if (host) host.remove();
    host = null;
    parts = null;
    actionHandler = null;
    collapsed = false;
  }

  /** True if the event happened inside Ro-Bought's own panel. */
  function isOwnEvent(ev) {
    return !!host && ev.composedPath().includes(host);
  }

  // ---------------------------------------------------------------------------
  // Highlight: a box drawn over a page element (the element itself is never modified)
  // ---------------------------------------------------------------------------

  let hl = null; // { host, box, tag, target, frame, onMove }

  function positionHighlight() {
    if (!hl) return;
    hl.frame = 0;
    if (!hl.target.isConnected) {
      clearHighlight();
      return;
    }
    const r = hl.target.getBoundingClientRect();
    const pad = 4;
    Object.assign(hl.box.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
  }

  /**
   * @param {Element} target
   * @param {{tone?: 'ready'|'pick', label?: string}} [opts]
   */
  function highlight(target, { tone = 'ready', label = '' } = {}) {
    if (hl && hl.target === target) {
      hl.box.dataset.tone = tone;
      hl.tag.textContent = label;
      hl.tag.hidden = !label;
      return;
    }
    clearHighlight();
    if (!(target instanceof Element)) return;
    const hlHost = document.createElement('robought-highlight');
    for (const [prop, value] of [['all', 'initial'], ['position', 'fixed'], ['inset', '0'], ['pointer-events', 'none'], ['z-index', '2147483646']]) {
      hlHost.style.setProperty(prop, value, 'important');
    }
    const root = hlHost.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = HIGHLIGHT_CSS;
    const box = el('div', 'box');
    box.dataset.tone = tone;
    const tag = el('div', 'tag', label);
    tag.hidden = !label;
    box.append(tag);
    root.append(style, box);
    const onMove = () => {
      if (hl && !hl.frame) hl.frame = requestAnimationFrame(positionHighlight);
    };
    hl = { host: hlHost, box, tag, target, frame: 0, onMove };
    window.addEventListener('scroll', onMove, { capture: true, passive: true });
    window.addEventListener('resize', onMove, { passive: true });
    document.documentElement.append(hlHost);
    positionHighlight();
  }

  function clearHighlight() {
    if (!hl) return;
    window.removeEventListener('scroll', hl.onMove, { capture: true });
    window.removeEventListener('resize', hl.onMove);
    if (hl.frame) cancelAnimationFrame(hl.frame);
    hl.host.remove();
    hl = null;
  }

  RoBought.overlay = Object.freeze({ render, remove, ensureAttached, isOwnEvent, highlight, clearHighlight });
})();
