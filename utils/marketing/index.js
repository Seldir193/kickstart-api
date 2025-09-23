// utils/marketing/index.js
'use strict';
const mailchimp = require('./providers/mailchimp');
const brevo     = require('./providers/brevo');
const sendgrid  = require('./providers/sendgrid');
const noop      = require('./providers/noop'); // <— hinzufügen

function getProvider(name) {
  switch ((name || '').toLowerCase()) {
    case 'mailchimp': return mailchimp;
    case 'brevo':     return brevo;
    case 'sendgrid':  return sendgrid;
    case 'none':
    case 'noop':
    case '':          return noop;   // <— fallback
    default: throw new Error(`Unknown marketing provider: ${name}`);
  }
}

async function subscribeContact(providerName, payload) {
  return getProvider(providerName).upsert(payload);
}
async function unsubscribeContact(providerName, payload) {
  const p = getProvider(providerName);
  if (!p.unsubscribe) return { ok: true, note: 'no explicit unsubscribe for provider' };
  return p.unsubscribe(payload);
}

module.exports = { subscribeContact, unsubscribeContact };
