// Plays Ro-Bought's alert sounds. The tones are synthesised as WAV in memory, so there is no
// audio file to ship. Only the extension's own service worker can trigger them.
(() => {
  'use strict';

  const { MESSAGES, SOUND_KINDS } = RoBought.constants;
  const RATE = 22_050;
  const VOLUME = 0.35;

  // [frequency Hz, duration ms]; 0 Hz = silence.
  const PATTERNS = {
    attention: [[880, 140], [0, 60], [880, 140], [0, 60], [1175, 240]], // "your turn"
    success: [[660, 160], [0, 40], [990, 320]],                         // "order placed"
  };

  /** PCM samples for a pattern, with short fades so tones don't click. */
  function samples(pattern) {
    const total = pattern.reduce((n, [, ms]) => n + Math.round((RATE * ms) / 1000), 0);
    const out = new Int16Array(total);
    let i = 0;
    for (const [freq, ms] of pattern) {
      const n = Math.round((RATE * ms) / 1000);
      const fade = Math.min(Math.round(RATE * 0.01), n / 2);
      for (let k = 0; k < n; k++, i++) {
        if (!freq) continue;
        const env = Math.min(1, k / fade, (n - k) / fade);
        out[i] = Math.round(Math.sin((2 * Math.PI * freq * k) / RATE) * env * VOLUME * 32767);
      }
    }
    return out;
  }

  function wav(pcm) {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (off, s) => [...s].forEach((c, j) => v.setUint8(off + j, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);       // PCM chunk size
    v.setUint16(20, 1, true);        // PCM
    v.setUint16(22, 1, true);        // mono
    v.setUint32(24, RATE, true);
    v.setUint32(28, RATE * 2, true); // byte rate
    v.setUint16(32, 2, true);        // block align
    v.setUint16(34, 16, true);       // bits per sample
    str(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }

  const cache = new Map(); // kind -> object URL (a few KB each; lives as long as this page)

  async function play(kind) {
    const k = SOUND_KINDS.includes(kind) ? kind : 'attention';
    if (!cache.has(k)) cache.set(k, URL.createObjectURL(new Blob([wav(samples(PATTERNS[k]))], { type: 'audio/wav' })));
    const audio = new Audio(cache.get(k));
    try {
      await audio.play();
      return { ok: true, kind: k };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== MESSAGES.PLAY_SOUND || msg.target !== 'offscreen') return false;
    if (sender.id !== chrome.runtime.id || sender.tab) return false; // only the service worker
    play(msg.kind).then(sendResponse);
    return true;
  });
})();
