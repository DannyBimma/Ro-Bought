// Loads the extension's classic shared scripts into this Node realm, exactly as the
// browser would (same global namespace, same order).
'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const SHARED = ['namespace.js', 'constants.js', 'url-utils.js', 'ticket-guard.js', 'config.js'];

if (!globalThis.RoBought) {
  for (const file of SHARED) {
    const path = join(__dirname, '..', 'extension', 'shared', file);
    vm.runInThisContext(readFileSync(path, 'utf8'), { filename: path });
  }
}

module.exports = globalThis.RoBought;
