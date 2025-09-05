// utils/pdf.js
'use strict';

require('dotenv').config();

let htmlRenderer;
try {
  htmlRenderer = require('./pdfHtml'); // erwartet die 4 Funktionen unten
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

// Optionales Shaping (falls du es weiter nutzen willst):
const {
  shapeParticipationData,
  shapeCancellationData,
  shapeStornoData,
} = require('./pdfData');

/* ================= Öffentliche Wrapper ================= */

async function bookingPdfBuffer(booking) {
  assertFn('bookingPdfBufferHTML');
  return htmlRenderer.bookingPdfBufferHTML(booking);
}

async function buildParticipationPdf({
  customer,
  booking,
  offer,
  invoiceNo,
  monthlyAmount,
  firstMonthAmount,
  venue,
  invoiceDate,
} = {}) {
  assertFn('buildParticipationPdfHTML');

  // shape nutzt offer für Titel/Venue – danach noch an Renderer geben
  const shaped = shapeParticipationData({ customer, booking, offer });

  if (venue && !shaped.booking.venue) shaped.booking.venue = venue;
  if (invoiceNo)               shaped.booking.invoiceNo         = String(invoiceNo);
  if (monthlyAmount != null)   shaped.booking.monthlyAmount     = Number(monthlyAmount);
  if (firstMonthAmount != null)shaped.booking.firstMonthAmount  = Number(firstMonthAmount);
  if (invoiceDate)             shaped.booking.invoiceDate       = String(invoiceDate);

  return htmlRenderer.buildParticipationPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer, // <- wichtig, damit Snapshot greift
  });
}

async function buildCancellationPdf({ customer, booking, offer, date, reason } = {}) {
  assertFn('buildCancellationPdfHTML');

  const shaped = shapeCancellationData({ customer, booking, offer, date, reason });

  return htmlRenderer.buildCancellationPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,                 // <- wichtig
    date    : shaped.details.cancelDate,
    reason  : shaped.details.reason,
  });
}



async function buildStornoPdf({ customer, booking, offer, amount, currency = 'EUR' } = {}) {
  assertFn('buildStornoPdfHTML');

  const shaped = shapeStornoData({ customer, booking, offer, amount, currency });

  const effAmount =
    Number.isFinite(Number(shaped.amount)) ? Number(shaped.amount)
    : (offer && typeof offer.price === 'number' ? offer.price : 0);

  const curr = String(shaped.currency || 'EUR');

  console.log('[PDF buildStornoPdf]', {
    shapedAmount: shaped.amount,
    offerPrice: offer?.price,
    effAmount,
    currency: curr,
  });

  return htmlRenderer.buildStornoPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    amount  : effAmount,   // <- geht direkt ins Template
    currency: curr,
  });
}





module.exports = {
  bookingPdfBuffer,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
};



