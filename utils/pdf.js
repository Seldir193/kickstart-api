'use strict';

require('dotenv').config();

// const { isSubscriptionOffer } = require('./offerKind');

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
 * Hilfsfunktion: ermittelt, ob ein Angebot ein wöchentliches Abo ist.
 * „Weekly“ bleibt wie bisher; alle anderen (Holiday/Individual/Club) sind Non-Weekly.
 */
function computeIsWeekly(offer) {
  if (!offer) return false;
  if (String(offer.category || '') === 'Weekly') return true;

  // Fallbacks (Bestand)
  const t = String(offer.type || '');
  if (t === 'Foerdertraining' || t === 'Kindergarten') return true;

  // explizit keine Abos:
  const sub = String(offer.sub_type || '').toLowerCase();
  if (sub === 'powertraining') return false;       // Holiday Program
  if (t === 'PersonalTraining') return false;      // Individual

  return false;
}











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

  // Basis-Shaping aus pdfData.js
  const shaped = shapeParticipationData({ customer, booking, offer });

  // ------------------------------------------------------------------
  // Kontexte aufbereiten: isWeekly + Pricing/Invoice-Fallbacks
  // ------------------------------------------------------------------
  const isWeekly = computeIsWeekly(offer);

  shaped.invoice  = shaped.invoice  || {};
  shaped.pricing  = shaped.pricing  || {};
  shaped.customer = shaped.customer || {};
  shaped.booking  = shaped.booking  || {};

  // Currency Default
  const CURRENCY = String(shaped.invoice.currency || shaped.pricing.currency || 'EUR');
  shaped.invoice.currency = CURRENCY;
  shaped.pricing.currency = CURRENCY;

  // Optionale Werte aus Funktionsparametern in den Booking/Invoice-Kontext spiegeln
  if (venue && !shaped.booking.venue) shaped.booking.venue = venue;
  if (invoiceNo) shaped.booking.invoiceNo = normalizeInvoiceNo(invoiceNo);
  if (invoiceDate) shaped.booking.invoiceDate = String(invoiceDate);
  if (monthlyAmount != null) shaped.booking.monthlyAmount = Number(monthlyAmount);
  if (firstMonthAmount != null) shaped.booking.firstMonthAmount = Number(firstMonthAmount);

  // Kurstag & Zeit (Fallbacks aus Roh-Booking)
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

  const offerPrice = (offer && typeof offer.price === 'number') ? offer.price : undefined;

  // ===================== WEEKLY (Abo) =====================
  if (isWeekly) {
    // Standard Monatsgebühr
    const monthly =
      (Number.isFinite(Number(shaped.booking.monthlyAmount)) ? Number(shaped.booking.monthlyAmount) : undefined) ??
      (Number.isFinite(Number(shaped.invoice.monthly)) ? Number(shaped.invoice.monthly) : undefined) ??
      (Number.isFinite(Number(offerPrice)) ? Number(offerPrice) : undefined);

    if (monthly != null) {
      shaped.invoice.monthly = monthly;
      shaped.pricing.monthly = monthly;
    }

    // Erster Monat
    const firstMonth =
      (Number.isFinite(Number(shaped.booking.firstMonthAmount)) ? Number(shaped.booking.firstMonthAmount) : undefined) ??
      (Number.isFinite(Number(shaped.invoice.firstMonth)) ? Number(shaped.invoice.firstMonth) : undefined) ??
      (Number.isFinite(Number(shaped.pricing.firstMonth)) ? Number(shaped.pricing.firstMonth) : undefined);

    if (firstMonth != null) {
      shaped.invoice.firstMonth = firstMonth;
      shaped.pricing.firstMonth = firstMonth;
    }

    // Non-relevante Einmalfelder leeren
    delete shaped.invoice.oneOff;
    delete shaped.pricing.oneOff;
  } else {
    // ===================== NON-WEEKLY (Camp / Holiday / etc) =====================

    // Rabatte aus booking.meta ziehen
    const meta = booking && typeof booking.meta === 'object' ? booking.meta : {};

    const basePriceFromMeta =
      typeof meta.basePrice === 'number'
        ? meta.basePrice
        : (typeof offerPrice === 'number' ? offerPrice : undefined);

    const siblingDiscount =
      typeof meta.siblingDiscount === 'number'
        ? meta.siblingDiscount
        : Number(meta.siblingDiscount) || 0;

    const memberDiscount =
      typeof meta.memberDiscount === 'number'
        ? meta.memberDiscount
        : Number(meta.memberDiscount) || 0;

    const totalDiscountFromMeta =
      typeof meta.totalDiscount === 'number'
        ? meta.totalDiscount
        : siblingDiscount + memberDiscount;

    const basePrice = basePriceFromMeta ?? (Number.isFinite(Number(shaped.booking.priceAtBooking))
      ? Number(shaped.booking.priceAtBooking)
      : undefined);

    const totalDiscount =
      totalDiscountFromMeta != null
        ? totalDiscountFromMeta
        : (siblingDiscount + memberDiscount);

    const finalPrice =
      Number.isFinite(Number(booking?.priceAtBooking))
        ? Number(booking.priceAtBooking) // hier steht schon dein rabattierter Preis
        : (basePrice != null
            ? Math.max(0, basePrice - totalDiscount)
            : undefined);

    // für Template den Rabatt-Block bereitstellen
    shaped.booking.discount = {
      basePrice:      basePrice ?? null,
      siblingDiscount,
      memberDiscount,
      totalDiscount,
      finalPrice:     finalPrice ?? basePrice ?? null,
    };

    // Einmalpreis, der in der Rechnung landet (invoice.single / pricing.single)
    const oneOff =
      (Number.isFinite(Number(finalPrice)) ? Number(finalPrice) : undefined) ??
      (Number.isFinite(Number(shaped.booking.priceAtBooking)) ? Number(shaped.booking.priceAtBooking) : undefined) ??
      (Number.isFinite(Number(shaped.invoice.oneOff)) ? Number(shaped.invoice.oneOff) : undefined) ??
      (Number.isFinite(Number(offerPrice)) ? Number(offerPrice) : undefined) ??
      // letzter Fallback: falls nur monthly benutzt wurde
      (Number.isFinite(Number(shaped.invoice.monthly)) ? Number(shaped.invoice.monthly) : undefined) ??
      (Number.isFinite(Number(shaped.invoice.monthlyAmount)) ? Number(shaped.invoice.monthlyAmount) : undefined) ??
      (Number.isFinite(Number(shaped.pricing.monthly)) ? Number(shaped.pricing.monthly) : undefined);

    if (oneOff != null) {
      shaped.invoice.single = oneOff;
      shaped.pricing.single = oneOff;
    }

    // Monatsfelder sind für Non-Weekly nicht relevant
    delete shaped.pricing.firstMonth;
    delete shaped.invoice.firstMonth;
  }

  // Flag ins Booking UND Top-Level
  shaped.booking.isWeekly = isWeekly;
  shaped.isWeekly = isWeekly;



    // Flag ins Booking UND Top-Level
  shaped.booking.isWeekly = isWeekly;
  shaped.isWeekly = isWeekly;

  // 🔍 DEBUG: Was geht wirklich ins HTML rein?
  console.log('[PDF DEBUG] isWeekly:', isWeekly);
  console.log('[PDF DEBUG] booking.id:', shaped.booking._id || booking?._id);
  console.log('[PDF DEBUG] booking.meta:', booking && booking.meta);
  console.log('[PDF DEBUG] booking.priceAtBooking:', booking && booking.priceAtBooking);
  console.log('[PDF DEBUG] shaped.booking.discount:', shaped.booking.discount);
  console.log('[PDF DEBUG] shaped.invoice:', shaped.invoice);
  console.log('[PDF DEBUG] shaped.pricing:', shaped.pricing);

  // ------------------------------------------------------------------
  // → Renderer
  // ------------------------------------------------------------------
  return htmlRenderer.buildParticipationPdfHTML({
    customer: shaped.customer,
    booking : shaped.booking,
    offer,
    // Zusatzfelder/Kompatibilität
    invoiceNo,
    invoiceDate,
    monthlyAmount,
    firstMonthAmount,
    venue,
    // neue Kontexte für Template
    isWeekly,
    pricing: shaped.pricing,
    invoice: shaped.invoice,
  });
}




/* ==================== Cancellation PDF ==================== */

async function buildCancellationPdf({
  customer,
  booking,
  offer,
  date,
  endDate,
  reason,
  cancellationNo,
  refInvoiceNo,
  refInvoiceDate,
  referenceInvoice,
} = {}) {
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

  // Spiegeln, damit Template einfache Zugriffe hat
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

/* ====================== Storno PDF ======================= */

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

/* ------------------------------------------------------------------ */
/* Exporte                                                             */
/* ------------------------------------------------------------------ */
module.exports = {
  bookingPdfBuffer,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
};




