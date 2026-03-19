// routes/datev/helpers/creditNoteHelpers.js
"use strict";

const {
  isInsideDateRange,
  pickStornoAmount,
  pushReadableRow,
  safeLower,
  safeText,
} = require("./datevValueHelpers");

function isCreditInvoiceRef(reference) {
  const note = safeLower(reference?.note);
  const number = safeText(reference?.number);
  const amount = Number(reference?.amount);
  if (note.includes("gutschrift")) return true;
  if (number.toUpperCase().startsWith("GS")) return true;
  return Number.isFinite(amount) && amount < 0;
}

function creditRefDateValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeCreditReference(reference) {
  const number = safeText(reference?.number);
  const amount = Math.abs(
    Number(reference?.amount || reference?.finalPrice || 0),
  );
  if (!number || !Number.isFinite(amount) || amount <= 0) return null;
  return { number, amount, date: reference?.date || null };
}

function buildMetaCreditReference(booking, offer) {
  const number = safeText(booking?.meta?.creditNoteNo);
  const amount = buildMetaCreditAmount(booking, offer);
  if (!number || !amount) return null;
  return { number, amount, date: buildMetaCreditDate(booking) };
}

function buildMetaCreditAmount(booking, offer) {
  const raw = booking?.meta?.creditNoteAmount;
  const fallback =
    booking?.priceAtBooking ?? booking?.stornoAmount ?? offer?.price;
  const amount = Math.abs(Number(raw ?? fallback ?? 0));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function buildMetaCreditDate(booking) {
  return (
    booking?.meta?.creditNoteDate ||
    booking?.returnedAt ||
    booking?.updatedAt ||
    booking?.createdAt ||
    null
  );
}

function buildInvoiceRefCredits(booking) {
  const refs = Array.isArray(booking?.invoiceRefs) ? booking.invoiceRefs : [];
  return refs
    .filter(isCreditInvoiceRef)
    .map(normalizeCreditReference)
    .filter(Boolean)
    .sort(compareCreditReferences);
}

function compareCreditReferences(left, right) {
  return creditRefDateValue(right.date) - creditRefDateValue(left.date);
}

function pickFinalCreditReference(booking, offer) {
  const metaCredit = buildMetaCreditReference(booking, offer);
  if (metaCredit) return metaCredit;
  const invoiceRefCredits = buildInvoiceRefCredits(booking);
  return invoiceRefCredits[0] || null;
}

function buildFallbackStornoReference(booking, offer) {
  const number = safeText(booking?.stornoNo || booking?.stornoNumber);
  const amount = pickStornoAmount(booking, offer);
  if (!number || !amount) return null;
  return { number, amount, date: buildFallbackStornoDate(booking) };
}

function buildFallbackStornoDate(booking) {
  return (
    booking?.stornoDate ||
    booking?.cancelDate ||
    booking?.cancellationDate ||
    booking?.invoiceDate ||
    booking?.date ||
    booking?.createdAt ||
    null
  );
}

function pushCreditRowForBooking(args) {
  const finalCredit = pickFinalCreditReference(args.booking, args.offer);
  const pushedFinal = pushSingleCreditRow({ ...args, creditRef: finalCredit });
  if (pushedFinal) return;
  const fallback = buildFallbackStornoReference(args.booking, args.offer);
  const pushedFallback = pushSingleCreditRow({ ...args, creditRef: fallback });
  if (!pushedFallback) args.stats.stornoSkip += 1;
}

function pushSingleCreditRow(args) {
  const ref = args.creditRef;
  if (!hasExportableCreditReference(ref, args.from, args.to)) return false;
  const row = buildCreditDatevRow(args, ref);
  pushReadableRow(args.readableRows, args.extfRows, row);
  incrementCreditStat(args.stats, ref, args.booking, args.offer);
  return true;
}

function hasExportableCreditReference(reference, from, to) {
  if (!reference?.number || !reference?.date) return false;
  return isInsideDateRange(reference.date, from, to);
}

function buildCreditDatevRow(args, reference) {
  return args.buildDatevRow({
    amount: reference.amount,
    currency: args.currency,
    debitAccount: args.debitAccount,
    creditAccount: args.creditAccount,
    date: reference.date,
    number: reference.number,
    text: `Gutschrift – ${args.course}`,
    reverse: true,
  });
}

function incrementCreditStat(stats, reference, booking, offer) {
  const fallback = buildFallbackStornoReference(booking, offer);
  const isFallback = fallback && fallback.number === reference?.number;
  if (isFallback) stats.stornoOk += 1;
  else stats.creditOk += 1;
}

module.exports = {
  buildFallbackStornoReference,
  buildInvoiceRefCredits,
  buildMetaCreditReference,
  isCreditInvoiceRef,
  normalizeCreditReference,
  pickFinalCreditReference,
  pushCreditRowForBooking,
};
