'use strict';
const sg = require('@sendgrid/client');
const { SENDGRID_API_KEY, SENDGRID_LIST_ID } = process.env;
if (SENDGRID_API_KEY) sg.setApiKey(SENDGRID_API_KEY);
function mustEnv() { if (!SENDGRID_API_KEY) throw new Error('Missing SendGrid env: SENDGRID_API_KEY'); }

async function upsert({ email, firstName, lastName }) {
  mustEnv();
  await sg.request({
    method: 'PUT',
    url: '/v3/marketing/contacts',
    body: {
      list_ids: SENDGRID_LIST_ID ? [SENDGRID_LIST_ID] : [],
      contacts: [{ email, first_name: firstName || '', last_name: lastName || '' }]
    }
  });
  return { ok: true, provider: 'sendgrid', id: email, status: 'subscribed' };
}

async function unsubscribe({ email }) {
  mustEnv();
  // optional: Suppressions/Listen-Entfernung implementieren
  return { ok: true, provider: 'sendgrid', id: email, status: 'unsubscribed' };
}

module.exports = { upsert, unsubscribe };
