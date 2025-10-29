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
    company: process.env.BRAND_COMPANY     || 'Münchner Fussball Schule NRW',
    addr1:   process.env.BRAND_ADDR_LINE1  || 'Hochfelder Str. 33',
    addr2:   process.env.BRAND_ADDR_LINE2  || '47226 Duisburg',
    email:   process.env.BRAND_EMAIL       || 'info@muenchner-fussball-schule.ruhr',
    website: process.env.BRAND_WEBSITE_URL || 'https://www.muenchner-fussball-schule.ruhr',
    iban:    process.env.BRAND_IBAN        || 'DE13350400380595090200',
    bic:     process.env.BRAND_BIC         || 'COBADEFFXXX',
    taxId:   process.env.BRAND_TAXID       || '',
  };

  const rawLogo =
    process.env.BRAND_LOGO_URL ||
    process.env.BRAND_LOGO_PATH ||
    process.env.PDF_LOGO ||
    '';

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






async function sendMail({ to, subject, text, html, attachments = [], cc, bcc }) {
  const effectiveBcc = (bcc ?? process.env.MAIL_BCC) ?? undefined;

  return getTransporter().sendMail({
    from: process.env.FROM_EMAIL || 'info@muenchner-fussball-schule.ruhr',
    to,
    subject,
    text: text ?? '',
    html,
    attachments,
    cc,
    bcc: effectiveBcc,
  });
}









// === Helfer: Kursname ohne Adresse/Ortsteile ===
function courseOnly(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];     // an •, —, – oder | trennen
  const commaDigit = s.search(/,\s*\d/);    // hinter ", 123…" abschneiden
  if (commaDigit > 0) s = s.slice(0, commaDigit);
  const dashAddr = s.search(/\s-\s*\d/);    // hinter " - 123…" abschneiden
  if (dashAddr > 0) s = s.slice(0, dashAddr);
  return s.trim();
}


function parseInquiryMessage(msg) {
  const t = String(msg || '');
  const pick = (label) => {
    const m = t.match(new RegExp(`${label}\\s*:\\s*([^\\n]+)`, 'i'));
    return m ? m[1].trim() : '';
  };

  // Rohinhalt hinter "Kind:" holen
  let childRaw = pick('Kind');

  // Alles abschneiden, wenn danach weitere Felder kommen (", Geburtstag:", ", Kontakt:", …)
  childRaw = childRaw.replace(
    /\s*,\s*(Geburts(tag|datum)|Kontakt|Adresse|Telefon|Gutschein|Quelle)\s*:.*/i,
    ''
  ).trim();

  // Optional: Geschlecht in Klammern extrahieren, aber aus dem Namen entfernen
  const genderMatch = childRaw.match(/\(([^)]+)\)/);
  const gender = genderMatch ? genderMatch[1].trim() : '';
  const child  = childRaw.replace(/\s*\([^)]*\)\s*$/, '').trim();

  return {
    child,                   // ← nur der Name
    gender,                  // z.B. "weiblich" (falls gewünscht)
    birthdate: pick('Geburtstag') || pick('Geburtsdatum'),
    contact  : pick('Kontakt'),
    address  : pick('Adresse'),
    phone    : pick('Telefon'),
    voucher  : pick('Gutschein'),
    source   : pick('Quelle'),
  };
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



    // … innerhalb sendBookingAckEmail …

const rawOffer =
  offer?.title ||
  `${(offer?.sub_type || offer?.type || '')}${offer?.location ? ' • ' + offer.location : ''}`;

const summaryMessage = booking?.message || '';          // was bisher unter "Nachricht" stand
const form = parseInquiryMessage(summaryMessage);       // strukturierte Felder herausziehen

