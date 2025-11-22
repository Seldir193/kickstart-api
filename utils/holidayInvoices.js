// utils/holidayInvoices.js
'use strict';

const Customer = require('../models/Customer');
const Booking  = require('../models/Booking');

const { buildParticipationPdf }   = require('./pdf');
const { sendParticipationEmail }  = require('./mailer');
const { normalizeInvoiceNo }      = require('./pdfData');

async function createHolidayInvoiceForBooking({ ownerId, offer, booking }) {
  if (!ownerId || !booking) {
    console.warn('[holidayInvoice] missing ownerId or booking');
    return;
  }

  // 1) Customer zu dieser Booking-Ref holen
  const customer = await Customer.findOne({
    owner: ownerId,
    'bookings.bookingId': booking._id,
  });

  if (!customer) {
    console.warn('[holidayInvoice] no customer found for booking', String(booking._id));
    return;
  }

  // 2) passende Booking-Ref im Customer





    let ref = customer.bookings.find(
    (b) => String(b.bookingId) === String(booking._id)
  );

  // Falls noch kein Booking-Ref existiert → hier nachziehen
  if (!ref) {
    const bookingDate =
      booking.date ? new Date(booking.date) : booking.createdAt || new Date();

    const venue =
      typeof offer?.location === 'string'
        ? offer.location
        : offer?.location?.name || offer?.location?.title || '';

    customer.bookings.push({
      bookingId:   booking._id,
      offerId:     offer?._id || booking.offerId,
      offerTitle:  offer?.title || offer?.sub_type || offer?.type || booking.offerTitle || '',
      offerType:   offer?.sub_type || offer?.type || booking.offerType || '',
      venue,
      date:        isNaN(bookingDate.getTime()) ? null : bookingDate,
      status:      'active',
      priceAtBooking:
        typeof booking.priceAtBooking === 'number'
          ? booking.priceAtBooking
          : typeof offer?.price === 'number'
            ? offer.price
            : null,
    });

    ref = customer.bookings[customer.bookings.length - 1];
  }







  // 3) Preis bestimmen (Einmalpreis = aktueller Offer-Preis, Fallback: booking.priceAtBooking)
  const amount =
    typeof offer?.price === 'number'
      ? offer.price
      : typeof booking.priceAtBooking === 'number'
      ? booking.priceAtBooking
      : null;

  // 4) Rechnungsnummer erzeugen (PW-25-0029 / CA-25-0016)
  const now       = new Date();
  const yearShort = String(now.getFullYear()).slice(-2); // "25" für 2025

  // Erkennen, ob Powertraining oder Camp anhand von Offer/Booking-Text
  const textForType = [
    offer?.title,
    offer?.sub_type,
    offer?.type,
    booking.offerTitle,
    booking.offerType,
    booking.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const isPowertraining =
    textForType.includes('powertraining') ||
    textForType.includes('power training');

  const isCamp =
    textForType.includes('camp') ||
    textForType.includes('feriencamp') ||
    textForType.includes('holiday camp');

  // Prefix wie intern:
  //  - Powertraining → PW
  //  - Camp (Default) → CA
  let prefix = 'CA';
  if (isPowertraining) prefix = 'PW';
  else if (isCamp)     prefix = 'CA';

  let rawNo =
    booking.invoiceNumber ||
    booking.invoiceNo;

  if (!rawNo) {
    // Letzte vorhandene Rechnungsnummer für diesen Owner + Prefix + Jahr finden
    const prefixPattern = `${prefix}-${yearShort}-`; // z.B. "PW-25-"

    const last = await Booking.findOne({
      owner: ownerId,
      $or: [
        { invoiceNumber: { $regex: `^${prefixPattern}\\d{4}$` } },
        { invoiceNo:     { $regex: `^${prefixPattern}\\d{4}$` } },
      ],
    })
      .sort({ invoiceDate: -1, createdAt: -1 })
      .lean();

    let nextSeq = 1;
    if (last) {
      const candidate = last.invoiceNumber || last.invoiceNo || '';
      const m = candidate.match(/-(\d{4})$/);
      if (m) {
        const num = parseInt(m[1], 10);
        if (Number.isFinite(num)) nextSeq = num + 1;
      }
    }

    const seqStr = String(nextSeq).padStart(4, '0'); // "0029"
    rawNo = `${prefix}-${yearShort}-${seqStr}`;       // z.B. "PW-25-0029" / "CA-25-0016"
  }

  const invoiceNo   = normalizeInvoiceNo(rawNo);
  const invoiceDate = booking.invoiceDate || now;



  // 5) Booking-Snapshot aktualisieren
  booking.invoiceNumber  = invoiceNo;
  booking.invoiceNo      = invoiceNo;
  booking.invoiceDate    = invoiceDate;
  booking.priceAtBooking = amount != null ? amount : booking.priceAtBooking;
  booking.currency       = booking.currency || 'EUR';
  booking.offerTitle     =
    booking.offerTitle ||
    offer?.title ||
    offer?.sub_type ||
    offer?.type ||
    '';
  booking.offerType      =
    booking.offerType ||
    offer?.sub_type ||
    offer?.type ||
    '';
  booking.venue          =
    booking.venue ||
    offer?.location ||
    '';

  await booking.save();

  // 6) Snapshot auch im Customer-BookingRef aktualisieren
  if (ref) {
    ref.invoiceNumber  = ref.invoiceNumber || invoiceNo;
    ref.invoiceNo      = ref.invoiceNo || invoiceNo;
    ref.invoiceDate    = ref.invoiceDate || invoiceDate;
    ref.priceAtBooking = amount != null ? amount : ref.priceAtBooking;
    ref.currency       = ref.currency || 'EUR';
    ref.offerTitle     =
      ref.offerTitle ||
      offer?.title ||
      offer?.sub_type ||
      booking.offerTitle ||
      '';
    ref.offerType      =
      ref.offerType ||
      offer?.sub_type ||
      offer?.type ||
      booking.offerType ||
      '';
    ref.venue          =
      ref.venue ||
      offer?.location ||
      booking.venue ||
      '';

    // optionale Referenzliste der Rechnungen am BookingRef
    if (!Array.isArray(ref.invoiceRefs)) ref.invoiceRefs = [];
    const hasRef = ref.invoiceRefs.some((r) => r.number === invoiceNo);
    if (!hasRef) {
      ref.invoiceRefs.push({
        number: invoiceNo,
        date: invoiceDate,
        amount: amount != null ? amount : null,
        note: 'Holiday-Programm (Camp/Powertraining)',
      });
    }

    await customer.save();
  }

  // 7) PDF (Teilnahme + Rechnung in einem) erzeugen
  let pdfBuffer = null;
  try {
    pdfBuffer = await buildParticipationPdf({
      customer,
      booking,
      offer,
      invoiceNo,
      invoiceDate,
      monthlyAmount: null,   // Holiday = Non-Weekly → einmaliger Betrag
      firstMonthAmount: null,
      venue: booking.venue || offer?.location || '',
    });
  } catch (e) {
    console.error('[holidayInvoice] buildParticipationPdf failed:', e?.message || e);
  }

  // 8) Teilnahme-Email mit angehängter Rechnung verschicken
  try {
    await sendParticipationEmail({
      to: booking.email,
      customer,
      booking,
      offer,
      pdfBuffer, // sendParticipationEmail kümmert sich um den Rest
    });
  } catch (e) {
    console.error('[holidayInvoice] sendParticipationEmail failed:', e?.message || e);
  }
}

module.exports = {
  createHolidayInvoiceForBooking,
};






