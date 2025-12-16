// utils/pdfHtml.js
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const Handlebars = require('handlebars');
const htmlToPdf = require('html-pdf-node');

/* ====================== Basics ====================== */
function projectRoot() { return path.resolve(__dirname, '..'); }
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/* ====================== Date utils ====================== */
function toDate(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toISODate(v) { const d = toDate(v); return d ? d.toISOString().slice(0, 10) : ''; }
function toDEDate(v)  { const d = toDate(v); return d ? new Intl.DateTimeFormat('de-DE').format(d) : ''; }

/* ====================== Assets ====================== */
function fileToDataUrl(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const ext = (path.extname(absPath).slice(1) || 'png').toLowerCase();
    const mime =
      ext === 'svg' ? 'image/svg+xml' :
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
      ext === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return ''; }
}

/** <link rel="stylesheet" href="..."> → inline <style> */
function inlineCssLinks(html, tplDir) {
  return html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (_m, href) => {
      const abs1 = path.isAbsolute(href) ? href : path.resolve(tplDir, href);
      let css = safeRead(abs1);
      if (css) return `<style>\n${css}\n</style>`;
      const abs2 = path.resolve(projectRoot(), href);
      css = safeRead(abs2);
      return css ? `<style>\n${css}\n</style>` : '';
    }
  );
}

/* ====================== Brand ====================== */
function getBrand() {
  const rawLogo =
    process.env.BRAND_LOGO_URL ||
    process.env.BRAND_LOGO_PATH ||
    process.env.PDF_LOGO ||
    '';

  let logoUrl = '';
  if (/^https?:\/\//i.test(rawLogo)) {
    logoUrl = rawLogo;
  } else if (rawLogo) {
    const abs = path.isAbsolute(rawLogo) ? rawLogo : path.resolve(process.cwd(), rawLogo);
    if (fs.existsSync(abs)) {
      logoUrl = fileToDataUrl(abs) || pathToFileURL(abs).toString();
    }
  }

  return {
    company: process.env.BRAND_COMPANY     || 'Münchner Fussball Schule NRW',
    addr1:   process.env.BRAND_ADDR_LINE1  || 'Hochfelder Str. 33',
    addr2:   process.env.BRAND_ADDR_LINE2  || '47226 Duisburg',
    email:   process.env.BRAND_EMAIL       || 'info@muenchner-fussball-schule.ruhr',
    website: process.env.BRAND_WEBSITE_URL || 'https://www.muenchner-fussball-schule.ruhr',
    iban:    process.env.BRAND_IBAN        || 'DE13350400380595090200',
    bic:     process.env.BRAND_BIC         || 'COBADEFFXXX',
    taxId:   process.env.BRAND_TAXID       || '',
    logoUrl,
  };
}

/* ====================== HBS Helpers ====================== */
Handlebars.registerHelper('fmtMoney', function (value, currency) {
  const num = Number(value ?? 0);
  const cur = (currency && String(currency)) || 'EUR';
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(num);
  } catch {
    const fixed = Number.isFinite(num) ? num.toFixed(2) : '0.00';
    return `${fixed} ${cur}`;
  }
});

Handlebars.registerHelper('fmtDate', function (input) {
  return toDEDate(input);
});

Handlebars.registerHelper('fullName', function (obj) {
  if (!obj) return '';
  const parts = [obj.salutation, obj.firstName, obj.lastName].filter(Boolean);
  return parts.join(' ');
});

// Kursname ohne Ort/Adresse (trennt an •, —, – oder |)
Handlebars.registerHelper('courseOnly', function (title) {
  if (!title) return '';
  const s = String(title);
  // an erster Trennmarke abschneiden (ohne normales Minus, damit Bindestrich-Namen bleiben)
  const cut = s.split(/\s*(?:[•|]|—|–)\s*/);
  return (cut[0] || '').trim();
});

// utils/pdfHtml.js

