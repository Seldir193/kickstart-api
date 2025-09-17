// utils/pdf.js
'use strict';

require('dotenv').config();

/* ------------------------------------------------------------------ */
/* Load HTML renderer (utils/pdfHtml.js)                               */
/* ------------------------------------------------------------------ */
let htmlRenderer;
try {
  // Erwartete Exporte: bookingPdfBufferHTML, buildParticipationPdfHTML, buildCancellationPdfHTML, buildStornoPdfHTML
  htmlRenderer = require('./pdfHtml');
} catch (e) {
  const msg =
    '[utils/pdf] Konnte ./pdfHtml nicht laden. Erwartete Exporte: ' +
    'bookingPdfBufferHTML, buildParticipationPdfHTML, buildCancellationPdfHTML, buildStornoPdfHTML.\n' +
    `Originalfehler: ${e && e.message ? e.message : String(e)}`;
  throw new Error(msg);
}

function assertFn(name) {
  if (typeof htmlRenderer[name] !== 'function') {
    throw new Error(`[utils/pdf] Erwartete Funktion "${name}" fehlt in utils/pdfHtml.js`);
  }
}

/* ------------------------------------------------------------------ */
/* Optionales Shaping                                                  */
/* ------------------------------------------------------------------ */
const {
  shapeParticipationData,
  shapeCancellationData,
  shapeStornoData,
  normalizeInvoiceNo,
} = require('./pdfData');

/* ================================================================== */
/* ============================ PUBLIC API =========================== */
/* ================================================================== */

/**
 * (Legacy) Einfache Buchungsbestätigung (altes Format).
 * @param {object} booking
 * @returns {Promise<Buffer>} PDF
 */
async function bookingPdfBuffer(booking) {
  assertFn('bookingPdfBufferHTML');
  return htmlRenderer.bookingPdfBufferHTML(booking);
}

/**
 * Teilnahme/Rechnung (Hauptrechnung).
 * Unterstützte optionale Felder:
 *  - invoiceNo (Kurzformat z. B. "AT-25-0013")
 *  - invoiceDate (Date | ISO-String)
 *  - monthlyAmount, firstMonthAmount
 *  - venue (Veranstaltungsort)
 */
async function buildParticipationPdf({
  customer,
  booking,
  offer,
  invoiceNo,
  invoiceDate,
  monthlyAmount,
  firstMonthAmount,
  venue,
} = {}) {
  assertFn('buildParticipationPdfHTML');

  // Shaping für Template
  const shaped = shapeParticipationData({ customer, booking, offer });

  // Zusatzwerte in den Booking-Kontext übernehmen (damit Templates Fallbacks haben)
  if (venue && !shaped.booking.venue) shaped.booking.venue = venue;
  if (invoiceNo) shaped.booking.invoiceNo = normalizeInvoiceNo(invoiceNo);
  if (invoiceDate) shaped.booking.invoiceDate = String(invoiceDate);
  if (monthlyAmount != null) shaped.booking.monthlyAmount = Number(monthlyAmount);
  if (firstMonthAmount != null) shaped.booking.firstMonthAmount = Number(firstMonthAmount);

  // Kurstag & Zeit sicher durchreichen (Fallbacks auf Rohbooking)
  shaped.booking.dayTimes =
    shaped.booking.dayTimes ||
    booking?.dayTimes ||
    booking?.kurstag ||
    booking?.weekday ||
    '';

  shaped.booking.timeDisplay =
    shaped.booking.timeDisplay ||
    booking?.timeDisplay ||
    booking?.kurszeit ||
    booking?.time ||
    booking?.uhrzeit ||
    '';

  // → Renderer
  return htmlRenderer.buildParticipationPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    invoiceNo,
    invoiceDate,
    monthlyAmount,
    firstMonthAmount,
    venue,
  });
}




// utils/pdf.js  (nur der relevante Teil in buildCancellationPdf)

