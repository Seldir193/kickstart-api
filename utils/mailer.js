// utils/mailer.js
'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

// MJML-Renderer (unverändert in deinem Projekt)
const { renderMjmlFile } = require('./mjmlRenderer');

// PDF-Fassade (pdf.js → pdfHtml.js)
const {
  bookingPdfBuffer,        // (optional legacy)
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
} = require('./pdf');

// NEU: Daten-Aufbereitung exakt nach deiner DB
const {
  shapeStornoData,
  shapeCancellationData,
  shapeParticipationData,
} = require('./pdfData');

/* ================= Transport ================= */
let transporter;
function getTransporter() {
  if (!transporter) {
    const host   = process.env.SMTP_HOST;
    const port   = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

    transporter = nodemailer.createTransport({
      host,
      port,
      secure, // 465 = true, 587/25 = false
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

function getBrandAndLogoCidAttachment() {
  const brand = {
    company: process.env.BRAND_COMPANY      || 'KickStart Academy',
    addr1:   process.env.BRAND_ADDR_LINE1   || 'Beispielstraße 1',
    addr2:   process.env.BRAND_ADDR_LINE2   || '47000 Duisburg',
    email:   process.env.BRAND_EMAIL        || 'info@kickstart-academy.de',
    website: process.env.BRAND_WEBSITE_URL  || 'https://www.selcuk-kocyigit.de',
    iban:    process.env.BRAND_IBAN || '',
    bic:     process.env.BRAND_BIC  || '',
    taxId:   process.env.BRAND_TAXID|| '',
  };

  const rawLogo = process.env.BRAND_LOGO_URL || process.env.BRAND_LOGO_PATH || process.env.PDF_LOGO || '';

  // HTTP/HTTPS direkt
  if (/^https?:\/\//i.test(rawLogo)) {
    return { brand, logoAttachment: null, logoUrl: rawLogo };
  }

  // lokaler Pfad → CID
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
    to,
    subject,
    text: text ?? '',
    html,
    attachments,
    cc,
    bcc: effectiveBcc,
  });
}

/* ================= Buchungs-MJML (unverändert) ================= */

async function sendBookingAckEmail({ to, offer, booking, pro }) {
  if (!to) return;
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

    const dateDE = booking?.date
    ? new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date(booking.date))
    : '';

  const ctx = {
    brand: { ...brand, logoUrl },
    title: 'Eingangsbestätigung deiner Buchungsanfrage',
    greetingName: booking.firstName || 'Sportler',
    summary: {
      offer: offer?.title || `${offer?.type ?? ''} ${offer?.location ? '• ' + offer.location : ''}`.trim(),
      date: dateDE,
      //date: booking.date,
      level: booking.level,
      age: booking.age,
      message: booking.message || '',
    },
    price: {
      monthly: pro?.monthlyPrice != null ? eur(pro.monthlyPrice) : '',
      firstMonth: pro?.firstMonthPrice != null ? eur(pro.firstMonthPrice) : '',
      startDate: dateDE,
     // startDate: booking.date,
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

async function sendBookingCancelledEmail({ to, booking }) {
  if (!to || !booking) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: booking.firstName || 'Sportfreund',
    headline: 'Stornierung deiner Buchung',
    program: booking.program || booking.level || 'Programm',
    dateDE: booking.date ? new Date(booking.date).toLocaleDateString('de-DE') : '',
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






/** Teilnahmebestätigung */
async function sendParticipationEmail({ to, customer, booking, offer, pdfBuffer }) {
  if (!to) return;

  // --- Preis auflösen (booking.monthlyAmount > sonst offer.price)
  const currency = 'EUR';

  const monthlyRaw =
    (booking && typeof booking.monthlyAmount === 'number') ? booking.monthlyAmount
    : (offer && typeof offer.price === 'number') ? offer.price
    : undefined;

  const monthly = Number.isFinite(Number(monthlyRaw)) ? Number(monthlyRaw) : undefined;

  // Optional: pro-rata berechnen, falls Admin NICHTs geschickt hat
  function prorateForStart(dateISO, monthlyPrice) {
    const d = new Date((dateISO || '') + 'T00:00:00');
    if (!monthlyPrice || Number.isNaN(d.getTime())) return null;
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const startDay = d.getDate();
    const daysRemaining = daysInMonth - startDay + 1;
    const factor = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
    return Math.round(monthlyPrice * factor * 100) / 100;
  }

  const firstMonth =
    (booking && typeof booking.firstMonthAmount === 'number') ? booking.firstMonthAmount
    : (monthly && booking?.date) ? prorateForStart(booking.date, monthly)
    : undefined;

  // PDF (falls nicht schon gebaut)
  const ensureBuf = pdfBuffer || await buildParticipationPdf({
    customer,
    booking,
    offer, // wichtig, damit Titel/Ort stimmen
  });

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
      invoiceNote:   'Bitte begleiche die Rechnung innerhalb von 14 Tagen.',
    },
    location: {
      club: (booking?.venue || offer?.location || ''),
      address: [(booking?.venue || offer?.location || '')].filter(Boolean).join(', '),
    },
    customer: {
      address: [
        customer?.address?.street && `${customer.address.street} ${customer.address.houseNo || ''}`.trim(),
        customer?.address?.zip    && `${customer.address.zip} ${customer.address.city || ''}`.trim(),
      ].filter(Boolean).join(' , '),
      childFull:  `${customer?.child?.firstName || ''} ${customer?.child?.lastName || ''}`.trim(),
      parentFull: fullName(customer?.parent),
      email:      '', // E-Mail bewusst nicht ins PDF
    },
    booking: {
      offer:       booking?.offerTitle || booking?.offerType || offer?.title || 'Buchung',
      bookingDate: booking?.date || '',
      venue:       booking?.venue || offer?.location || '',
    },
    // >>> NEU: Preis-Block für MJML-Template (Strings formatiert)
    price: {
      monthly:   (monthly != null)   ? eur(monthly, currency)   : '',
      firstMonth:(firstMonth != null)? eur(firstMonth, currency): '',
      currency,
      startDate: booking?.date || '',
    },

    signature,
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
      disclaimer:
        'This e-mail may contain confidential and/or privileged information. If you are not the intended recipient, please notify the sender and destroy this e-mail.',
    },
  };

  const html = renderMjmlFile('templates/emails/participation.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: 'Teilnahmebestaetigung.pdf', content: ensureBuf },
  ];

  await sendMail({ to, subject: 'Teilnahmebestätigung', text: '', html, attachments });
}














/** Kündigungsbestätigung */
async function sendCancellationEmail({ to, customer, booking, offer, date, reason, pdfBuffer }) {
  if (!to) return;

  const shaped = shapeCancellationData({ customer, booking, offer, date, reason });

  const ensureBuf = pdfBuffer || await buildCancellationPdf({
    customer: shaped.customer,
    booking : shaped.booking,
    date    : shaped.details.cancelDate,
    reason  : shaped.details.reason,
  });

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
    name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
  };

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(shaped.customer.parent) || 'Kunde',
    headline: 'Kündigungsbestätigung',
    infoLine: 'Hiermit bestätigen wir die Kündigung.',
    booking: {
      offer: shaped.booking.offerTitle || shaped.booking.offerType || '',
    },
    details: {
      cancelDate: new Date(shaped.details.cancelDate || Date.now()).toLocaleDateString('de-DE'),
      reason:     shaped.details.reason || '',
    },
    signature,
    legal: { line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}` },
  };

  const html = renderMjmlFile('templates/emails/cancellation.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: 'Kuendigungsbestaetigung.pdf', content: ensureBuf },
  ];

  await sendMail({ to, subject: 'Kündigungsbestätigung', text: '', html, attachments });
}

// ---- Termin bestätigt – E-Mail mit optionalem PDF-Anhang ----
async function sendBookingConfirmedEmail({ to, booking, pdfBuffer }) {
  if (!to) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

   const dateDE = booking?.date
    ? new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date(booking.date))
    : '';

  const subject = `Termin bestätigt – ${booking.level || 'Kurs'} am ${booking.date || ''}`;
  const ctx = {
    brand: { ...brand, logoUrl },
    title: 'Terminbestätigung',
    greetingName: booking.firstName || 'Sportler',
    booking: {
      program: booking.program || booking.level || 'Buchung',
      date: dateDE,
     // date: booking.date || '',
      code: booking.confirmationCode || '',
    },
    message: 'Im Anhang findest du die Terminbestätigung als PDF.',
    signature: {
      signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
      name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
    },
  };

  const html = renderMjmlFile('templates/emails/booking-confirmed.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    ...(pdfBuffer ? [{ filename: 'Terminbestaetigung.pdf', content: pdfBuffer }] : []),
  ];

  await sendMail({ to, subject, html, attachments, text: '' });
}







/** Storno-Rechnung */
async function sendStornoEmail({ to, customer, booking, offer, pdfBuffer, amount, currency = 'EUR' }) {
  if (!to) return;

  // 1) Betrag robust bestimmen: amount (wenn numerisch) sonst offer.price
  const effectiveAmount = Number.isFinite(Number(amount))
    ? Number(amount)
    : (offer && typeof offer.price === 'number' ? offer.price : 0);

  // 2) Shaping + Snapshots
  const shaped = shapeStornoData({
    customer, booking, offer,
    amount: effectiveAmount,
    currency
  });

  if (offer) {
    shaped.booking.offerTitle = shaped.booking.offerTitle || offer.title || '';
    shaped.booking.offerType  = shaped.booking.offerType  || offer.type  || '';
    shaped.booking.venue      = shaped.booking.venue      || offer.location || '';
  }

  // --- Debug: sofort sehen, welcher Betrag final verwendet wird
  console.log('[STORNO mailer]', {
    amountIn: amount, offerPrice: offer?.price, effectiveAmount
  });

  // 3) PDF rendern (mit effektivem Betrag)
  const ensureBuf = pdfBuffer || await buildStornoPdf({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    amount  : effectiveAmount,
    currency: shaped.currency,
  });

  // 4) E-Mail bauen & senden
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
    name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
  };

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(shaped.customer.parent) || 'Kunde',
    headline: 'Storno-Rechnung',
    note: 'Wir bestätigen die Stornierung. Die Storno-Rechnung findest du im Anhang.',
    invoice: {
      invoiceNo:   `STORNO-${String(shaped.booking._id || '').slice(-6).toUpperCase()}`,
      invoiceDate: new Date(shaped.booking.cancelDate || Date.now()).toLocaleDateString('de-DE'),
      offer:       shaped.booking.offerTitle || shaped.booking.offerType || '',
      items:       [{ desc: 'Gutschrift', qty: 1, amount: eur(effectiveAmount, shaped.currency) }],
      total:       eur(effectiveAmount, shaped.currency),
    },
    signature,
    legal: { line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}` },
  };

  const html = renderMjmlFile('templates/emails/invoice.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: 'Storno-Rechnung.pdf', content: ensureBuf },
  ];

  await sendMail({ to, subject: 'Storno-Rechnung', text: '', html, attachments });
}












/* ===== Optional Legacy ===== */
async function sendBookingConfirmationEmail({ to, booking, pdfBuffer }) {
  if (!to) return;

  const when  = booking?.date ? String(booking.date).slice(0, 10) : '-';
  const title = booking?.level || booking?.program || 'Buchung';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111827">
      <p>Hallo,</p>
      <p>anbei deine Bestätigung.</p>
      <ul>
        <li><strong>Programm:</strong> ${title}</li>
        <li><strong>Datum:</strong> ${when}</li>
      </ul>
      <p>Mit sportlichen Grüßen<br/>Selcuk Kocyigit</p>
    </div>
  `;

  await sendMail({
    to,
    subject: 'Bestätigung',
    text: '',
    html,
    attachments: pdfBuffer ? [{ filename: 'Bestaetigung.pdf', content: pdfBuffer }] : [],
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

  // Kunden (PDF + Mail)
  sendParticipationEmail,
  sendCancellationEmail,
  sendStornoEmail,

  // Legacy
  sendBookingConfirmationEmail,
};











