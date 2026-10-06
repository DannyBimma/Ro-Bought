// Test-fixture helper (runs as a normal page script, NOT part of the extension).
// - Fills the page with navigation links so it looks like a real store page (not "sparse").
// - ?inject=<name> adds a blocker after a short delay, to exercise the live MutationObserver.
(() => {
  'use strict';

  const nav = document.getElementById('nav');
  if (nav) {
    for (let i = 1; i <= 40; i++) {
      const a = document.createElement('a');
      a.href = `/category-${i}.html`;
      a.textContent = `Category ${i}`;
      nav.append(a, ' ');
    }
  }

  const inject = new URLSearchParams(location.search).get('inject');
  const after = (ms, fn) => setTimeout(fn, ms);

  const injectors = {
    // PerimeterX "press & hold" appears on top of a live page.
    px() {
      after(600, () => {
        const box = document.createElement('div');
        box.id = 'px-captcha';
        box.style.cssText = 'width:300px;height:60px;background:#eee;border:1px solid #999';
        box.textContent = 'Press & Hold';
        document.body.append(box);
      });
    },
    // reCAPTCHA challenge frame that is hidden (normal on many stores) and later shown.
    recaptchaLater() {
      const wrap = document.createElement('div');
      wrap.id = 'rc-wrap';
      wrap.style.cssText = 'visibility:hidden;position:absolute;top:-10000px;left:0';
      const frame = document.createElement('iframe');
      frame.src = 'about:blank#/recaptcha/api2/bframe?k=test';
      frame.style.cssText = 'width:400px;height:580px;border:0';
      wrap.append(frame);
      document.body.append(wrap);
      after(1500, () => {
        wrap.style.cssText = 'visibility:visible;position:absolute;top:100px;left:0';
      });
    },
    // A hidden reCAPTCHA that never shows (must NOT pause).
    recaptchaHidden() {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'visibility:hidden;position:absolute;top:-10000px';
      const frame = document.createElement('iframe');
      frame.src = 'about:blank#/recaptcha/api2/bframe?k=test';
      frame.style.cssText = 'width:400px;height:580px;border:0';
      wrap.append(frame);
      document.body.append(wrap);
    },
  };

  if (inject && Object.hasOwn(injectors, inject)) injectors[inject]();
})();