async function buildCancellationPdf({ customer, booking, offer, date, endDate, reason,
  cancellationNo, refInvoiceNo, refInvoiceDate, referenceInvoice } = {}) {
  assertFn('buildCancellationPdfHTML');

  const shaped = shapeCancellationData({ customer, booking, offer, date, endDate, reason });

  if (cancellationNo) shaped.booking.cancellationNo = String(cancellationNo);
  if (refInvoiceNo)   shaped.booking.refInvoiceNo   = normalizeInvoiceNo(refInvoiceNo);
  if (refInvoiceDate) shaped.booking.refInvoiceDate = String(refInvoiceDate);
  if (referenceInvoice?.number && !shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = normalizeInvoiceNo(referenceInvoice.number);
  }
  if (referenceInvoice?.date && !shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = String(referenceInvoice.date);
  }
  if (!shaped.booking.refInvoiceNo)    shaped.booking.refInvoiceNo    = shaped.booking.invoiceNo || '';
  if (!shaped.booking.refInvoiceDate)  shaped.booking.refInvoiceDate  = shaped.booking.invoiceDate || '';

  // 🔒 WICHTIG: immer auch ins booking spiegeln (damit Template/Renderer beide Varianten bekommen)
  if (!shaped.booking.cancelDate) shaped.booking.cancelDate = shaped.details.cancelDate;
  if (!shaped.booking.endDate)    shaped.booking.endDate    = shaped.details.endDate;

  console.log('[PDF cancel] dates:', {
    requestDate: shaped.details.requestDate,
    cancelDate : shaped.details.cancelDate,
    endDate    : shaped.details.endDate,
  });

  return htmlRenderer.buildCancellationPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    date       : shaped.details.cancelDate,
    reason     : shaped.details.reason,
    requestDate: shaped.details.requestDate,
    endDate    : shaped.details.endDate,
  });
}






/**
 * Storno-Rechnung.
 * Unterstützte optionale Felder:
 *  - amount, currency
 *  - stornoNo
 *  - refInvoiceNo / refInvoiceDate ODER referenceInvoice: { number, date }
 */
async function buildStornoPdf({
  customer,
  booking,
  offer,
  amount,
  currency = 'EUR',
  stornoNo,
  refInvoiceNo,
  refInvoiceDate,
  referenceInvoice,
} = {}) {
  assertFn('buildStornoPdfHTML');

  // Shaping
  const shaped = shapeStornoData({ customer, booking, offer, amount, currency });

  // Fallback-Betrag
  const effAmount =
    Number.isFinite(Number(shaped.amount)) ? Number(shaped.amount)
    : (offer && typeof offer.price === 'number' ? offer.price : 0);

  const curr = String(shaped.currency || 'EUR');

  // Nummern/Referenzen normalisieren
  if (stornoNo)       shaped.booking.stornoNo       = String(stornoNo);
  if (refInvoiceNo)   shaped.booking.refInvoiceNo   = normalizeInvoiceNo(refInvoiceNo);
  if (refInvoiceDate) shaped.booking.refInvoiceDate = String(refInvoiceDate);

  if (referenceInvoice?.number && !shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = normalizeInvoiceNo(referenceInvoice.number);
  }
  if (referenceInvoice?.date && !shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = String(referenceInvoice.date);
  }

  // Fallbacks aus vorhandener Rechnung ziehen
  if (!shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = shaped.booking.invoiceNo || '';
  }
  if (!shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = shaped.booking.invoiceDate || '';
  }

  // Debug: bei Bedarf aktiv lassen/entfernen
  console.log('[PDF storno] ref:', {
    refNo:   shaped.booking.refInvoiceNo,
    refDate: shaped.booking.refInvoiceDate,
    invNo:   shaped.booking.invoiceNo,
    invDate: shaped.booking.invoiceDate,
  });

  // → Renderer
  return htmlRenderer.buildStornoPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    amount  : effAmount,
    currency: curr,
  });
}

/* ------------------------------------------------------------------ */
/* Exporte                                                             */
/* ------------------------------------------------------------------ */
module.exports = {
  bookingPdfBuffer,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
};
