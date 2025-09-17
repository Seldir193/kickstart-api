// utils/pdfData.js
'use strict';

function toISODate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}



function sanitizeCourseTitle(raw) {
  if (!raw) return '';
  let s = String(raw).trim();

  // an erster Trennmarke (• | — – |) mit/ohne Leerzeichen sauber abschneiden
  s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];

  // hinter Komma + Zahl (Hausnr/PLZ) abschneiden
  const commaDigit = s.search(/,\s*\d/);
  if (commaDigit > 0) s = s.slice(0, commaDigit);

  // hinter " - " + Zahl ebenfalls abschneiden (falls Adresse mit Bindestrich eingeleitet wird)
  const dashAddr = s.search(/\s-\s*\d/);
  if (dashAddr > 0) s = s.slice(0, dashAddr);

  return s.trim();
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
   // offerTitle: (offer.title    || booking.offerTitle || ''),
    offerTitle: (offer.title || offer.sub_type || booking.offerTitle || booking.offerType || ''),

    //offerType : (offer.type     || booking.offerType  || ''),
    offerType : (offer.sub_type || booking.offerType  || offer.type || ''),
    venue     : (offer.location || booking.venue      || booking.offerLocation || ''),

    // Kerndaten
    date      : toISODate(booking.date),
    status    : booking.status || '',
    cancelDate  : toISODate(booking.cancelDate || booking.cancellationDate || booking.canceledAt || ''),
    cancelReason: booking.cancelReason || booking.cancellationReason || '',
    endDate     : toISODate(booking.endDate || ''),

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


// utils/pdfData.js
function shapeCancellationData({ customer, booking, offer, date, endDate, reason }) {
  const shapedBooking = shapeBooking(booking, offer);

  // Eingang der Kündigung (vom …)
  const requestISO =
    toISODate(booking?.requestDate) ||
    toISODate(booking?.cancelRequestDate) ||
    toISODate(date) ||                       // Param 'date' = Eingang vom Controller
    shapedBooking.cancelDate;                // Fallback: gespeichertes cancelDate

  // Beendigungsdatum (zum …) – erst echte Werte, sonst später Auto-Fallback
  let endISO =
    toISODate(endDate) ||
    toISODate(booking?.endDate) ||
    toISODate(booking?.cancelEndDate) ||
    toISODate(booking?.cancellationEndDate) ||
    '';

  // 🔁 Auto-Fallback: wenn kein Enddatum vorhanden → +1 Monat ab requestISO/cancelDate
  if (!endISO) {
    const baseISO = requestISO || shapedBooking.cancelDate || '';
    if (baseISO) {
      const d = new Date(`${baseISO}T00:00:00`);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = d.getMonth();
        const day = d.getDate();

        // Zielmonat +1:
        const targetY = (m === 11) ? (y + 1) : y;
        const targetM = (m + 1) % 12;

        // letzter Tag des Zielmonats
        const lastDayTargetMonth = new Date(targetY, targetM + 1, 0).getDate();
        const targetDay = Math.min(day, lastDayTargetMonth);

        const end = new Date(targetY, targetM, targetDay);
        endISO = toISODate(end);
      }
    }
  }

  return {
    customer: shapeCustomer(customer, booking),
    booking : shapedBooking,
    details : {
      requestDate: requestISO,
      cancelDate : toISODate(date) || shapedBooking.cancelDate,
      endDate    : endISO,
      reason     : (reason || shapedBooking.cancelReason || ''),
    },
  };
}

















function shapeParticipationData({ customer, booking, offer }) {
  const shapedCustomer = shapeCustomer(customer, booking);
  const shapedBooking  = shapeBooking(booking, offer);

  // 1) Kursname: nimm booking.offer, aber säubere ihn von Adressanteilen
  const cleanOffer =
    sanitizeCourseTitle(
      booking?.offer ||
      shapedBooking.offerTitle ||
      shapedBooking.offerType ||
      offer?.title ||
      ''
    );

  // 2) Kurstag/Zeit aus deinen vorhandenen Feldern übernehmen (fallbacks optional)
  const dayTimes     = booking?.dayTimes || booking?.kurstag || booking?.weekday || '';
  //const timeDisplay  = booking?.timeDisplay || booking?.kurszeit || booking?.uhrzeit || ''; 

  // in shapeParticipationData(...)
const timeDisplay =
  booking?.timeDisplay ||
  booking?.kurszeit ||
  booking?.time ||      // ← dies noch ergänzen
  booking?.uhrzeit ||
  '';


  return {
    customer: shapedCustomer,
    booking : {
      ...shapedBooking,
      // wichtig: diese 3 Felder fürs Template bereitstellen
      offer: cleanOffer,          // ← nur Kursname, ohne Adresse
      dayTimes,                   // ← "Sonntag"
      timeDisplay,                // ← "15:00 bis 16:00"
    },
  };
}






module.exports = {
  shapeStornoData,
  shapeCancellationData,
  shapeParticipationData,
  normalizeInvoiceNo, // <-- exportieren, damit pdf.js Overrides normalisieren kann
 
};






















