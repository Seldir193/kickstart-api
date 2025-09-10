// utils/pdf.js
'use strict';

require('dotenv').config();

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

// Optionales Shaping (falls vorhanden/gewünscht)
const {
  shapeParticipationData,
  shapeCancellationData,
  shapeStornoData,
  normalizeInvoiceNo,
} = require('./pdfData');

/* ================= Öffentliche Wrapper ================= */

/** (Legacy) Einfache Buchungsbestätigung (altes Format) */
async function bookingPdfBuffer(booking) {
  assertFn('bookingPdfBufferHTML');
  return htmlRenderer.bookingPdfBufferHTML(booking);
}

/**
 * Teilnahme/Rechnung (Hauptrechnung)
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

  const shaped = shapeParticipationData({ customer, booking, offer });

  // Zusatzwerte in den Booking-Kontext übernehmen (damit Templates Fallbacks haben)
  if (venue && !shaped.booking.venue) shaped.booking.venue = venue;
  //if (invoiceNo) shaped.booking.invoiceNo = String(invoiceNo);
  if (invoiceNo) shaped.booking.invoiceNo = normalizeInvoiceNo(invoiceNo);
  if (invoiceDate) shaped.booking.invoiceDate = String(invoiceDate);
  if (monthlyAmount != null) shaped.booking.monthlyAmount = Number(monthlyAmount);
  if (firstMonthAmount != null) shaped.booking.firstMonthAmount = Number(firstMonthAmount);

  // Explizit auch als Parameter weiterreichen (Param > booking.* im Renderer)
  return htmlRenderer.buildParticipationPdfHTML({
    customer: shaped.customer,
    booking: shaped.booking,
    offer,
    invoiceNo,
    invoiceDate,
    monthlyAmount,
    firstMonthAmount,
    venue,
  });
}







/**
 * Kündigungsbestätigung
 * Unterstützte optionale Felder:
 *  - cancellationNo (z. B. "KND-925B67")
 *  - refInvoiceNo / refInvoiceDate ODER referenceInvoice: { number, date }
 */
async function buildCancellationPdf({
  customer,
  booking,
  offer,
  date,
  reason,
  cancellationNo,
  refInvoiceNo,
  refInvoiceDate,
  referenceInvoice,
} = {}) {
  assertFn('buildCancellationPdfHTML');

  const shaped = shapeCancellationData({ customer, booking, offer, date, reason });


  if (cancellationNo) shaped.booking.cancellationNo = String(cancellationNo);
if (refInvoiceNo)   shaped.booking.refInvoiceNo   = normalizeInvoiceNo(refInvoiceNo);
if (refInvoiceDate) shaped.booking.refInvoiceDate = String(refInvoiceDate);

if (referenceInvoice?.number && !shaped.booking.refInvoiceNo) {
  shaped.booking.refInvoiceNo = normalizeInvoiceNo(referenceInvoice.number);
}
if (referenceInvoice?.date && !shaped.booking.refInvoiceDate) {
  shaped.booking.refInvoiceDate = String(referenceInvoice.date);
}


  // >>> WICHTIG: Fallbacks aus vorhandener Rechnung ziehen
  if (!shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = shaped.booking.invoiceNo || '';
  }
  if (!shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = shaped.booking.invoiceDate || '';
  }

  console.log('[PDF cancel] ref:', {
    refNo:   shaped.booking.refInvoiceNo,
    refDate: shaped.booking.refInvoiceDate,
    invNo:   shaped.booking.invoiceNo,
    invDate: shaped.booking.invoiceDate,
  });

  return htmlRenderer.buildCancellationPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    date    : shaped.details.cancelDate,
    reason  : shaped.details.reason,
  });
}

/**
 * Storno-Rechnung
 * Unterstützte optionale Felder:
 *  - amount, currency
 *  - stornoNo (z. B. "STORNO-925CF4")
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

  const shaped = shapeStornoData({ customer, booking, offer, amount, currency });

  const effAmount =
    Number.isFinite(Number(shaped.amount)) ? Number(shaped.amount)
    : (offer && typeof offer.price === 'number' ? offer.price : 0);

  const curr = String(shaped.currency || 'EUR');




if (stornoNo)       shaped.booking.stornoNo       = String(stornoNo);
if (refInvoiceNo)   shaped.booking.refInvoiceNo   = normalizeInvoiceNo(refInvoiceNo);
if (refInvoiceDate) shaped.booking.refInvoiceDate = String(refInvoiceDate);

if (referenceInvoice?.number && !shaped.booking.refInvoiceNo) {
  shaped.booking.refInvoiceNo = normalizeInvoiceNo(referenceInvoice.number);
}
if (referenceInvoice?.date && !shaped.booking.refInvoiceDate) {
  shaped.booking.refInvoiceDate = String(referenceInvoice.date);
}

  // >>> WICHTIG: Fallbacks aus vorhandener Rechnung ziehen
  if (!shaped.booking.refInvoiceNo) {
    shaped.booking.refInvoiceNo = shaped.booking.invoiceNo || '';
  }
  if (!shaped.booking.refInvoiceDate) {
    shaped.booking.refInvoiceDate = shaped.booking.invoiceDate || '';
  }

  console.log('[PDF storno] ref:', {
    refNo:   shaped.booking.refInvoiceNo,
    refDate: shaped.booking.refInvoiceDate,
    invNo:   shaped.booking.invoiceNo,
    invDate: shaped.booking.invoiceDate,
  });

  return htmlRenderer.buildStornoPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    amount  : effAmount,
    currency: curr,
  });
}









module.exports = {
  bookingPdfBuffer,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
};
