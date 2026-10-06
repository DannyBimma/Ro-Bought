// Creates the single global namespace shared by every Ro-Bought classic script.
// Loaded first everywhere: service worker (importScripts), extension pages (<script>),
// and content scripts (isolated world — never visible to the retailer's page scripts).
(() => {
  'use strict';
  if (!Object.prototype.hasOwnProperty.call(globalThis, 'RoBought')) {
    Object.defineProperty(globalThis, 'RoBought', {
      value: Object.create(null),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
})();
