// services/marketingSync.js
'use strict';

const { subscribeContact, unsubscribeContact } = require('../utils/marketing');

const DEFAULT_PROVIDER = String(process.env.MARKETING_PROVIDER || 'none').toLowerCase();

/**
 * Synchronisiert die Newsletter-Einstellung eines Customers mit dem Marketing-Provider.
 * - customer: Mongoose-Dokument (Customer)
 * - wantNewsletter: boolean
 * - opts: { provider?: string, email?: string, mutate?: boolean, tags?: string[] }
 *   - mutate=true ⇒ setzt newsletter/marketingStatus/marketingSyncedAt direkt am customer
 */
async function syncCustomerNewsletter(customer, wantNewsletter, opts = {}) {
  const provider = String(opts.provider || DEFAULT_PROVIDER).toLowerCase();

  const email =
    opts.email ||
    customer?.parent?.email ||
    customer?.parent?.emailAddress ||
    '';

  if (wantNewsletter && !email) {
    return { ok: false, error: 'Email required for subscription', code: 'NO_EMAIL' };
  }

  // Payload für Provider
  const payload = {
    email,
    firstName: customer?.parent?.firstName || customer?.child?.firstName || '',
    lastName:  customer?.parent?.lastName  || customer?.child?.lastName  || '',
    tags: opts.tags || [],
  };

  // Kein externer Sync, wenn Provider "none"
  if (provider === 'none') {
    if (opts.mutate) {
      customer.newsletter = !!wantNewsletter;
      customer.marketingStatus = wantNewsletter ? 'subscribed' : 'unsubscribed';
     // customer.marketingSyncedAt = new Date();

      customer.marketingLastSyncedAt = new Date();
     customer.marketingLastError = null;
    }
    return { ok: true, provider: 'none', skipped: true };
  }

  // Externer Provider
  if (wantNewsletter) {
    await subscribeContact(provider, payload);
  } else {
    await unsubscribeContact(provider, payload);
  }

  let up = null;
 if (wantNewsletter) {
   up = await subscribeContact(provider, payload);
 } else {
   up = await unsubscribeContact(provider, payload);
 }

  if (opts.mutate) {
    customer.newsletter = !!wantNewsletter;
    customer.marketingStatus = wantNewsletter ? 'subscribed' : 'unsubscribed';
    //customer.marketingSyncedAt = new Date();

    customer.marketingLastSyncedAt = new Date();
   customer.marketingLastError = null;
   if (['mailchimp','brevo','sendgrid'].includes(provider)) {
     customer.marketingProvider = provider;     // niemals 'none' schreiben (Enum!)
   }
   if (up && (up.contactId || up.id)) {
     customer.marketingContactId = up.contactId || up.id;
   }
  }

  //return { ok: true, provider };
  return { ok: true, provider, contactId: up?.contactId || up?.id };
}

module.exports = { syncCustomerNewsletter };







