// utils/mailer.js
const nodemailer = require('nodemailer');

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true', // 465=true, 587=false
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { minVersion: 'TLSv1.2' },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html, attachments = [], cc, bcc }) {
  // <- HIER: kein Mischen von ?? und ||
  const effectiveBcc = (bcc ?? process.env.MAIL_BCC) ?? undefined;

  return getTransporter().sendMail({
    from: process.env.FROM_EMAIL,
    to,
    subject,
    text,
    html,
    attachments,
    cc,
    bcc: effectiveBcc,
  });
}

async function verifySmtp() {
  return getTransporter().verify();
}

module.exports = { sendMail, verifySmtp };
