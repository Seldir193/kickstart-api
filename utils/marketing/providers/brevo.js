'use strict';
const SibApiV3Sdk = require('sib-api-v3-sdk');
const { BREVO_API_KEY, BREVO_LIST_ID } = process.env;

let api;
if (BREVO_API_KEY) {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = BREVO_API_KEY;
  api = new SibApiV3Sdk.ContactsApi();
}
function mustEnv() { if (!BREVO_API_KEY || !BREVO_LIST_ID) throw new Error('Missing Brevo env'); }

async function upsert({ email, firstName, lastName, tags = [] }) {
  mustEnv();
  const listId = parseInt(BREVO_LIST_ID, 10);
  try {
    await api.createContact({ email, attributes: { FIRSTNAME: firstName || '', LASTNAME: lastName || '' }, listIds: [listId], tags });
  } catch (e) {
    if (e?.response?.body?.code !== 'duplicate_parameter') throw e;
    await api.updateContact(email, { listIds: [listId], attributes: { FIRSTNAME: firstName || '', LASTNAME: lastName || '' } });
  }
  return { ok: true, provider: 'brevo', id: email, status: 'subscribed' };
}

async function unsubscribe({ email }) {
  mustEnv();
  const listId = parseInt(BREVO_LIST_ID, 10);
  await api.updateContact(email, { unlinkListIds: [listId] });
  return { ok: true, provider: 'brevo', id: email, status: 'unsubscribed' };
}

module.exports = { upsert, unsubscribe };
