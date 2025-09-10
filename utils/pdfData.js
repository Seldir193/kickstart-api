// utils/pdfData.js
'use strict';

function toISODate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}


/** Rechnungsnummern vereinheitlichen, z. B. "KIGA-25-0044" */
function normalizeInvoiceNo(v) {
  if (!v) return '';
  let s = String(v).trim();

  // führende ObjectId + "/" entfernen
  s = s.replace(/^[a-f0-9]{24}\//i, '');

  // Backslashes vereinheitlichen
  s = s.replace(/\\/g, '/');

  // "CODE/YYYY/SEQ" oder "CODE-YYYY-SEQ" -> "CODE-YY-PPPP"
  const m1 = s.match(/^([A-Z0-9ÄÖÜ]+)[\/\-](\d{2}|\d{4})[\/\-](\d{1,5})$/i);
  if (m1) {
    const code = m1[1].toUpperCase();
    const yy   = m1[2].slice(-2);
    const seq  = String(m1[3]).padStart(4, '0');
    return `${code}-${yy}-${seq}`;
  }

  // Bereits "CODE-YY-SEQ" -> SEQ auf 4 Stellen
  const m2 = s.match(/^([A-Z0-9ÄÖÜ]+)\s*-\s*(\d{2})\s*-\s*(\d{1,5})$/i);
  if (m2) {
    const code = m2[1].toUpperCase();
    const yy   = m2[2];
    const seq  = String(m2[3]).padStart(4, '0');
    return `${code}-${yy}-${seq}`;
  }

  return s.toUpperCase();
}

// … restlicher Code …


/** Customer → Template-Shape (mit Fallbacks aus Booking) */
function shapeCustomer(customer = {}, booking = {}) {
  const parent = customer.parent || {};
  const child  = customer.child  || {};
  const addr   = customer.address|| {};

  return {
    userId : String(customer.userId ?? customer._id ?? ''),
    parent : {
      salutation: parent.salutation || '',
      firstName : parent.firstName  || booking.firstName || '',
      lastName  : parent.lastName   || booking.lastName  || '',
      email     : parent.email      || booking.email     || '',
    },
    child  : {
      firstName: child.firstName || booking.firstName || '',
      lastName : child.lastName  || booking.lastName  || '',
    },
    address: {
      street : addr.street  || '',
      houseNo: addr.houseNo || '',
      zip    : addr.zip     || '',
      city   : addr.city    || '',
    },
  };
}

/** Booking → Template-Shape (inkl. optionaler Accounting-/Referenzfelder) */
function shapeBooking(booking = {}, offer = {}) {
  // Preise aus Booking-Ref übernehmen, falls vorhanden
  const monthlyAmount =
    (booking.monthlyAmount != null && Number.isFinite(Number(booking.monthlyAmount)))
      ? Number(booking.monthlyAmount)
      : (booking.priceMonthly != null && Number.isFinite(Number(booking.priceMonthly)))
        ? Number(booking.priceMonthly)
        : undefined;

  const firstMonthAmount =
    (booking.firstMonthAmount != null && Number.isFinite(Number(booking.firstMonthAmount)))
      ? Number(booking.firstMonthAmount)
      : (booking.priceFirstMonth != null && Number.isFinite(Number(booking.priceFirstMonth)))
        ? Number(booking.priceFirstMonth)
        : undefined;

  // Rechnungsnummern/Referenzen robust mit Fallbacks
  const invoiceNoRaw       = booking.invoiceNo || booking.invoiceNumber || '';
  const invoiceDateISO     = toISODate(booking.invoiceDate || '');

  // Referenzen für Kündigung/Storno: wenn explizit nicht gesetzt,
  // fallback auf vorhandene Rechnungsinfos am Booking
  const refInvoiceNoRaw      = booking.refInvoiceNo || invoiceNoRaw || '';
  const refInvoiceDateISO    = toISODate(booking.refInvoiceDate || invoiceDateISO || '');

  return {
    _id       : booking._id || '',

    // Angebot: primär Offer, sekundär Snapshot im Booking
    offerTitle: (offer.title    || booking.offerTitle || ''),
    offerType : (offer.type     || booking.offerType  || ''),
    venue     : (offer.location || booking.venue      || booking.offerLocation || ''),

    // Kerndaten
    date      : toISODate(booking.date),
    status    : booking.status || '',
    cancelDate  : toISODate(booking.cancelDate || booking.cancellationDate || booking.canceledAt || ''),
    cancelReason: booking.cancelReason || booking.cancellationReason || '',

    // Sonstiges
    level     : booking.level || '',
    confirmationCode: booking.confirmationCode || '',

    // >>> Additiv: Preise/Invoice/Referenzen (nur gesetzt, wenn vorhanden)
    monthlyAmount,
    firstMonthAmount,

    // NORMALISIERT ausgeben
    invoiceNo:        normalizeInvoiceNo(invoiceNoRaw),
    invoiceDate:      invoiceDateISO,

    cancellationNo:   booking.cancellationNo || '',
    refInvoiceNo:     normalizeInvoiceNo(refInvoiceNoRaw),
    refInvoiceDate:   refInvoiceDateISO,

    stornoNo: booking.stornoNo || '',
  };
}

/** Storno */
function shapeStornoData({ customer, booking, offer, amount, currency = 'EUR' }) {
  // amount robust (Zahl oder numerischer String); ansonsten undefined → Fallback passiert später
  let amt;
  if (amount === undefined || amount === null || (typeof amount === 'string' && amount.trim() === '')) {
    amt = undefined;
  } else {
    const n = Number(amount);
    amt = Number.isFinite(n) ? n : undefined;
  }

  return {
    customer: shapeCustomer(customer, booking),
    booking : shapeBooking(booking, offer),
    amount  : amt,        // kann undefined sein → erlaubt Fallback auf offer.price
    currency,
  };
}

/** Kündigung */
function shapeCancellationData({ customer, booking, offer, date, reason }) {
  const shapedBooking = shapeBooking(booking, offer);
  return {
    customer: shapeCustomer(customer, booking),
    booking : shapedBooking,
    details : {
      cancelDate: toISODate(date) || shapedBooking.cancelDate,
      reason    : (reason || shapedBooking.cancelReason || ''),
    },
  };
}

/** Teilnahme */
function shapeParticipationData({ customer, booking, offer }) {
  return {
    customer: shapeCustomer(customer, booking),
    booking : shapeBooking(booking, offer),
  };
}

module.exports = {
  shapeStornoData,
  shapeCancellationData,
  shapeParticipationData,
  normalizeInvoiceNo, // <-- exportieren, damit pdf.js Overrides normalisieren kann
 
};






