function isWeeklyOffer(offer) {
  const cat  = String(offer?.category || '').trim();
  const type = String(offer?.type || '').trim();
  const sub  = String(offer?.sub_type || '').trim();
  const title= String(offer?.title || '').trim();

  const lc = (s) => s.toLowerCase();

  // 🔒 explizite Non-Weekly Ausnahmen (egal was sonst drinsteht)
  const isExplicitNonWeekly =
    ['individual','holiday','clubprograms','club','camp'].includes(lc(cat)) ||
    ['PersonalTraining','AthleticTraining'].includes(type) ||
    lc(sub).includes('powertraining') ||
    /rent\s*a\s*coach|rentacoach|coach\s*education|trainerfortbildung|trainerausbildung/i.test(
      [cat, type, sub, title].join(' ')
    );

  if (isExplicitNonWeekly) return false;

  // ✅ Weekly Regeln
  if (cat === 'Weekly') return true;                  // neue, saubere Klassifizierung
  if (type === 'Foerdertraining' || type === 'Kindergarten') return true; // Fallback Altbestand

  // Default: Non-Weekly
  return false;
}

/* ====================== Templates ====================== */
function resolveHbsPath(baseName) {
  const name = String(baseName || '').trim();
  const file = name.endsWith('.hbs') ? name : `${name}.hbs`;
  const dirs = [
    process.env.PDF_TEMPLATES_DIR && path.resolve(projectRoot(), process.env.PDF_TEMPLATES_DIR),
    path.resolve(projectRoot(), 'templates', 'pdf'),
    path.resolve(process.cwd(), 'templates', 'pdf'),
  ].filter(Boolean);
  for (const dir of dirs) {
    const p = path.resolve(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function compileTemplate(baseName, data) {
  const filePath = resolveHbsPath(baseName);
  let html = filePath ? safeRead(filePath) : null;

  if (!html) {
    html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>PDF</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#111827;margin:24px">
  <h1>{{brand.company}}</h1>
  <div>Kein Template gefunden: ${baseName}.hbs</div>
</body></html>`;
  } else {
    html = inlineCssLinks(html, path.dirname(filePath));
  }

  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(data);
}

/* ====================== Render ====================== */
async function renderPdf(html, options = {}) {
  const file = { content: html };
  const opts = {
    format: 'A4',
    margin: { top: '15mm', right: '15mm', bottom: '18mm', left: '15mm' },
    printBackground: true,
    preferCSSPageSize: true,
    ...options,
  };
  return htmlToPdf.generatePdf(file, opts);
}

/* ====================== Shapers & Normalizer ====================== */
function hydrateCustomerWithBooking(customer = {}, booking = {}) {
  const parent = { ...(customer?.parent || {}) };
  const child  = { ...(customer?.child  || {}) };

  if (!parent.firstName && booking.firstName) parent.firstName = booking.firstName;
  if (!parent.lastName  && booking.lastName)  parent.lastName  = booking.lastName;
  if (!parent.firstName && child.firstName)   parent.firstName = child.firstName;
  if (!parent.lastName  && child.lastName)    parent.lastName  = child.lastName;

  if (!parent.email && booking.email) parent.email = booking.email; // wird später entfernt

  return {
    userId : String(customer?.userId ?? customer?._id ?? '-'),
    parent,
    child,
    address: customer?.address || {},
  };
}

function applyOfferSnapshot(booking = {}, offer) {
  const out = { ...booking };
  if (offer) {
    out.offerTitle = out.offerTitle || offer.title || offer.sub_type || offer.type || '';
    out.offerType  = out.offerType  || offer.sub_type || offer.type  || '';
    out.venue      = out.venue      || offer.location || '';
  }
  if (!out.offer && (out.offerTitle || out.offerType)) {
    out.offer = out.offerTitle || out.offerType;
  }
  return out;
}

function normalizeBookingForPdf(booking = {}) {
  const out = { ...booking };
  if (!out.venue && out.offerLocation) out.venue = out.offerLocation;
  out.cancelDate = out.cancelDate || out.cancellationDate || out.canceledAt || new Date();
  out.date = out.date || out.createdAt || new Date();
  out.dateISO = toISODate(out.date);
  out.dateDE  = toDEDate(out.date);
  return out;
}

/* ====================== Public API ====================== */

/** Legacy booking confirmation (unused by new flow, kept for compatibility) */
async function bookingPdfBufferHTML(booking) {
  const brand = getBrand();

  const dateDE = booking?.date
    ? new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date(booking.date))
    : '';

  const html = compileTemplate('booking-confirmation', {
    brand,
    booking: {
      confirmationCode: booking?.confirmationCode || '',
      fullName: booking?.fullName || [booking?.firstName, booking?.lastName].filter(Boolean).join(' '),
      email: booking?.email || '',
      program: booking?.program || booking?.level || '',
      date: dateDE,
      dateISO: booking?.date || '',
      message: booking?.message || '',
      status: booking?.status || '',
      confirmedAt: booking?.confirmedAt || null,
    },
  });

  return renderPdf(html);
}












// ⬇️ KOMPLETT ersetzen
async function buildParticipationPdfHTML({
  customer,
  booking,
  offer,
  invoiceNo,
  invoiceDate,
  monthlyAmount,
  firstMonthAmount,
  venue,
  isWeekly,       // kommt optional aus utils/pdf.js
  pricing,        // kommt aus utils/pdf.js (shaped.pricing)
  invoice,        // kommt aus utils/pdf.js (shaped.invoice)
}) {
  const brand = getBrand();

  // parent/child ohne E-Mail im PDF
  const parent = { ...(customer?.parent || {}) };
  if (Object.prototype.hasOwnProperty.call(parent, 'email')) {
    delete parent.email;
  }
  const child = { ...(customer?.child || {}) };

  const weekly =
    typeof isWeekly === 'boolean' ? isWeekly : isWeeklyOffer(offer);

  const finalVenue =
    venue || booking?.venue || offer?.location || '';

  const title =
    booking?.offerTitle ||
    booking?.offerType ||
    booking?.offer ||
    offer?.sub_type ||
    offer?.title ||
    '-';

  /* ---------- Wochentag/Zeit-Helfer ---------- */
  function weekdayFromISO(iso) {
    if (!iso) return '';
    const d = new Date(
      /\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso}T00:00:00` : iso
    );
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(d);
  }

  function timeRangeFromOffer(off, weekdayName = '') {
    if (!off) return '';
    const join = (f, t) =>
      [f, t]
        .filter(Boolean)
        .map(String)
        .map((s) => s.trim())
        .join(' – ');

    const norm = (v) => String(v || '').toLowerCase();
    const w = norm(weekdayName);

    if (Array.isArray(off.days) && off.days.length) {
      let cand =
        off.days.find(
          (d) =>
            norm(d?.day) === w ||
            norm(d?.weekday) === w ||
            norm(d?.tag) === w
        ) || off.days[0];

      if (cand && typeof cand === 'object') {
        const from =
          cand.timeFrom ??
          cand.from ??
          cand.start ??
          (cand.time && (cand.time.from ?? cand.timeStart));
        const to =
          cand.timeTo ??
          cand.to ??
          cand.end ??
          (cand.time && (cand.time.to ?? cand.timeEnd));
        if (from || to) return join(from, to);
        const t = cand.time ?? cand.zeit ?? cand.uhrzeit;
        if (t) return String(t).replace(/\s*-\s*/g, ' – ').trim();
      }
    }

    const from = off.timeFrom ?? off.from ?? off.start;
    const to   = off.timeTo   ?? off.to   ?? off.end;
    if (from || to) return join(from, to);
    const t = off.time ?? off.zeit ?? off.uhrzeit;
    return t ? String(t).replace(/\s*-\s*/g, ' – ').trim() : '';
  }

  // Wochentag/Zeit nur für Weeklies relevant
  const bookingDate = booking?.date || booking?.createdAt || null;

  const derivedDay = weekly
    ? (
        booking?.dayTimes ||
        booking?.kurstag ||
        booking?.weekday ||
        weekdayFromISO(bookingDate)
      )
    : '';

  const derivedTime = weekly
    ? (
        booking?.timeDisplay ||
        booking?.kurszeit ||
        booking?.time ||
        booking?.uhrzeit ||
        timeRangeFromOffer(offer, derivedDay)
      )
    : '';

  const dayTimes    = weekly ? derivedDay  : '';
  const timeDisplay = weekly ? derivedTime : '';

  /* ---------- Pricing / Invoice aus utils/pdf.js übernehmen ---------- */

  const effInvoice = { ...(invoice || {}) };
  const effPricing = { ...(pricing || {}) };

  // optional übergebene Werte nur als Fallback benutzen
  if (invoiceNo && !effInvoice.number) {
    effInvoice.number = invoiceNo;
  }
  if (invoiceDate && !effInvoice.date) {
    effInvoice.date = invoiceDate;
  }

  // Monatsbeträge nur für Weeklies
  if (weekly && typeof monthlyAmount === 'number') {
    effInvoice.monthly = monthlyAmount;
    effPricing.monthly = monthlyAmount;
  }
  if (weekly && typeof firstMonthAmount === 'number') {
    effInvoice.firstMonth = firstMonthAmount;
    effPricing.firstMonth = firstMonthAmount;
  }

  // Währung
  let currency =
    effInvoice.currency ||
    effPricing.currency ||
    'EUR';
  effInvoice.currency = currency;
  effPricing.currency = currency;

  /* ---------- Rabatt-Infos für Camps/Holiday/Non-Weekly ---------- */

  let discount = null;

  if (!weekly && booking) {
    // 1️⃣ Wenn utils/pdf.js schon booking.discount gebaut hat → bevorzugen
    if (booking.discount) {
      discount = { ...booking.discount };
    } else {
      // 2️⃣ Fallback: aus booking.meta + offer.price berechnen
      const meta = booking.meta || {};

      const basePrice =
        typeof meta.basePrice === 'number'
          ? meta.basePrice
          : (typeof offer?.price === 'number'
              ? offer.price
              : undefined);

      const siblingDiscount = Number(meta.siblingDiscount || 0);
      const memberDiscount  = Number(meta.memberDiscount  || 0);

      const totalDiscount =
        meta.totalDiscount != null
          ? Number(meta.totalDiscount)
          : siblingDiscount + memberDiscount;

      const finalPrice =
        typeof booking.priceAtBooking === 'number'
          ? Number(booking.priceAtBooking)
          : (typeof basePrice === 'number'
              ? Math.max(0, basePrice - totalDiscount)
              : undefined);

      discount = {
        basePrice,
        siblingDiscount,
        memberDiscount,
        totalDiscount,
        finalPrice,
      };
    }
  }

  // Effektiver Einmalpreis fürs Template (Endpreis nach Rabatt, falls vorhanden)
  let effectiveSingle;
  if (!weekly) {
    if (
      discount &&
      discount.finalPrice != null &&
      Number.isFinite(Number(discount.finalPrice))
    ) {
      effectiveSingle = Number(discount.finalPrice);
    } else if (
      effInvoice.single != null &&
      Number.isFinite(Number(effInvoice.single))
    ) {
      effectiveSingle = Number(effInvoice.single);
    } else if (
      effPricing.single != null &&
      Number.isFinite(Number(effPricing.single))
    ) {
      effectiveSingle = Number(effPricing.single);
    } else if (typeof offer?.price === 'number') {
      effectiveSingle = offer.price;
    }

    if (effectiveSingle != null) {
      effInvoice.single = effectiveSingle;
      effPricing.single = effectiveSingle;

      if (
        discount &&
        (discount.finalPrice == null ||
          !Number.isFinite(Number(discount.finalPrice)))
      ) {
        discount.finalPrice = effectiveSingle;
      }
    }
  }

  /* ---------- Booking-Kontext fürs Template ---------- */

  const bookingCtx = {
    ...(booking || {}),
    offerTitle: title,
    date: booking?.date || '',
    status: booking?.status || 'active',
    venue: finalVenue,
    offer: booking?.offer || title,
    dayTimes,
    timeDisplay,
  };

  if (discount) {
    bookingCtx.discount = discount;
  }

  const flags = {
    isWeekly: weekly,
    isOneOff: !weekly,
  };

  const html = compileTemplate('participation', {
    brand,
    flags,
    customer: {
      userId : customer?.userId ?? '-',
      parent,
      child,
      address: customer?.address || {},
    },
    booking: bookingCtx,
    pricing: effPricing,
    invoice: effInvoice,
  });

  return renderPdf(html);
}











/** Kündigungsbestätigung (mit Kündigungs-Nr. + Referenz-Rechnung) */
async function buildCancellationPdfHTML({
  customer,
  booking,
  offer,
  requestDate,
  endDate,
  date,
  reason,
  cancellationNo,
  referenceInvoice,
}) {
  const brand = getBrand();

  const hydrated     = hydrateCustomerWithBooking(customer, booking);
  const withOffer    = applyOfferSnapshot(booking, offer);
  const normBooking  = normalizeBookingForPdf(withOffer);
  const cancelDate   = date || normBooking.cancelDate;
  const reqDate      = requestDate || cancelDate;
  const endDateEff   = endDate || normBooking.endDate || null;

  const parent = { ...hydrated.parent };
  if (Object.prototype.hasOwnProperty.call(parent, 'email')) delete parent.email;
  const child = { ...hydrated.child };

  const effectiveCancellationNo =
    cancellationNo ||
    normBooking.cancellationNo ||
    normBooking.cancellationNumber ||
    `KND-${String(normBooking._id || '').slice(-6).toUpperCase()}`;

  const refInvoiceNo =
    (referenceInvoice && referenceInvoice.number) ||
    normBooking.refInvoiceNo ||
    normBooking.originalInvoiceNo ||
    normBooking.invoiceNo ||
    normBooking.invoiceNumber ||
    '';

  const refInvoiceDate =
    (referenceInvoice && referenceInvoice.date) ||
    normBooking.refInvoiceDate ||
    normBooking.originalInvoiceDate ||
    normBooking.invoiceDate ||
    '';
  const refInvoiceDateDE = toDEDate(refInvoiceDate);

  const html = compileTemplate('cancellation', {
    brand,
    customer: {
      userId: hydrated.userId,
      parent,
      child,
      address: hydrated.address,
    },
    booking: {
      offerTitle: normBooking.offerTitle || normBooking.offerType || normBooking.offer || '-',
      offerType : normBooking.offerType || '',
      offer     : normBooking.offer || '',
      venue     : normBooking.venue || '',
      cancelDate,
      cancellationNo: effectiveCancellationNo,
      refInvoiceNo,
      refInvoiceDate,
      refInvoiceDateDE,
    },
    details: {
      requestDate: toDate(reqDate) || toDate(cancelDate) || new Date(),
      endDate    : toDate(endDateEff),
      cancelDate : toDate(cancelDate) || new Date(),
      reason     : reason || normBooking.cancelReason || '',
    },
  });
  return renderPdf(html);
}

/** Storno-Rechnung (mit Storno-Nr. + Referenz-Rechnung) */
async function buildStornoPdfHTML({
  customer,
  booking,
  offer,
  amount = 0,
  currency = 'EUR',
  stornoNo,
  referenceInvoice,
}) {
  const brand = getBrand();

  const hydrated     = hydrateCustomerWithBooking(customer, booking);
  const withOffer    = applyOfferSnapshot(booking, offer);
  const normBooking  = normalizeBookingForPdf(withOffer);

  const amountNum =
    Number.isFinite(Number(amount)) ? Number(amount)
      : (offer && typeof offer.price === 'number' ? offer.price : 0);

  const curr = String(currency || 'EUR');
  const taxNote = 'Umsatzsteuerbefreit nach § 19 UStG';

  const parent = { ...hydrated.parent };
  if (Object.prototype.hasOwnProperty.call(parent, 'email')) delete parent.email;
  const child = { ...hydrated.child };

  const effectiveStornoNo =
    stornoNo ||
    normBooking.stornoNo ||
    `STORNO-${String(normBooking._id || '').slice(-6).toUpperCase()}`;

  const refInvoiceNo =
    (referenceInvoice && referenceInvoice.number) ||
    normBooking.refInvoiceNo ||
    normBooking.originalInvoiceNo ||
    normBooking.invoiceNo ||
    normBooking.invoiceNumber ||
    '';

  const refInvoiceDate =
    (referenceInvoice && referenceInvoice.date) ||
    normBooking.refInvoiceDate ||
    normBooking.originalInvoiceDate ||
    normBooking.invoiceDate ||
    '';
  const refInvoiceDateDE = toDEDate(refInvoiceDate);

  const html = compileTemplate('storno', {
    brand,
    customer: {
      userId: hydrated.userId,
      parent,
      child,
      address: hydrated.address,
    },
    booking: {
      ...normBooking,
      offerTitle: normBooking.offerTitle || normBooking.offerType || normBooking.offer || '-',
      offerType : normBooking.offerType || '',
      offer     : normBooking.offer || '',
      venue     : normBooking.venue || '',
      cancelDate: normBooking.cancelDate,
      stornoNo : effectiveStornoNo,
      refInvoiceNo,
      refInvoiceDate,
      refInvoiceDateDE,
    },
    amount: amountNum,
    currency: curr,
    taxNote,
  });

  return renderPdf(html);
}

module.exports = {
  bookingPdfBufferHTML,
  buildParticipationPdfHTML,
  buildCancellationPdfHTML,
  buildStornoPdfHTML,
};










