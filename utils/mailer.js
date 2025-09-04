// utils/mailer.js
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

// WICHTIG: nur EINMAL importieren
const { renderMjmlFile } = require('./mjmlRenderer');

/* ================= Transport ================= */
let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMPP_SECURE || process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { minVersion: 'TLSv1.2' },
    });
  }
  return transporter;
}

/* ================= Helpers ================= */
const fileExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

const eur = (n, currency = 'EUR') =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency })
    .format(Number(n || 0));

const fullName  = (p) => [p?.salutation, p?.firstName, p?.lastName].filter(Boolean).join(' ');
const childName = (c) => [c?.firstName, c?.lastName].filter(Boolean).join(' ');

/**
 * Branding + Logo:
 * - HTTP/HTTPS -> direkt als URL,
 * - sonst lokaler Pfad als CID-Anhang (cid:brandLogo)
 */
function getBrandAndLogoCidAttachment() {
  const brand = {
    company: process.env.BRAND_COMPANY      || 'KickStart Academy',
    addr1:   process.env.BRAND_ADDR_LINE1   || 'Beispielstraße 1',
    addr2:   process.env.BRAND_ADDR_LINE2   || '47000 Duisburg',
    email:   process.env.BRAND_EMAIL        || 'info@kickstart-academy.de',
    website: process.env.BRAND_WEBSITE_URL  || 'https://www.selcuk-kocyigit.de',
  };

  const rawLogo = process.env.BRAND_LOGO_URL || process.env.BRAND_LOGO_PATH || process.env.PDF_LOGO || '';

  // URL?
  if (/^https?:\/\//i.test(rawLogo)) {
    return { brand, logoAttachment: null, logoUrl: rawLogo };
  }

  // Lokaler Pfad -> CID
  if (rawLogo) {
    const abs = path.isAbsolute(rawLogo) ? rawLogo : path.resolve(process.cwd(), rawLogo);
    if (fileExists(abs)) {
      const att = { filename: path.basename(abs), path: abs, cid: 'brandLogo' };
      return { brand, logoAttachment: att, logoUrl: 'cid:brandLogo' };
    }
  }

  return { brand, logoAttachment: null, logoUrl: '' };
}

/* ================= Generic sender ================= */
async function sendMail({ to, subject, text, html, attachments = [], cc, bcc }) {
  const effectiveBcc = (bcc ?? process.env.MAIL_BCC) ?? undefined;
  return getTransporter().sendMail({
    from: process.env.FROM_EMAIL || 'noreply@kickstart-academy.de',
    to, subject, text, html, attachments, cc, bcc: effectiveBcc,
  });
}

/* ================== BOOKINGS: MJML Mails ================== */

/** Eingangsbestätigung (nach Erstellung) */
async function sendBookingAckEmail({ to, offer, booking, pro }) {
  if (!to) return;
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const ctx = {
    brand: { ...brand, logoUrl },
    title: 'Eingangsbestätigung deiner Buchungsanfrage',
    greetingName: booking.firstName || 'Sportler',
    summary: {
      offer: offer?.title || `${offer?.type ?? ''} ${offer?.location ? '• ' + offer.location : ''}`.trim(),
      date: booking.date,
      level: booking.level,
      age: booking.age,
      message: booking.message || '',
    },
    price: {
      monthly: pro?.monthlyPrice != null ? Number(pro.monthlyPrice).toFixed(2) + ' €' : '',
      firstMonth: pro?.firstMonthPrice != null ? Number(pro.firstMonthPrice).toFixed(2) + ' €' : '',
      startDate: booking.date,
    },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
      name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
    },
  };

  const html = renderMjmlFile('templates/emails/booking-ack.mjml', ctx);
  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({ to, subject: 'Eingangsbestätigung – deine Buchungsanfrage', html, text: '', attachments });
}

/** Status: in Bearbeitung */
async function sendBookingProcessingEmail({ to, booking }) {
  if (!to) return;
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const ctx = {
    brand: { ...brand, logoUrl },
    title: 'Deine Buchung ist in Bearbeitung',
    greetingName: booking.firstName || 'Sportler',
    booking: {
      program: booking.program || booking.level || 'Buchung',
      date: booking.date || '',
      code: booking.confirmationCode || '',
    },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
      name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
    },
  };

  const html = renderMjmlFile('templates/emails/booking-processing.mjml', ctx);
  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({ to, subject: 'Status-Update – in Bearbeitung', html, text: '', attachments });
}











