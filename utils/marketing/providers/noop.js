

// utils/marketing/providers/noop.js
'use strict';
module.exports = {
  name: 'noop',
  async upsert() { return { ok: true, provider: 'none', action: 'upsert', skipped: true }; },
  async unsubscribe() { return { ok: true, provider: 'none', action: 'unsubscribe', skipped: true }; },
};
