(() => {
  'use strict';

  const { STORAGE_KEYS, MESSAGES, RUN_STATUS, ACTIVE_STATUSES, TERMINAL_STATUSES } = RoBought.constants;
  const $ = (id) => document.getElementById(id);

  const STATUS_LABEL = {
    [RUN_STATUS.IDLE]: ['Off', ''],
    [RUN_STATUS.ARMED]: ['Armed', 'on'],
    [RUN_STATUS.WAITING]: ['Waiting', 'on'],
    [RUN_STATUS.WATCHING]: ['Watching', 'on'],
    [RUN_STATUS.EXECUTING]: ['Buying', 'warn'],
    [RUN_STATUS.PAUSED]: ['Your turn', 'bad'],
    [RUN_STATUS.AWAITING_USER]: ['Your click', 'warn'],
    [RUN_STATUS.COMPLETED]: ['Done', 'on'],
    [RUN_STATUS.ABORTED]: ['Stopped', ''],
    [RUN_STATUS.ERROR]: ['Error', 'bad'],
  };

  let ticketReason = null;

  function send(type) {
    return chrome.runtime.sendMessage({ type });
  }

  function showError(text) {
    $('error').textContent = text || '';
    $('error').hidden = !text;
  }

  function render({ state, config, configValid, configErrors }) {
    const [label, tone] = STATUS_LABEL[state.status] || [state.status, ''];
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

    $('message').textContent = state.message || '';

    const active = ACTIVE_STATUSES.includes(state.status);
    const terminal = TERMINAL_STATUSES.includes(state.status);
    $('arm').hidden = active || terminal;
    $('arm').disabled = !configValid || !!ticketReason;
    $('disarm').hidden = !active;
    $('reset').hidden = !terminal;

    renderEvents(state.events || []);
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
    if (res?.ok) render(res);
    else showError(res?.error || 'Could not reach the extension.');
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
  $('disarm').addEventListener('click', () => command(MESSAGES.DISARM));
  $('reset').addEventListener('click', () => command(MESSAGES.RESET));
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[STORAGE_KEYS.RUN_STATE] || changes[STORAGE_KEYS.CONFIG])) refresh();
  });

  checkActiveTab()
    .catch(() => {})
    .then(refresh)
    .catch((e) => showError(e.message));
})();
