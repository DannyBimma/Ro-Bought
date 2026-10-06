(() => {
  'use strict';

  const {
    STORAGE_KEYS, MESSAGES, RUN_STATUS, ACTIVE_STATUSES, TERMINAL_STATUSES, STATUS_LABELS, PAUSE_HINTS,
    CONTENT_GUARD_KINDS,
  } = RoBought.constants;
  const $ = (id) => document.getElementById(id);

  let ticketReason = null;
  let latest = null; // last GET_STATUS result, re-rendered by the 1 s ticker

  function send(type) {
    return chrome.runtime.sendMessage({ type });
  }

  function showError(text) {
    $('error').textContent = text || '';
    $('error').hidden = !text;
  }

  function render({ state, config, configValid, configErrors }) {
    const [label, tone] = STATUS_LABELS[state.status] || [state.status, ''];
    $('statusPill').textContent = label;
    $('statusPill').dataset.tone = tone;

    $('noConfig').hidden = !!config;
    $('configSummary').hidden = !config;
    if (config) {
      $('sumProduct').textContent = config.productName || '(unnamed)';
      $('sumHost').textContent = safeHost(config.productUrl);
      $('sumTrigger').textContent = config.triggerMode === 'scheduled'
        ? `Drop at ${config.dropTime ? new Date(config.dropTime).toLocaleString() : '—'}`
        : `Restock watch, every ~${config.restockIntervalSec}s`;
      $('sumFinal').textContent = config.stopBeforePlaceOrder ? 'You click "Place order"' : 'Bot places the order';
    }
    const cfgErr = config && !configValid && configErrors[0] ? configErrors[0].message : '';
    $('configError').textContent = cfgErr;
    $('configError').hidden = !cfgErr;

    const paused = state.status === RUN_STATUS.PAUSED;
    const pause = paused ? state.pause || {} : null;
    $('pauseBox').hidden = !paused;
    $('resume').hidden = !paused;
    if (paused) {
      $('pauseTitle').textContent = pause.cleared ? 'Looks clear — your call' : 'Paused — your turn';
      $('pauseLabel').textContent = pause.label || '';
      $('pauseHint').textContent = pause.cleared ? 'Click Resume when you are ready.' : PAUSE_HINTS[pause.kind] || '';
      // "anyway" only when overriding an on-page check that is still showing.
      const anyway = !pause.cleared && CONTENT_GUARD_KINDS.includes(pause.kind);
      $('resume').textContent = anyway ? 'Resume anyway' : 'Resume';
    }
    $('message').textContent = paused ? '' : state.message || '';

    const active = ACTIVE_STATUSES.includes(state.status);
    const terminal = TERMINAL_STATUSES.includes(state.status);
    $('arm').hidden = active || terminal;
    $('arm').disabled = !configValid || !!ticketReason;
    $('disarm').hidden = !active;
    $('reset').hidden = !terminal;

    renderEvents(state.events || []);
    renderWatchLine();
  }

  function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  /** One live line: the countdown to a drop, or what the last restock check found. */
  function renderWatchLine() {
    const line = $('watchLine');
    if (!latest) return;
    const { state, config, watch } = latest;
    const now = Date.now();
    let text = '';
    if (state.status === RUN_STATUS.WAITING && config?.dropTime) {
      text = `Drop in ${duration(config.dropTime - now)}`;
      const offset = watch?.clockOffsetMs ?? 0;
      if (Math.abs(offset) >= 500) text += ` · store clock ${offset > 0 ? '+' : ''}${(offset / 1000).toFixed(1)}s`;
    } else if (state.status === RUN_STATUS.WATCHING && watch) {
      const parts = [];
      if (watch.lastCheckAt) parts.push(`Checked ${duration(now - watch.lastCheckAt)} ago${watch.lastDetail ? `: ${watch.lastDetail}` : ''}`);
      if (watch.backoffUntil > now) parts.push(`backing off ${duration(watch.backoffUntil - now)}`);
      else if (watch.nextCheckAt > now) parts.push(`next in ~${duration(watch.nextCheckAt - now)}`);
      parts.push(watch.method === 'reload' ? 'by reloading the page' : 'via page source');
      text = parts.join(' · ');
    }
    line.textContent = text;
    line.hidden = !text;
  }

  function renderEvents(events) {
    const list = $('events');
    const frag = document.createDocumentFragment();
    for (const ev of events.slice(-20).reverse()) {
      const li = document.createElement('li');
      li.dataset.level = ev.level;
      li.textContent = `${new Date(ev.t).toLocaleTimeString()} — ${ev.text}`;
      frag.append(li);
    }
    list.replaceChildren(frag);
  }

  function safeHost(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '—';
    }
  }

  async function refresh() {
    const res = await send(MESSAGES.GET_STATUS);
    if (res?.ok) {
      latest = res;
      render(res);
    } else {
      showError(res?.error || 'Could not reach the extension.');
    }
  }

  async function command(type) {
    showError('');
    for (const b of document.querySelectorAll('.buttons button')) b.disabled = true;
    try {
      const res = await send(type);
      if (!res?.ok) showError(res?.error || 'Something went wrong.');
    } finally {
      for (const b of document.querySelectorAll('.buttons button')) b.disabled = false;
      await refresh();
    }
  }

  async function checkActiveTab() {
    // activeTab is granted by opening this popup, so the current tab's URL is readable.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    ticketReason = tab?.url ? RoBought.ticketGuard.checkUrl(tab.url) : null;
    if (ticketReason) {
      $('ticketBlock').textContent =
        `Ro-Bought is disabled on ticket sites. ${ticketReason} Automated ticket buying is restricted by law (e.g. the US BOTS Act).`;
      $('ticketBlock').hidden = false;
    }
  }

  $('arm').addEventListener('click', () => command(MESSAGES.ARM));
  $('resume').addEventListener('click', () => command(MESSAGES.RESUME));
  $('disarm').addEventListener('click', () => command(MESSAGES.DISARM));
  $('reset').addEventListener('click', () => command(MESSAGES.RESET));
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[STORAGE_KEYS.RUN_STATE] || changes[STORAGE_KEYS.CONFIG])) refresh();
    if (area === 'session' && changes[STORAGE_KEYS.WATCH]) refresh();
  });
  // The popup only lives while it's open, so a 1 s ticker for the countdown is cheap.
  setInterval(renderWatchLine, 1000);

  checkActiveTab()
    .catch(() => {})
    .then(refresh)
    .catch((e) => showError(e.message));
})();