const ctx = {
  brand: { ...brand, logoUrl },
  title: 'Eingangsbestätigung deiner Buchungsanfrage',
  greetingName: booking.firstName || 'Sportler',
  summary: {
    // NUR Kursname – ohne Adresse/Ort
    offer: courseOnly(rawOffer),
    date: dateDE,
    level: booking.level,
    age: booking.age,
    // message NICHT mehr verwenden (wir zeigen unten die aufbereiteten Felder)
  },
  // neue, strukturierte Formular-Felder für das MJML
  form,
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
    headline: 'Absage Kurs findet nicht statt',
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
    subject: `Absage – ${ctx.program}${ctx.dateDE ? ` am ${ctx.dateDE}` : ''}${ctx.confirmationCode ? ` (${ctx.confirmationCode})` : ''}`,
    text,
    html,
    attachments: logoAttachment ? [logoAttachment] : [],
  });
}
















/** Teilnahmebestätigung */
async function sendParticipationEmail({ to, customer, booking, offer, pdfBuffer }) {
  if (!to) return;

  /* ---------- Helpers ---------- */
  const eur = (n) =>
    (typeof n === 'number' && Number.isFinite(n))
      ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n)
      : '';

  const fmtDE = (d) =>
    d ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin' }).format(d) : '';

  function parseISOorDate(v) {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const s = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Prorata: inkl. Starttag
  function prorateForStart(startDateObj, monthlyPrice) {
    if (!(startDateObj instanceof Date)) return null;
    if (typeof monthlyPrice !== 'number' || !Number.isFinite(monthlyPrice)) return null;
    const y = startDateObj.getFullYear();
    const m = startDateObj.getMonth();
    const daysInMonth   = new Date(y, m + 1, 0).getDate();
    const startDay      = startDateObj.getDate();
    const daysRemaining = Math.max(0, daysInMonth - startDay + 1);
    const factor        = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
    return Math.round(monthlyPrice * factor * 100) / 100;
  }

  /* ---------- Preise (Booking-Overrides > Offer) ---------- */


const isWeekly =
   offer?.category === 'Weekly' ||
   offer?.type === 'Foerdertraining' ||
   offer?.type === 'Kindergarten';

 const monthlyRaw = isWeekly
   ? ((typeof booking?.monthlyAmount === 'number') ? booking.monthlyAmount
      : (typeof booking?.priceMonthly  === 'number') ? booking.priceMonthly
      : (typeof offer?.price           === 'number') ? offer.price
      : undefined)
   : undefined;
  const monthly = (typeof monthlyRaw === 'number' && Number.isFinite(monthlyRaw)) ? monthlyRaw : undefined;

  const startDateObj = parseISOorDate(booking?.date);
  const startDE      = fmtDE(startDateObj);

  

  const firstMonth = isWeekly
   ? ((typeof booking?.firstMonthAmount === 'number') ? booking.firstMonthAmount
      : prorateForStart(startDateObj, monthly))
   : undefined;

  /* ---------- Rechnung-Metadaten (nur Nummer/Datum) ---------- */
  const invoiceNo     = booking?.invoiceNumber || booking?.invoiceNo || '';
  const invoiceDate   = booking?.invoiceDate || '';
  const invoiceDateDE = invoiceDate ? fmtDE(new Date(invoiceDate)) : '';

  /* ---------- Marken/Signatur ---------- */
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();
  const signature = {
    signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
    name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
  };

  /* ---------- Anzeige-Felder ---------- */
  const parentSal = customer?.parent?.salutation || '';
  const parentFn  = customer?.parent?.firstName  || booking?.firstName || '';
  const parentLn  = customer?.parent?.lastName   || booking?.lastName  || '';
  // "Herr/Frau Nachname Vorname"
  const parentFullDisplay = [parentSal, [parentLn, parentFn].filter(Boolean).join(' ')].filter(Boolean).join(' ');

  const childFn  = customer?.child?.firstName || '';
  const childLn  = customer?.child?.lastName  || '';
  const childFull = [childFn, childLn].filter(Boolean).join(' ');

  const street = customer?.address?.street  || '';
  const house  = customer?.address?.houseNo || '';
  const zip    = customer?.address?.zip     || '';
  const city   = customer?.address?.city    || '';
 // const addressLine = [
    //[street, house].filter(Boolean).join(' ').trim(),
   // [zip, city].filter(Boolean).join(' ').trim(),
//  ].filter(Boolean).join(', ');

  const addressLine1 = [street, house].filter(Boolean).join(' ').trim();
const addressLine2 = [zip, city].filter(Boolean).join(' ').trim();
const addressLine  = [addressLine1, addressLine2].filter(Boolean).join(', ')

  const parentEmail = customer?.parent?.email || booking?.email || '';
  const parentPhone = customer?.parent?.phone || booking?.phone || '';

  //const course = booking?.offerTitle || booking?.offerType || offer?.title || 'Buchung';
//  const course = booking?.offerTitle || booking?.offerType || offer?.sub_type || offer?.title || 'Buchung';
  const course = booking?.offerTitle || booking?.offerType || offer?.title || offer?.sub_type || offer?.type || 'Buchung';
  const venue  = booking?.venue || offer?.location || '';

  /* ---------- Tag + Uhrzeit robust zusammensetzen ---------- */
  const weekdayDE = (() => {
    if (!booking?.date) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(booking.date) ? new Date(`${booking.date}T00:00:00`) : new Date(booking.date);
    return d && !Number.isNaN(d.getTime())
      ? new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(d) // "Dienstag"
      : '';
  })();

  // 1) Formular-Felder (WP)
  const formTag  = booking?.tag  || booking?.Tag || booking?.weekday || booking?.wpTag || '';
  const formTime = booking?.zeit || booking?.time || booking?.uhrzeit || booking?.preferredTime || '';

  // 2) Zeiten aus Offer extrahieren – robust
  function findTimeRangeFromOffer(off, weekdayName) {
    if (!off) return '';

    const joinRange = (from, to) => {
      const f = from ? String(from).trim() : '';
      const t = to   ? String(to).trim()   : '';
      return [f, t].filter(Boolean).join(' – ');
    };

    if (Array.isArray(off.days) && off.days.length) {
      const norm = (v) => String(v || '').toLowerCase();
      const weekdayNorm = norm(weekdayName);

      // passendes Objekt nach Wochentag, sonst erstes
      let cand = off.days.find(d =>
        norm(d?.day) === weekdayNorm ||
        norm(d?.weekday) === weekdayNorm ||
        norm(d?.tag) === weekdayNorm
      ) || off.days[0];

      if (cand && typeof cand === 'object') {
        const from =
          cand.timeFrom ?? cand.from ?? cand.start ??
          (cand.time && (cand.time.from ?? cand.timeStart));
        const to =
          cand.timeTo   ?? cand.to   ?? cand.end   ??
          (cand.time && (cand.time.to ?? cand.timeEnd));

        if (from || to) return joinRange(from, to);

        // kombinierte Felder wie "time" / "zeit" / "uhrzeit"
        const t = cand.time ?? cand.zeit ?? cand.uhrzeit;
        if (t) return String(t).replace(/\s*-\s*/g, ' – ').trim();
      }
    }

    // root-Fallback
    const from = off.timeFrom ?? off.from ?? off.start;
    const to   = off.timeTo   ?? off.to   ?? off.end;
    if (from || to) return joinRange(from, to);

    const t = off.time ?? off.zeit ?? off.uhrzeit;
    return t ? String(t).replace(/\s*-\s*/g, ' – ').trim() : '';
  }

  const offerTime   = findTimeRangeFromOffer(offer, weekdayDE);
  const tagDisplay  = formTag || weekdayDE || '';
  const timeDisplay = formTime || offerTime || '';
  const dayTimeLine = tagDisplay
    ? (timeDisplay ? `${tagDisplay}: ${timeDisplay}` : tagDisplay)
    : (timeDisplay || '');

  /* ---------- Template-Context ---------- */
  const ctx = {
    brand: { ...brand, logoUrl },

    greetingName: [parentSal, parentFn, parentLn].filter(Boolean).join(' ') || 'Kunde',

    blocks: {
      locationTitle: 'Standort',
      contactTitle:  'Deine Kontaktdaten',
      bookingTitle:  'Deine Buchung',
      agentTitle:    'Dein Ansprechpartner',
      invoiceTitle:  'Die Rechnung',
      invoiceNote:   'Die Rechnung findest du als PDF im Anhang.',
    },

    location: {
      club:    venue,
      address: venue,
    },

    customer: {
      parentFull: parentFullDisplay,
      childFull:  childFull,        // wird aktuell im MJML nicht mehr separat gezeigt – schadet aber nicht
      email:      parentEmail,
      phone:      parentPhone,
      address:    addressLine,

      addressLine1,
    addressLine2,
  
    },

    booking: {
      childFull:     childFull,      // für "… für Max Mustermann"
      offer:         course,
      bookingDate:   booking?.date || '',
      bookingDateDE: startDE || '',
      venue:         venue,
      dayTime:       dayTimeLine,    // "Dienstag: 16:30 – 17:30" (oder nur "Dienstag")
      timeDisplay:   timeDisplay,    // nur "16:30 – 17:30"

      dayTimes:       tagDisplay,           // z.B. "Dienstag"

       
    },

    // Preisübersicht (falls im MJML genutzt) + für PDF
    price: {
      monthly:    (monthly    != null) ? eur(monthly)    : '',
      firstMonth: (firstMonth != null) ? eur(firstMonth) : '',
      currency: 'EUR',
      startDate:  booking?.date || '',
    },

    // Rechnungsteil: KEINE Beträge in der Mail
    invoice: {
      number: invoiceNo || '',
      date:   invoiceDateDE || invoiceDate || '',
    },

    signature,
    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
    },
  };

  /* ---------- PDF (identisch zu Mail-Werten) ---------- */
  const ensureBuf = pdfBuffer || await buildParticipationPdf({
    customer,
    booking,
    offer,
    invoiceNo,
    invoiceDate,
    monthlyAmount:    monthly,
    firstMonthAmount: firstMonth,
    venue,
  });

  /* ---------- Render & Send ---------- */
  const html = renderMjmlFile('templates/emails/participation.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: 'Teilnahmebestaetigung.pdf', content: ensureBuf },
  ];

  console.log('[participation-email]', {
    dayTime: dayTimeLine,
    tagDisplay, timeDisplay, weekdayDE,
    monthly, firstMonth, invoiceNo,
  });

  await sendMail({ to, subject: 'Teilnahmebestätigung', text: '', html, attachments });
}






















