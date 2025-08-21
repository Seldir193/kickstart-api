const express = require('express');
const { verifySmtp, sendMail } = require('../utils/mailer');

const router = express.Router();

router.get('/mail-verify', async (_req, res) => {
  try {
    await verifySmtp();
    res.json({ ok: true, msg: 'SMTP ok' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/mail-test', async (req, res) => {
  try {
    const to = (req.body && req.body.to) || process.env.SMTP_USER;
    await sendMail({
      to,
      subject: 'Testmail – KickStart API',
      text: 'Hallo! Dies ist eine Testmail vom Server.',
      html: '<p>Hallo! Dies ist eine <b>Testmail</b> vom Server.</p>',
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