// --- Booking: Cancelled (MJML) ---
async function sendBookingCancelledEmail({ to, booking }) {
  if (!to || !booking) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: booking.firstName || 'Sportfreund',
    headline: 'Stornierung deiner Buchung',
    program: booking.program || booking.level || 'Programm',
    dateDE: booking.date
      ? new Date(booking.date).toLocaleDateString('de-DE')
      : '',
    confirmationCode: booking.confirmationCode || '',
    signature: {
      signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
      name: process.env.MAIL_SIGNER || 'Selcuk Kocyigit',
    },
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
      website: brand.website,
    },
  };

  // Template: templates/emails/booking-cancelled.mjml
  const html = renderMjmlFile('templates/emails/booking-cancelled.mjml', ctx);

  const text = [
    `Hallo ${ctx.greetingName},`,
    '',
    `leider müssen wir deine Buchung stornieren.`,
    `Programm: ${ctx.program}`,
    ctx.dateDE ? `Datum: ${ctx.dateDE}` : '',
    ctx.confirmationCode ? `Referenz: ${ctx.confirmationCode}` : '',
    '',
    'Bei Fragen kannst du einfach auf diese E-Mail antworten.',
    '',
    `${ctx.signature.signoff}`,
    ctx.signature.name,
  ].filter(Boolean).join('\n');

  await sendMail({
    to,
    subject: `Stornierung – ${ctx.program}${ctx.dateDE ? ` am ${ctx.dateDE}` : ''}${ctx.confirmationCode ? ` (${ctx.confirmationCode})` : ''}`,
    text,
    html,
    attachments: logoAttachment ? [logoAttachment] : [],
  });
}





/** Status: bestätigt (+ PDF Anhang) */
async function sendBookingConfirmedEmail({ to, booking, pdfBuffer }) {
  if (!to) return;
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const subject = `Buchung bestätigt – ${booking.level || 'Kurs'} am ${booking.date}`;
  const ctx = {
    brand: { ...brand, logoUrl },
    title: 'Deine Buchung wurde bestätigt',
    greetingName: booking.firstName || 'Sportler',
    booking: {
      program: booking.program || booking.level || 'Buchung',
      date: booking.date || '',
      code: booking.confirmationCode || '',
    },
    message: 'Im Anhang findest du die Bestätigung als PDF.',
    signature: {
      signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
      name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
    },
  };

  const html = renderMjmlFile('templates/emails/booking-confirmed.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    ...(pdfBuffer ? [{ filename: 'Buchungsbestaetigung.pdf', content: pdfBuffer }] : []),
  ];

  await sendMail({ to, subject, html, attachments, text: '' });
}

/* ============== Kunden-Mails (für /routes/customers.js) ============== */

async function sendParticipationEmail({
  to, customer, booking, pdfBuffer,
  invoiceNo, monthlyAmount, firstMonthAmount, venue, invoiceDate,
}) {
  if (!to) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
    name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
  };

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(customer?.parent) || 'Kunde',
    blocks: {
      locationTitle: 'Standort',
      contactTitle:  'Deine Kontaktdaten',
      bookingTitle:  'Deine Buchung',
      agentTitle:    'Dein Ansprechpartner',
      invoiceTitle:  'Die Rechnung',
      invoiceNote:   'Bitte bezahlen Sie die Rechnung innerhalb der nächsten 14 Tage.',
    },
    location: {
      club: booking?.venue || '',
      address: [booking?.venue, booking?.addressLine, venue].filter(Boolean).join(', '),
    },
    customer: {
      address: [
        customer?.address?.street && `${customer.address.street} ${customer.address.houseNo || ''}`.trim(),
        customer?.address?.zip    && `${customer.address.zip} ${customer.address.city || ''}`.trim(),
      ].filter(Boolean).join(' , '),
      childFull:  childName(customer?.child),
      parentFull: fullName(customer?.parent),
      email:      customer?.parent?.email || '',
    },
    booking: {
      offer:       booking?.offerTitle || booking?.offerType || 'Buchung',
      bookingDate: booking?.date ? new Date(booking.date).toLocaleDateString('de-DE') : '',
      venue:       venue || booking?.venue || '',
    },
    invoice: {
      invoiceNo:        invoiceNo || '',
      invoiceDate:      invoiceDate ? new Date(invoiceDate).toLocaleDateString('de-DE') : '',
      monthlyAmount:    monthlyAmount != null ? eur(monthlyAmount) : '',
      firstMonthAmount: firstMonthAmount != null ? eur(firstMonthAmount) : '',
    },
    signature,
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
      disclaimer:
        'This e-mail may contain confidential and/or privileged information. If you are not the intended recipient, please notify the sender and destroy this e-mail.',
    },
  };

  const html = renderMjmlFile('templates/emails/participation.mjml', ctx);
  const text = ''; // Plaintext nicht nötig, MJML/HTML reicht dir
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    ...(pdfBuffer ? [{ filename: 'Teilnahmebestaetigung.pdf', content: pdfBuffer }] : []),
  ];

  await sendMail({ to, subject: 'Teilnahmebestätigung', text, html, attachments });
}

