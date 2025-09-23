'use strict';
const crypto = require('crypto');
const mc = require('@mailchimp/mailchimp_marketing');

const { MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX, MAILCHIMP_LIST_ID } = process.env;
if (MAILCHIMP_API_KEY && MAILCHIMP_SERVER_PREFIX) {
  mc.setConfig({ apiKey: MAILCHIMP_API_KEY, server: MAILCHIMP_SERVER_PREFIX });
}
function mustEnv() {
  if (!MAILCHIMP_API_KEY || !MAILCHIMP_SERVER_PREFIX || !MAILCHIMP_LIST_ID) {
    throw new Error('Missing Mailchimp env: MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX, MAILCHIMP_LIST_ID');
  }
}
const md5 = (e) => crypto.createHash('md5').update(String(e||'').toLowerCase()).digest('hex');

async function upsert({ email, firstName, lastName, tags = [] }) {
  mustEnv();
  const resp = await mc.lists.setListMember(
    MAILCHIMP_LIST_ID,
    md5(email),
    {
      email_address: email,
      status_if_new: process.env.MC_DOUBLE_OPT_IN === '1' ? 'pending' : 'subscribed',
      merge_fields: { FNAME: firstName || '', LNAME: lastName || '' },
      tags
    }
  );
  return { ok: true, provider: 'mailchimp', id: resp?.id || null, status: resp?.status || 'subscribed' };
}

async function unsubscribe({ email }) {
  mustEnv();
  const resp = await mc.lists.setListMember(MAILCHIMP_LIST_ID, md5(email), { status: 'unsubscribed' });
  return { ok: true, provider: 'mailchimp', id: resp?.id || null, status: 'unsubscribed' };
}

module.exports = { upsert, unsubscribe };
