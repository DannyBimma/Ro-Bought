(() => {
  'use strict';

  const { STORAGE_KEYS, LIMITS, ACTIVE_STATUSES, MESSAGES, TEACH_FIELDS } = RoBought.constants;
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
  let dirty = false; // the user has unsaved edits in the form
  // Taught buttons live in the stored config (written by teach mode via the service worker);
  // the form doesn't edit them, but saving must keep them — unless the store changed.
  let stored = { selectors: RoBought.config.emptySelectors(), productUrl: '' };

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
      productUrl: $('productUrl').value,
      productName: $('productName').value,
      triggerMode: mode ? mode.value : null,
      dropTime: fromLocalInput($('dropTime').value),
      stopBeforePlaceOrder: $('stopBeforePlaceOrder').checked,
      maxTotalPrice: $('maxTotalPrice').value === '' ? null : $('maxTotalPrice').value,
    };
    for (const field of Object.keys(NUMERIC_FIELDS)) raw[field] = $(field).value;
    raw.selectors = sameStore(raw.productUrl, stored.productUrl) ? stored.selectors : RoBought.config.emptySelectors();
    return raw;
  }

  function sameStore(a, b) {
    const ua = RoBought.url.parseProductUrl(a);
    const ub = RoBought.url.parseProductUrl(b);
    return !!ua && !!ub && RoBought.url.inScope(ua, ub);
  }

  const hasTaught = (sel) => Object.values(sel || {}).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));

  function fillForm(config) {
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
    updateAutoBuyWarning();
    updatePreset();
    dirty = false;
  }

  function updateAutoBuyWarning() {
    $('autoBuyWarning').hidden = $('stopBeforePlaceOrder').checked;
  }

  function updatePreset() {
    const url = RoBought.url.parseProductUrl($('productUrl').value);
    const preset = url ? RoBought.url.presetFor(url) : null;
    $('presetName').textContent = preset
      ? `${RoBought.url.PRESET_NAMES[preset]}${preset === 'generic' ? ' (Ro-Bought matches buttons by their text; teaching them is recommended)' : ' (built-in buttons; best-effort, so do a dry run)'}`
      : '—';
  }

  // ---- taught buttons ----

  function renderButtons() {
    const url = RoBought.url.parseProductUrl(stored.productUrl);
    const preset = url ? RoBought.url.presetFor(url) : 'generic';
    $('buttonsIntro').textContent = url
      ? `Store: ${RoBought.url.PRESET_NAMES[preset]}. Buttons you haven't taught use ${preset === 'generic' ? 'their button text' : 'the built-in preset, then button text'}.`
      : 'Save a product first.';
    const list = $('taughtList');
    const items = [];
    for (const f of TEACH_FIELDS) {
      const value = stored.selectors[f.id];
      const entries = f.multi ? value || [] : value ? [value] : [];
      if (!entries.length) {
        items.push(buttonRow(f, null, null));
      } else {
        entries.forEach((e, i) => items.push(buttonRow(f, e, f.multi ? i : null)));
      }
    }
    list.replaceChildren(...items);
    for (const b of list.querySelectorAll('button')) b.disabled = locked;
  }

  function buttonRow(field, entry, index) {
    const li = document.createElement('li');
    const what = document.createElement('div');
    what.className = 'what';
    const title = document.createElement('div');
    title.textContent = `${field.label} — ${field.where}`;
    what.append(title);
    const detail = document.createElement('code');
    detail.textContent = entry ? `${entry.label ? `“${entry.label}” ` : ''}${entry.selector}` : 'not taught (built-in / text match)';
    what.append(detail);
    li.append(what);
    if (entry) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Clear';
      clear.addEventListener('click', async () => {
        const res = await chrome.runtime.sendMessage({ type: MESSAGES.TEACH_CLEAR, field: field.id, ...(index !== null ? { index } : {}) });
        $('buttonsMsg').textContent = res?.ok ? `Cleared ${field.label}.` : res?.error || 'Could not clear that.';
      });
      li.append(clear);
    }
    return li;
  }

  function setStored(config) {
    stored = {
      productUrl: config?.productUrl || '',
      selectors: RoBought.config.cleanSelectors(config?.selectors),
    };
    renderButtons();
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
    renderButtons();
  }

  // ---- save ----

  async function revokeOtherOrigins(keepPatterns) {
    const { origins = [] } = await chrome.permissions.getAll();
    const stale = origins.filter((o) => !keepPatterns.includes(o));
    if (stale.length) await chrome.permissions.remove({ origins: stale });
  }

  async function persist(result, patterns) {
    const { [STORAGE_KEYS.RUN_STATE]: state } = await chrome.storage.local.get(STORAGE_KEYS.RUN_STATE);
    if (state && ACTIVE_STATUSES.includes(state.status)) {
      showBanner('formErrors', ['A run is active. Disarm it before changing settings.']);
      return;
    }
    const droppedButtons = hasTaught(stored.selectors) && !hasTaught(result.config.selectors);
    await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: result.config });
    await revokeOtherOrigins(patterns);
    const reg = await chrome.runtime.sendMessage({ type: MESSAGES.CONFIG_SAVED });

    const host = RoBought.url.baseHost(new URL(result.config.productUrl).hostname);
    const lines = [`Saved. Ro-Bought can now run on ${host} only.`];
    if (droppedButtons) lines.push('The taught buttons were cleared because the store changed.');
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
    // The retailer's site: bare host + www. variant (e.g. amazon.com and www.amazon.com).
    const patterns = RoBought.url.scopePatterns(result.config.productUrl);

    // permissions.request must run synchronously inside the user gesture, so it is the
    // first async call in this handler.
    chrome.permissions
      .request({ origins: patterns })
      .then((granted) => {
        if (!granted) {
          showBanner('formErrors', [
            'Site access was not granted. Ro-Bought needs access to the retailer site to watch the product and run checkout.',
          ]);
          return undefined;
        }
        return persist(result, patterns);
      })
      .catch((e) => showBanner('formErrors', [`Could not save: ${e.message}`]));
  });

  form.addEventListener('input', () => {
    dirty = true;
  });
  form.addEventListener('change', (ev) => {
    dirty = true;
    if (ev.target.name === 'triggerMode') updateModeVisibility();
    if (ev.target.id === 'stopBeforePlaceOrder') updateAutoBuyWarning();
  });
  $('dropTime').addEventListener('input', updateDropHint);
  $('productUrl').addEventListener('input', updatePreset);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.CONFIG]) {
      const next = changes[STORAGE_KEYS.CONFIG].newValue;
      setStored(next);
      // Settings changed elsewhere (another options tab, teach mode): show them, unless the
      // user is mid-edit here, so a stale form can't silently overwrite newer settings.
      if (next && !dirty) fillForm({ ...RoBought.config.defaults(), ...RoBought.config.validate(next).config, ...pickDisplayable(next) });
    }
    if (changes[STORAGE_KEYS.RUN_STATE]) {
      const s = changes[STORAGE_KEYS.RUN_STATE].newValue;
      setLocked(!!s && ACTIVE_STATUSES.includes(s.status));
    }
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
    setStored(raw);
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
