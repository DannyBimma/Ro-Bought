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
    .bolt { color: #ffd60a; font-size: 15px; }
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
    .collapsed .title, .collapsed .body, .collapsed .hint, .collapsed .actions { display: none; }
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
    header.append(el('span', 'bolt', '⚡'), el('span', 'name', 'Ro-Bought'), pill, toggle);

    const title = el('p', 'title');
    const body = el('p', 'body');
    const hint = el('p', 'hint');
    const actions = el('div', 'actions');
    panel.append(header, title, body, hint, actions);
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

    parts = { panel, pill, title, body, hint, actions };
    ensureAttached();
  }

  /** Re-attach if the page removed us (e.g. a framework re-rendering <html>). */
  function ensureAttached() {
    if (host && !host.isConnected && document.documentElement) document.documentElement.append(host);
  }

  /**
   * @param {null | {pill: string, tone?: string, title?: string, body?: string, hint?: string,
   *   actions?: Array<{id: string, label: string, variant?: string}>}} model — null hides the panel
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

    const buttons = (model.actions || []).map(({ id, label, variant }) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.dataset.action = id;
      if (variant) b.dataset.variant = variant;
      return b;
    });
    parts.actions.replaceChildren(...buttons);
    parts.actions.hidden = buttons.length === 0;
    ensureAttached();
  }

  function remove() {
    if (host) host.remove();
    host = null;
    parts = null;
    actionHandler = null;
    collapsed = false;
  }

  RoBought.overlay = Object.freeze({ render, remove, ensureAttached });
})();
