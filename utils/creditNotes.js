//utils\creditNotes.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const { buildParticipationPdf } = require("./pdf");
const { assignCreditNoteData } = require("./billing");
const { sendCreditNoteEmail } = require("./mailer");

function safeText(v) {
  return String(v ?? "").trim();
}

function pickFirst(...vals) {
  for (const v of vals) {
    const s = safeText(v);
    if (s) return s;
  }
  return "";
}

function bookingRecipientEmail(booking, customer) {
  return pickFirst(
    booking?.invoiceTo?.parent?.email,
    booking?.email,
    customer?.parent?.email,
    customer?.email,
  ).toLowerCase();
}

function bookingCustomerSnapshot(customer, booking, recipientEmail) {
  const bookingParent = booking?.invoiceTo?.parent || {};
  const customerParent = customer?.parent || {};

  return {
    ...customer,
    parent: {
      salutation: pickFirst(
        bookingParent?.salutation,
        customerParent?.salutation,
      ),
      firstName: pickFirst(bookingParent?.firstName, customerParent?.firstName),
      lastName: pickFirst(bookingParent?.lastName, customerParent?.lastName),
      email: recipientEmail,
      phone: pickFirst(bookingParent?.phone, customerParent?.phone),
      phone2: pickFirst(bookingParent?.phone2, customerParent?.phone2),
    },
    email: recipientEmail,
    emailLower: recipientEmail,
  };
}

async function findCustomerByBooking(ownerId, booking) {
  const owner = safeText(ownerId);
  const bookingId = safeText(booking?._id);

  const cid = safeText(booking?.customerId);
  if (cid && mongoose.isValidObjectId(cid)) {
    const byId = await Customer.findOne({ owner, _id: cid });
    if (byId) return byId;
  }

  if (bookingId && mongoose.isValidObjectId(bookingId)) {
    return Customer.findOne({ owner, "bookings.bookingId": bookingId });
  }

  return null;
}

function resolveVenue(offer) {
  if (typeof offer?.location === "string") return offer.location;
  return offer?.location?.name || offer?.location?.title || "";
}

function ensureCustomerBookingRef(customer, offer, booking) {
  const id = String(booking?._id || "");
  let ref = customer.bookings.find((b) => String(b.bookingId) === id);
  if (ref) return ref;

  customer.bookings.push({
    bookingId: booking._id,
    offerId: offer?._id || booking.offerId,
    offerTitle:
      offer?.title ||
      offer?.sub_type ||
      offer?.type ||
      booking.offerTitle ||
      "",
    offerType: offer?.sub_type || offer?.type || booking.offerType || "",
    venue: resolveVenue(offer),
    date: booking?.date
      ? new Date(booking.date)
      : booking?.createdAt || new Date(),
    status: "active",
    priceAtBooking:
      typeof booking.priceAtBooking === "number"
        ? booking.priceAtBooking
        : typeof offer?.price === "number"
          ? offer.price
          : null,
  });

  return customer.bookings[customer.bookings.length - 1];
}

function pushCreditRef(ref, creditNo, creditDate, amountNeg) {
  if (!Array.isArray(ref.invoiceRefs)) ref.invoiceRefs = [];
  if (ref.invoiceRefs.some((r) => r.number === creditNo)) return;

  ref.invoiceRefs.push({
    number: creditNo,
    date: creditDate,
    amount: amountNeg,
    finalPrice: amountNeg,
    note: "Gutschrift",
  });
}

function ensureMeta(booking) {
  booking.meta =
    booking.meta && typeof booking.meta === "object" ? booking.meta : {};
  return booking.meta;
}

function resolveCreditAmount(booking, offer, meta) {
  const eff =
    typeof meta.creditNoteAmount === "number"
      ? Number(meta.creditNoteAmount)
      : typeof booking.priceAtBooking === "number"
        ? Number(booking.priceAtBooking)
        : typeof offer?.price === "number"
          ? Number(offer.price)
          : 0;

  return {
    abs: Math.abs(eff),
    neg: -Math.abs(eff),
    absForMail: Math.abs(eff),
  };
}

async function ensureCreditNoteExists({ ownerId, offer, booking, amount }) {
  const meta = ensureMeta(booking);

  const hasNo = safeText(meta.creditNoteNo);
  const hasCreated = safeText(meta.creditNoteCreatedAt);

  if (hasNo) {
    if (!hasCreated) {
      meta.creditNoteCreatedAt = new Date().toISOString();
      booking.markModified("meta");
      await booking.save();
    }
    return;
  }

  const providerId = "1";
  await assignCreditNoteData({ booking, offer, amount, providerId });

  meta.creditNoteCreatedAt = new Date().toISOString();
  booking.markModified("meta");
  await booking.save();
}

async function createCreditNoteForBooking({
  ownerId,
  offer,
  booking,
  amount,
  reason,
}) {
  if (!ownerId || !booking) return;

  const customer = await findCustomerByBooking(ownerId, booking);
  if (!customer) return;

  const meta = ensureMeta(booking);

  await ensureCreditNoteExists({ ownerId, offer, booking, amount });

  if (reason) meta.creditNoteReason = safeText(reason);

  const creditNo = safeText(meta.creditNoteNo);
  if (!creditNo) return;

  const creditDate = meta.creditNoteDate
    ? new Date(meta.creditNoteDate)
    : new Date();

  const { abs, neg, absForMail } = resolveCreditAmount(booking, offer, meta);

  const ref = ensureCustomerBookingRef(customer, offer, booking);
  pushCreditRef(ref, creditNo, creditDate, neg);

  await customer.save();

  const bookingForPdf = {
    ...(booking.toObject ? booking.toObject() : booking),
    priceAtBooking: neg,
  };

  const to = bookingRecipientEmail(booking, customer);
  const effectiveCustomer = bookingCustomerSnapshot(customer, booking, to);

  const pdfBuffer = await buildParticipationPdf({
    customer: effectiveCustomer,
    booking: bookingForPdf,
    offer,
    invoiceNo: creditNo,
    invoiceDate: creditDate.toISOString(),
    venue: booking?.venue || offer?.location || "",
  });

  await sendCreditNoteEmail({
    to,
    customer: effectiveCustomer,
    booking,
    offer,
    creditNo,
    creditDate,
    amount: absForMail,
    pdfBuffer,
    reason: meta.creditNoteReason,
  });

  // const to = pickFirst(
  //   customer?.parent?.email,
  //   customer?.email,
  //   booking?.invoiceTo?.parent?.email,
  //   booking?.email,
  // ).toLowerCase();

  // const pdfBuffer = await buildParticipationPdf({
  //   customer,
  //   booking: bookingForPdf,
  //   offer,
  //   invoiceNo: creditNo,
  //   invoiceDate: creditDate.toISOString(),
  //   venue: booking?.venue || offer?.location || "",
  // });

  // await sendCreditNoteEmail({
  //   to,
  //   customer,
  //   booking,
  //   offer,
  //   creditNo,
  //   creditDate,
  //   amount: absForMail,
  //   pdfBuffer,
  //   reason: meta.creditNoteReason,
  // });

  meta.creditNoteEmailSentAt = new Date().toISOString();
  booking.markModified("meta");
  await booking.save();
}

module.exports = { createCreditNoteForBooking };
