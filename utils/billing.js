// utils/billing.js
"use strict";

const {
  nextSequence,
  yearFrom,
  typeCodeFromOffer,
  formatNumber,
} = require("../utils/sequences");

function freezeOfferSnapshot(booking, offer) {
  if (!booking || !offer) return;

  if (!booking.offerTitle)
    booking.offerTitle = offer.title || offer.sub_type || offer.type || "";
  if (!booking.offerType)
    booking.offerType = offer.sub_type || offer.type || "";
  if (!booking.venue) booking.venue = offer.location || "";
  if (!booking.offer)
    booking.offer = booking.offerTitle || booking.offerType || "";
}

async function persistBooking(booking) {
  if (!booking) return null;

  const isSubdoc =
    booking.$isSubdocument ||
    booking.isSubdocument ||
    typeof booking.ownerDocument === "function";

  if (isSubdoc) {
    const parent = booking.ownerDocument ? booking.ownerDocument() : null;
    if (parent && typeof parent.save === "function") {
      try {
        parent.markModified(booking?.$basePath || "bookings");
      } catch (_) {
        parent.markModified("bookings");
      }
      return parent.save();
    }
    return null;
  }

  if (typeof booking.save === "function") {
    return booking.save();
  }

  return null;
}


/* ---------- Hilfsfunktionen ---------- */
function parseISODate(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function prorateForStart(startISO, monthlyPrice) {
  const d = parseISODate(startISO);
  if (
    !d ||
    typeof monthlyPrice !== "number" ||
    !Number.isFinite(monthlyPrice)
  ) {
    return {
      daysInMonth: null,
      daysRemaining: null,
      factor: null,
      firstMonthPrice: null,
    };
  }
  const y = d.getFullYear();
  const m = d.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startDay = d.getDate();
  const daysRemaining = Math.max(0, daysInMonth - startDay + 1); // inkl. Starttag
  const factor = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
  const firstMonthPrice = Math.round(monthlyPrice * factor * 100) / 100;
  return { daysInMonth, daysRemaining, factor, firstMonthPrice };
}

function nextPeriodStart(startISO) {
  const d = parseISODate(startISO);
  if (!d) return null;
  const y = d.getFullYear();
  const m = d.getMonth();
  const firstNext = new Date(y, m + 1, 1);
  const y2 = firstNext.getFullYear();
  const m2 = String(firstNext.getMonth() + 1).padStart(2, "0");
  return `${y2}-${m2}-01`;
}

function fmtAmount(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

function normCurrency(c) {
  return String(c || "EUR").toUpperCase();
}

async function assignInvoiceData({ booking, offer, providerId = "1" }) {
  const code = (offer && (offer.code || typeCodeFromOffer(offer))) || "XX";
  const year = yearFrom();
  const seq = await nextSequence(`invoice:${code}:${year}`);

  booking.invoiceNumber = formatNumber(providerId, code, year, seq);
  booking.invoiceDate = new Date();

  freezeOfferSnapshot(booking, offer);

  if (
    booking.priceAtBooking == null &&
    offer &&
    typeof offer.price === "number"
  ) {
    booking.priceAtBooking = offer.price;
  }

  await persistBooking(booking);
  return booking;
}

async function assignCancellationData({
  booking,
  providerId = "1",
  cancellationDate = new Date(),
  endDate,
}) {
  const code = "K";
  const year = yearFrom();
  const seq = await nextSequence(`cancellation:${code}:${year}`);

  // Einheitliche Feldnamen: zusätzlich cancellationNo setzen (für Templates)
  booking.cancellationNumber = formatNumber(providerId, code, year, seq);
  booking.cancellationNo = booking.cancellationNumber;

  if (!booking.cancellationDate) booking.cancellationDate = cancellationDate;

  if (!booking.cancelDate) booking.cancelDate = booking.cancellationDate; // vereinheitlicht
  if (endDate && !booking.endDate) booking.endDate = endDate;

  await persistBooking(booking);
  return booking;
}

async function assignStornoData({
  booking,
  offer,
  amount,
  providerId = "1",
  stornoDate = new Date(),
}) {
  //  const code =
  // (offer && (offer.code || typeCodeFromOfferType(offer.type))) || 'XX';
  const code = (offer && (offer.code || typeCodeFromOffer(offer))) || "XX";
  const year = yearFrom();
  const seq = await nextSequence(`storno:${code}:${year}`);

  // Einheitliche Feldnamen: zusätzlich stornoNo setzen (für Templates)
  booking.stornoNumber = formatNumber(providerId, code, year, seq);
  booking.stornoNo = booking.stornoNumber;
  booking.stornoDate = stornoDate;

  // Betrag ermitteln
  let eff;
  if (amount !== undefined && amount !== null && String(amount).trim() !== "") {
    const n = Number(amount);
    if (Number.isFinite(n)) eff = n;
  }
  if (eff === undefined && typeof booking.priceAtBooking === "number")
    eff = booking.priceAtBooking;
  if (eff === undefined && offer && typeof offer.price === "number")
    eff = offer.price;
  if (eff !== undefined) booking.stornoAmount = Math.round(eff * 100) / 100;

  await persistBooking(booking);
  return booking;
}

async function assignCreditNoteData({
  booking,
  offer,
  amount,
  providerId = "1",
  creditDate = new Date(),
}) {
  const baseCode = "CLB";
  const creditCode = `GS${baseCode}`;
  const year = yearFrom();
  const seq = await nextSequence(`creditnote:${creditCode}:${year}`);

  const meta =
    booking.meta && typeof booking.meta === "object" ? booking.meta : {};
  booking.meta = meta;

  freezeOfferSnapshot(booking, offer);

  meta.creditNoteNo = `${creditCode}/${year}/${seq}`;
  meta.creditNoteDate = creditDate.toISOString();

  const raw = amount != null ? Number(amount) : NaN;
  const eff = Number.isFinite(raw)
    ? raw
    : typeof booking.priceAtBooking === "number"
      ? booking.priceAtBooking
      : offer && typeof offer.price === "number"
        ? offer.price
        : undefined;

  if (eff !== undefined) meta.creditNoteAmount = Math.round(eff * 100) / 100;

  await persistBooking(booking);
  return booking;
}

/* ---------- Exports ---------- */
module.exports = {
  prorateForStart,
  nextPeriodStart,
  fmtAmount,
  normCurrency,
  assignInvoiceData,
  assignCancellationData,
  assignStornoData,
  assignCreditNoteData,
};