async function sendCancellationEmail({ to, customer, booking, date, reason, pdfBuffer }) {
  if (!to) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
    name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
  };

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(customer?.parent) || 'Kunde',
    headline: 'Kündigungsbestätigung',
    infoLine: 'Hiermit bestätigen wir die Kündigung.',
    booking: {
      offer: booking?.offerTitle || booking?.offerType || '',
    },
    details: {
      cancelDate: new Date(date || booking?.cancelDate || Date.now()).toLocaleDateString('de-DE'),
      reason:     reason || booking?.cancelReason || '',
    },
    signature,
    legal: { line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}` },
  };

  const html = renderMjmlFile('templates/emails/cancellation.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    ...(pdfBuffer ? [{ filename: 'Kuendigungsbestaetigung.pdf', content: pdfBuffer }] : []),
  ];

  await sendMail({ to, subject: 'Kündigungsbestätigung', text: '', html, attachments });
}

async function sendStornoEmail({ to, customer, booking, pdfBuffer, amount = 0, currency = 'EUR' }) {
  if (!to) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
    name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
  };

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(customer?.parent) || 'Kunde',
    headline: 'Storno-Rechnung',
    note: 'Wir bestätigen die Stornierung. Die Storno-Rechnung findest du im Anhang.',
    invoice: {
      invoiceNo:   `STORNO-${String(booking?._id || '').slice(-6).toUpperCase()}`,
      invoiceDate: new Date(booking?.cancelDate || Date.now()).toLocaleDateString('de-DE'),
      offer:       booking?.offerTitle || booking?.offerType || '',
      items:       [{ desc: 'Gutschrift', qty: 1, amount: eur(amount, currency) }],
      total:       eur(amount, currency),
    },
    signature,
    legal: { line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}` },
  };

  const html = renderMjmlFile('templates/emails/invoice.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    ...(pdfBuffer ? [{ filename: 'Storno-Rechnung.pdf', content: pdfBuffer }] : []),
  ];

  await sendMail({ to, subject: 'Storno-Rechnung', text: '', html, attachments });
}

/* ===== Optional (Legacy) – einfache Bestätigung ohne MJML ===== */
async function sendBookingConfirmationEmail({ to, booking, pdfBuffer }) {
  if (!to) return;

  const when  = booking?.date ? String(booking.date).slice(0, 10) : '-';
  const title = booking?.program || booking?.level || 'Buchung';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111827">
      <p>Hallo,</p>
      <p>anbei deine Buchungsbestätigung.</p>
      <ul>
        <li><strong>Programm:</strong> ${title}</li>
        <li><strong>Datum:</strong> ${when}</li>
      </ul>
      <p>Mit sportlichen Grüßen<br/>Selcuk Kocyigit</p>
    </div>
  `;

  await sendMail({
    to,
    subject: 'Buchungsbestätigung',
    text: '',
    html,
    attachments: pdfBuffer ? [{ filename: 'Buchungsbestaetigung.pdf', content: pdfBuffer }] : [],
  });
}

/* ================= Utils ================= */
async function verifySmtp() {
  return getTransporter().verify();
}

/* ================= Exports ================= */
module.exports = {
  // generisch
  sendMail,
  verifySmtp,

  // Bookings (MJML)
  sendBookingAckEmail,
  sendBookingProcessingEmail,
  sendBookingCancelledEmail,
  sendBookingConfirmedEmail,

  // Kunden (für routes/customers.js)
  sendParticipationEmail,
  sendCancellationEmail,
  sendStornoEmail,

  // Legacy
  sendBookingConfirmationEmail,
};
