// ---- Termin bestätigt – E-Mail mit optionalem PDF-Anhang ----
async function sendBookingConfirmedEmail({ to, booking, offer, pdfBuffer }) {
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

  // Wochentag aus dem Buchungsdatum (Fallback für Kurstag)
  const weekdayDE = (() => {
    const s = booking?.date ? String(booking.date) : '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : (s ? new Date(s) : null);
    return d && !Number.isNaN(d.getTime())
      ? new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(d)
      : '';
  })();

  // Zeit aus Offer extrahieren (falls im Booking keine Uhrzeit steht)
  function findTimeRangeFromOffer(off, weekdayName) {
    if (!off) return '';

    const joinRange = (from, to) => {
      const f = from ? String(from).trim() : '';
      const t = to   ? String(to).trim()   : '';
      return [f, t].filter(Boolean).join(' – ');
    };

    if (Array.isArray(off.days) && off.days.length) {
      const norm = (v) => String(v || '').toLowerCase();
      const weekdayNorm = norm(weekdayName);

      // passendes Objekt nach Wochentag, sonst erstes Element
      let cand = off.days.find(d =>
        norm(d?.day) === weekdayNorm ||
        norm(d?.weekday) === weekdayNorm ||
        norm(d?.tag) === weekdayNorm
      ) || off.days[0];

      if (cand && typeof cand === 'object') {
        const from =
          cand.timeFrom ?? cand.from ?? cand.start ??
          (cand.time && (cand.time.from ?? cand.timeStart));
        const to =
          cand.timeTo   ?? cand.to   ?? cand.end   ??
          (cand.time && (cand.time.to ?? cand.timeEnd));

        if (from || to) return joinRange(from, to);

        const t = cand.time ?? cand.zeit ?? cand.uhrzeit;
        if (t) return String(t).replace(/\s*-\s*/g, ' – ').trim();
      }
    }

    // root-Felder
    const from = off.timeFrom ?? off.from ?? off.start;
    const to   = off.timeTo   ?? off.to   ?? off.end;
    if (from || to) return joinRange(from, to);

    const t = off.time ?? off.zeit ?? off.uhrzeit;
    return t ? String(t).replace(/\s*-\s*/g, ' – ').trim() : '';
  }

  // ⚙️ Child + Tag + Zeit (mit robusten Fallbacks)
  const childFull =
    booking.childName ||
    [booking.childFirstName, booking.childLastName].filter(Boolean).join(' ') ||
    [booking.firstName, booking.lastName].filter(Boolean).join(' ') ||   // ← dein Booking hat diese Felder
    booking.child ||
    '';

  const dayTimes =
    booking.dayTimes ||
    booking.kurstag ||
    booking.weekday ||
    weekdayDE ||
    '';

  const timeDisplay =
    booking.timeDisplay ||
    booking.kurszeit ||
    booking.time ||
    booking.uhrzeit ||
    findTimeRangeFromOffer(offer, weekdayDE) ||
    '';

  const subject = `Termin bestätigt – ${booking.level || 'Kurs'} am ${booking.date || ''}`;

  const ctx = {
    brand: { ...brand, logoUrl },
    title: 'Terminbestätigung',
    greetingName: booking.firstName || 'Sportler',
    booking: {
      program: booking.program || booking.level || 'Buchung',
      date: dateDE,
      code: booking.confirmationCode || '',
      childFull,
      dayTimes,
      timeDisplay,
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
























// --- Password reset email (forgot) ---
async function sendPasswordResetMail(to, resetLink) {
  if (!to || !resetLink) return;

  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  // Try MJML template first; fallback to simple HTML if template missing
  let html;
  try {
    html = renderMjmlFile('templates/emails/password-reset.mjml', {
      brand: { ...brand, logoUrl },
      title: 'Passwort zurücksetzen',
      intro: 'Wir haben eine Anfrage erhalten, dein Passwort zurückzusetzen.',
      ctaText: 'Neues Passwort festlegen',
      resetLink,
      note: 'Dieser Link ist 1 Stunde gültig. Wenn du die Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.',
      signature: {
        signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
        name: process.env.MAIL_SIGNER || 'Selcuk Kocyigit',
      },
    });
  } catch {
    // Minimal fallback HTML without MJML
    html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#111827">
        <p>Hallo,</p>
        <p>wir haben eine Anfrage erhalten, dein Passwort zurückzusetzen.</p>
        <p><a href="${resetLink}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Neues Passwort festlegen</a></p>
        <p>Oder öffne den folgenden Link:<br><a href="${resetLink}">${resetLink}</a></p>
        <p>Dieser Link ist 1 Stunde gültig. Wenn du die Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.</p>
        <p>${process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen'}<br/>${process.env.MAIL_SIGNER || 'Selcuk Kocyigit'}</p>
      </div>
    `;
  }

  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject: (process.env.APP_NAME || 'KickStart Academy') + ' • Passwort zurücksetzen',
    html,
    text: '', // optional: plain text, wenn du möchtest
    attachments,
  });
}








/** Storno-Rechnung */
async function sendStornoEmail({ to, customer, booking, offer, pdfBuffer, amount, currency = 'EUR' }) {
  if (!to) return;

  // 1) Betrag robust bestimmen
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
   // shaped.booking.offerType  = shaped.booking.offerType  || offer.type  || '';
    shaped.booking.offerType  = shaped.booking.offerType  || offer.sub_type || offer.type  || '';
    shaped.booking.venue      = shaped.booking.venue      || offer.location || '';
  }



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



















// utils/mailer.js – sendStornoEmail(...)
const stornoNo =
  booking?.stornoNo ||
  shaped.booking?.stornoNo ||
  `STORNO-${String(shaped.booking._id || '').slice(-6).toUpperCase()}`;

// Referenzrechnung (falls vorhanden)
const refInvoiceNo =
  shaped.booking.refInvoiceNo ||
  shaped.booking.originalInvoiceNo ||
  shaped.booking.invoiceNo ||
  shaped.booking.invoiceNumber || '';

const refInvoiceDate =
  shaped.booking.refInvoiceDate ||
  shaped.booking.originalInvoiceDate ||
  shaped.booking.invoiceDate || '';

const refInvoiceDateDE = refInvoiceDate
  ? new Intl.DateTimeFormat('de-DE').format(new Date(refInvoiceDate))
  : '';

const ctx = {
  brand: { ...brand, logoUrl },
  greetingName: fullName(shaped.customer.parent) || 'Kunde',
  headline: 'Storno-Rechnung',
  note: 'Wir bestätigen die Stornierung. Die Storno-Rechnung findest du im Anhang.',
  invoice: {
    invoiceNo: stornoNo, // ← hier die *gleiche* Nummer wie im PDF verwenden
    invoiceDate: new Date(shaped.booking.cancelDate || Date.now()).toLocaleDateString('de-DE'),
    offer: shaped.booking.offerTitle || shaped.booking.offerType || '',
    items: [{ desc: 'Storno', qty: 1, amount: eur(effectiveAmount, shaped.currency) }],
    total: eur(effectiveAmount, shaped.currency),
    refInvoiceNo,
    refInvoiceDate: refInvoiceDateDE || refInvoiceDate,
  },
  signature,
  legal: { line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}` },
};






 const html = renderMjmlFile('templates/emails/invoice.mjml', ctx);
  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: 'Storno-Rechnung.pdf', content: ensureBuf },
  ];

  await sendMail({ to, subject: 'Stornorechnung', text: '', html, attachments });

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










// === Kündigungsbestätigung per E-Mail ===
async function sendCancellationEmail({ to, customer, booking, offer, pdfBuffer }) {
  if (!to) return;

  // --- Referenzrechnung (Nr./Datum) robust bestimmen ---
  const refInvoiceNo   = booking?.refInvoiceNo   || booking?.invoiceNumber || booking?.invoiceNo || '';
  const refInvoiceDate = booking?.refInvoiceDate || booking?.invoiceDate   || '';

  // --- Kündigungsdaten aus der Buchung ---
  const cancelDate     = booking?.cancelDate || new Date();
  const cancelReason   = booking?.cancelReason || '';
  const cancellationNo = booking?.cancellationNo || booking?.cancellationNumber || '';

  const endDateRaw = booking?.endDate || null;
const endDateDE  = endDateRaw ? new Intl.DateTimeFormat('de-DE').format(new Date(endDateRaw)) : '';

  // --- PDF bauen (falls nicht mitgegeben) ---
  const ensureBuf = pdfBuffer || await buildCancellationPdf({
    customer,
    booking,
    offer,
    date:            cancelDate,
    endDate:        booking?.endDate || null,
    reason:          cancelReason,
    cancellationNo:  cancellationNo || undefined,
    refInvoiceNo:    refInvoiceNo   || undefined,
    refInvoiceDate:  refInvoiceDate || undefined,

    date:   cancelDate ? new Intl.DateTimeFormat('de-DE').format(new Date(cancelDate)) : '',
  endDate: endDateDE || '',
  });

  // --- Brand & Logo für Inline/Anhang ---
  const { brand, logoAttachment, logoUrl } = getBrandAndLogoCidAttachment();

  // --- E-Mail-Kontext für templates/emails/cancellation.mjml ---
  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: fullName(customer?.parent) || 'Kunde',

    blocks: {
      locationTitle: 'Standort',
      bookingTitle:  'Deine Buchung',
      invoiceTitle:  'Referenzrechnung',
      invoiceNote:   '',
    },

    location: {
      club:    booking?.venue || offer?.location || '',
      address: [booking?.venue || offer?.location || ''].filter(Boolean).join(', '),
    },

    customer: {
      childFull:  `${customer?.child?.firstName || ''} ${customer?.child?.lastName || ''}`.trim(),
      parentFull: fullName(customer?.parent),
    },

    booking: {
      offer:       booking?.offerTitle || booking?.offerType || offer?.title || 'Buchung',
      bookingDate: booking?.date || '',
      venue:       booking?.venue || offer?.location || '',
      cancelDate:  cancelDate,
      cancelReason,
    },

    // Referenzrechnung in der Mail anzeigen (falls vorhanden)
    invoice: {
      number: refInvoiceNo || '',
      date:   refInvoiceDate
                ? new Intl.DateTimeFormat('de-DE').format(new Date(refInvoiceDate))
                : '',
    },

    // Kündigungsnummer/Datum optional im Template nutzbar
    cancellation: {
      number: cancellationNo || '',
      date:   cancelDate ? new Intl.DateTimeFormat('de-DE').format(new Date(cancelDate)) : '',

     
  endDate: endDateDE || '',
    },

    signature: {
      signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
      name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
    },

    legal: {
      line: `${brand.company} · ${brand.addr1} · ${brand.addr2} · ${brand.email}`,
      disclaimer:
        'This e-mail may contain confidential and/or privileged information. If you are not the intended recipient, please notify the sender and destroy this e-mail.',
    },
  };

  const html = renderMjmlFile('templates/emails/cancellation.mjml', ctx);

  const attachments = [
    ...(logoAttachment ? [logoAttachment] : []),
    { filename: 'Kuendigungsbestaetigung.pdf', content: ensureBuf },
  ];

  await sendMail({
    to,
    subject: 'Kündigungsbestätigung',
    text: '',
    html,
    attachments,
  });
}












// utils/mailer.js  — NEU
async function sendBookingCancelledConfirmedEmail({ to, booking, offer }) {
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

  const venue       = booking?.venue || offer?.location || '';
  const program     = booking?.program || booking?.level || offer?.title || offer?.sub_type || offer?.type || 'Kurs';
  const dayTimes    = booking?.dayTimes || booking?.weekday || '';
  const timeDisplay = booking?.timeDisplay || booking?.time || booking?.uhrzeit || '';

  const ctx = {
    brand: { ...brand, logoUrl },
    greetingName: booking.firstName || 'Sportler',
    confirmationCode: booking.confirmationCode || '',
    dateDE,
    booking: { program, dayTimes, timeDisplay, venue },
    signature: {
      signoff: process.env.MAIL_SIGNOFF || 'Mit sportlichen Grüßen',
      name:    process.env.MAIL_SIGNER  || 'Selcuk Kocyigit',
    },
  };

  // Template: templates/emails/booking-cancelled-confirmed.mjml
  const html = renderMjmlFile('templates/emails/booking-cancelled-confirmed.mjml', ctx);

  const attachments = logoAttachment ? [logoAttachment] : [];
  await sendMail({
    to,
    subject: `Absage des bestätigten Termins – ${program}${dateDE ? ` am ${dateDE}` : ''}`,
    text: '',
    html,
    attachments,
  });
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

  sendPasswordResetMail,
  // Legacy
  sendBookingConfirmationEmail,

sendBookingCancelledConfirmedEmail,
};











