(() => {
  'use strict';

  const { STORAGE_KEYS, LIMITS, ACTIVE_STATUSES, MESSAGES } = RoBought.constants;
  const $ = (id) => document.getElementById(id);
  const form = $('form');

  const NUMERIC_FIELDS = {
    fireOffsetMs: [LIMITS.FIRE_OFFSET_MS_MIN, LIMITS.FIRE_OFFSET_MS_MAX],
    restockIntervalSec: [LIMITS.RESTOCK_INTERVAL_MIN, LIMITS.RESTOCK_INTERVAL_MAX],
    jitterPct: [LIMITS.JITTER_PCT_MIN, LIMITS.JITTER_PCT_MAX],
    burstIntervalSec: [LIMITS.BURST_INTERVAL_MIN, LIMITS.BURST_INTERVAL_MAX],
    burstWindowSec: [LIMITS.BURST_WINDOW_MIN, LIMITS.BURST_WINDOW_MAX],
  };

  let locked = false;

  // ---- date helpers (datetime-local is always the user's local time zone) ----

  const pad = (n) => String(n).padStart(2, '0');
  function toLocalInput(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fromLocalInput(value) {
    if (!value) return null;
    const t = new Date(value).getTime(); // no offset in the string => parsed as local time
    return Number.isFinite(t) ? t : null;
  }
  function humanDuration(ms) {
    const s = Math.round(Math.abs(ms) / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
  }

  // ---- form <-> config ----

  function readForm() {
    const mode = form.querySelector('input[name="triggerMode"]:checked');
    const raw = {
      retailer: $('retailer').value,
      productUrl: $('productUrl').value,
      productName: $('productName').value,
      triggerMode: mode ? mode.value : null,
      dropTime: fromLocalInput($('dropTime').value),
      stopBeforePlaceOrder: $('stopBeforePlaceOrder').checked,
      maxTotalPrice: $('maxTotalPrice').value === '' ? null : $('maxTotalPrice').value,
    };
    for (const field of Object.keys(NUMERIC_FIELDS)) raw[field] = $(field).value;
    return raw;
  }

  function fillForm(config) {
    $('retailer').value = config.retailer;
    $('productUrl').value = config.productUrl;
    $('productName').value = config.productName;
    for (const radio of form.querySelectorAll('input[name="triggerMode"]')) {
      radio.checked = radio.value === config.triggerMode;
    }
    $('dropTime').value = toLocalInput(config.dropTime);
    for (const field of Object.keys(NUMERIC_FIELDS)) $(field).value = String(config[field]);
    $('stopBeforePlaceOrder').checked = config.stopBeforePlaceOrder;
    $('maxTotalPrice').value = config.maxTotalPrice ?? '';
    updateModeVisibility();
    updateDropHint();
  }

  // ---- UI state ----

  function updateModeVisibility() {
    const mode = form.querySelector('input[name="triggerMode"]:checked')?.value;
    $('scheduledFields').hidden = mode !== 'scheduled';
  }

  function updateDropHint() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const t = fromLocalInput($('dropTime').value);
    let text = `Your time zone: ${tz}.`;
    if (t) {
      const delta = t - Date.now();
      text += delta > 0 ? ` That's in ${humanDuration(delta)}.` : ' That time has already passed.';
    }
    $('dropTimeHint').textContent = text;
  }

  function clearMessages() {
    for (const el of form.querySelectorAll('.error')) el.remove();
    for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
    for (const id of ['formErrors', 'formWarnings', 'saved']) {
      $(id).hidden = true;
      $(id).textContent = '';
    }
  }

  function showBanner(id, lines) {
    const box = $(id);
    box.textContent = '';
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      box.append(p);
    }
    box.hidden = lines.length === 0;
  }

  function showErrors(errors) {
    const unplaced = [];
    for (const { field, message } of errors) {
      const input = form.elements.namedItem(field);
      const container = input instanceof Element ? input.closest('.field') : null;
      if (!container) {
        unplaced.push(message);
        continue;
      }
      input.setAttribute('aria-invalid', 'true');
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = message;
      container.append(div);
    }
    showBanner('formErrors', ['Please fix the highlighted fields.', ...unplaced]);
    form.querySelector('[aria-invalid="true"]')?.focus();
  }

  function setLocked(isLocked) {
    locked = isLocked;
    $('locked').hidden = !isLocked;
    for (const el of form.elements) el.disabled = isLocked;
  }

  // ---- save ----

  async function revokeOtherOrigins(keepPattern) {
    const { origins = [] } = await chrome.permissions.getAll();
    const stale = origins.filter((o) => o !== keepPattern);
    if (stale.length) await chrome.permissions.remove({ origins: stale });
  }

  async function persist(result, pattern) {
    const { [STORAGE_KEYS.RUN_STATE]: state } = await chrome.storage.local.get(STORAGE_KEYS.RUN_STATE);
    if (state && ACTIVE_STATUSES.includes(state.status)) {
      showBanner('formErrors', ['A run is active. Disarm it before changing settings.']);
      return;
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: result.config });
    await revokeOtherOrigins(pattern);
    const reg = await chrome.runtime.sendMessage({ type: MESSAGES.CONFIG_SAVED });

    const host = new URL(result.config.productUrl).hostname;
    const lines = [`Saved. Ro-Bought can now run on ${host} only.`];
    if (reg && reg.ok === false) lines.push(`Note: ${reg.error}`);
    else if (reg && !reg.registered && reg.reason) lines.push(`Note: ${reg.reason}`);
    showBanner('saved', lines);
    showBanner('formWarnings', result.warnings);
    fillForm(result.config);
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (locked) return;
    clearMessages();

    const result = RoBought.config.validate(readForm());
    if (!result.ok) {
      showErrors(result.errors);
      return;
    }
    const pattern = RoBought.url.originPattern(result.config.productUrl);

    // permissions.request must run synchronously inside the user gesture, so it is the
    // first async call in this handler.
    chrome.permissions
      .request({ origins: [pattern] })
      .then((granted) => {
        if (!granted) {
          showBanner('formErrors', [
            'Site access was not granted. Ro-Bought needs access to the retailer site to watch the product and run checkout.',
          ]);
          return undefined;
        }
        return persist(result, pattern);
      })
      .catch((e) => showBanner('formErrors', [`Could not save: ${e.message}`]));
  });

  form.addEventListener('change', (ev) => {
    if (ev.target.name === 'triggerMode') updateModeVisibility();
  });
  $('dropTime').addEventListener('input', updateDropHint);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.RUN_STATE]) return;
    const s = changes[STORAGE_KEYS.RUN_STATE].newValue;
    setLocked(!!s && ACTIVE_STATUSES.includes(s.status));
  });

  // ---- init ----

  async function init() {
    for (const [field, [min, max]] of Object.entries(NUMERIC_FIELDS)) {
      $(field).min = String(min);
      $(field).max = String(max);
    }
    $('limitsHint').textContent =
      `Polite limits: restock checks every ${LIMITS.RESTOCK_INTERVAL_MIN} s or slower, retries after a drop every ` +
      `${LIMITS.BURST_INTERVAL_MIN} s or slower, and automatic back-off when the retailer says "slow down" (HTTP 429/503).`;

    const stored = await chrome.storage.local.get([STORAGE_KEYS.CONFIG, STORAGE_KEYS.RUN_STATE]);
    const raw = stored[STORAGE_KEYS.CONFIG];
    // Show what was stored even if it no longer validates, so the user can fix it.
    fillForm(raw ? { ...RoBought.config.defaults(), ...RoBought.config.validate(raw).config, ...pickDisplayable(raw) } : RoBought.config.defaults());
    const state = stored[STORAGE_KEYS.RUN_STATE];
    setLocked(!!state && ACTIVE_STATUSES.includes(state.status));
  }

  function pickDisplayable(raw) {
    // Only string URL/name are echoed back verbatim; everything else comes from validate().
    const out = {};
    if (typeof raw.productUrl === 'string') out.productUrl = raw.productUrl;
    if (typeof raw.productName === 'string') out.productName = raw.productName;
    return out;
  }

  init().catch((e) => showBanner('formErrors', [`Could not load settings: ${e.message}`]));
})();
