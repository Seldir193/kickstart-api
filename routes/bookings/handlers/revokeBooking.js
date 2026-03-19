"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");
const Customer = require("../../../models/Customer");
const { stripeClient } = require("../../payments/stripe/lib/stripeClient");
const { createCreditNoteForBooking } = require("../../../utils/creditNotes");
const { buildStornoPdf } = require("../../../utils/pdf");
const { sendStornoEmail } = require("../../../utils/mailer");

function safeText(v) {
  return String(v ?? "").trim();
}

function ensureMeta(booking) {
  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
  return booking.meta;
}

function parseIso(v) {
  const s = safeText(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function within14Days(booking) {
  const meta = ensureMeta(booking);
  const base =
    parseIso(meta.contractSignedAt) ||
    (booking?.paidAt ? new Date(booking.paidAt) : null) ||
    (booking?.createdAt ? new Date(booking.createdAt) : null);

  if (!base) return false;

  const diff = Date.now() - base.getTime();
  return diff >= 0 && diff <= 14 * 24 * 60 * 60 * 1000;
}

function isWeeklyOffer(offer) {
  const category = safeText(offer?.category);
  const type = safeText(offer?.type);
  return (
    category === "Weekly" ||
    type === "Foerdertraining" ||
    type === "Kindergarten"
  );
}

function isPaidBooking(booking) {
  return booking?.paymentStatus === "paid" || !!booking?.paidAt;
}

function refundAmountFromBooking(booking) {
  const meta = ensureMeta(booking);
  const amount =
    meta.creditNoteAmount != null
      ? Number(meta.creditNoteAmount)
      : booking?.priceAtBooking != null
        ? Number(booking.priceAtBooking)
        : null;

  if (!Number.isFinite(amount)) return null;
  return Math.abs(Math.round(amount * 100) / 100);
}

function buildStornoNo() {
  const stamp = Date.now().toString().slice(-8);
  return `STORNO-${stamp}`;
}

async function inferRefundPaymentIntentFromSubscription(stripe, subId) {
  if (!subId) return "";

  try {
    const invoices = await stripe.invoices.list({
      subscription: subId,
      limit: 1,
    });

    const invoiceId = safeText(invoices?.data?.[0]?.id);
    if (!invoiceId) return "";

    const payments = await stripe.invoicePayments.list({
      invoice: invoiceId,
      limit: 1,
    });

    const first = payments?.data?.[0] || null;
    const pi1 = safeText(first?.payment?.payment_intent);
    const pi2 = safeText(first?.payment?.payment_intent?.id);
    return pi1 || pi2 || "";
  } catch (_) {
    return "";
  }
}

async function findCustomerForBooking(ownerId, booking) {
  const byRef = await Customer.findOne({
    owner: ownerId,
    "bookings.bookingId": booking._id,
  });

  if (byRef) return byRef;

  const email = safeText(booking?.invoiceTo?.parent?.email || booking?.email);
  if (!email) return null;

  return Customer.findOne({
    owner: ownerId,
    $or: [
      { "parent.email": email },
      { email },
      { emailLower: email.toLowerCase() },
    ],
  });
}

function findCustomerBookingRef(customer, bookingId) {
  const bySubId = customer.bookings?.id
    ? customer.bookings.id(bookingId)
    : null;
  if (bySubId) return bySubId;

  const id = safeText(bookingId);
  return customer.bookings?.find((b) => safeText(b?.bookingId) === id) || null;
}

async function loadOffer(ownerId, offerId) {
  if (!mongoose.isValidObjectId(safeText(offerId))) return null;
  return Offer.findOne({ _id: offerId, owner: ownerId }).lean();
}

async function markUnpaidRevocation({ ownerId, booking, customer, reason }) {
  const ref = findCustomerBookingRef(customer, booking._id);
  if (!ref) {
    throw new Error("BOOKING_REF_NOT_FOUND");
  }

  const stornoNo = safeText(ref.stornoNo) || buildStornoNo();
  const stornoDate = new Date();

  ref.status = "cancelled";
  ref.stornoNo = stornoNo;
  ref.stornoDate = stornoDate;
  ref.stornoReason = reason;

  await customer.save();

  booking.status = "storno";
  booking.stornoNo = stornoNo;
  booking.stornoDate = stornoDate;
  booking.returnNote = reason;
  await booking.save();

  const offer = await loadOffer(ownerId, booking.offerId);

  const pdfBuffer = await buildStornoPdf({
    customer,
    booking,
    offer,
    amount: null,
    currency: safeText(booking.currency || "EUR") || "EUR",
    stornoNo,
    refInvoiceNo: booking.invoiceNo || booking.invoiceNumber || "",
    refInvoiceDate: booking.invoiceDate || null,
  });

  const to =
    safeText(customer?.parent?.email) ||
    safeText(booking?.invoiceTo?.parent?.email) ||
    safeText(booking?.email);

  if (to) {
    await sendStornoEmail({
      to,
      customer: customer.toObject ? customer.toObject() : customer,
      booking,
      offer,
      pdfBuffer,
      amount: null,
      currency: safeText(booking.currency || "EUR") || "EUR",
    });
  }

  return {
    ok: true,
    mode: "unpaid_storno",
    stornoNo,
  };
}

async function markPaidRevocation({ booking, reason, isWeekly }) {
  const stripe = stripeClient();
  const meta = ensureMeta(booking);

  if (booking.paymentStatus === "returned" || booking.returnedAt) {
    return {
      ok: true,
      already: true,
      mode: isWeekly ? "weekly_refund" : "one_time_refund",
      refundId: meta.stripeRefundId || null,
      creditNoteNo: meta.creditNoteNo || null,
    };
  }

  const subId = safeText(booking?.stripe?.subscriptionId);
  let pi = safeText(booking?.stripe?.paymentIntentId);

  if (isWeekly && subId && !safeText(meta.weeklyWithdrawCancelledAt)) {
    await stripe.subscriptions.cancel(subId);
    meta.weeklyWithdrawCancelledAt = new Date().toISOString();
  }

  if (!pi && isWeekly && subId) {
    pi = await inferRefundPaymentIntentFromSubscription(stripe, subId);
    if (pi) {
      booking.stripe = booking.stripe || {};
      booking.stripe.paymentIntentId = pi;
    }
  }

  if (!pi) {
    throw new Error("MISSING_PAYMENT_INTENT");
  }

  if (!safeText(meta.stripeRefundId)) {
    const refund = await stripe.refunds.create({ payment_intent: pi });
    meta.stripeRefundId = refund.id;
  }

  booking.paymentStatus = "returned";
  booking.returnedAt = new Date();
  booking.returnNote = reason;

  const amount = refundAmountFromBooking(booking);
  if (amount != null) meta.creditNoteAmount = amount;

  booking.markModified("meta");
  await booking.save();

  await createCreditNoteForBooking({
    ownerId: String(booking.owner),
    offer: null,
    booking,
    amount:
      amount != null
        ? amount
        : booking.priceAtBooking != null
          ? booking.priceAtBooking
          : 0,
    reason,
  });

  return {
    ok: true,
    mode: isWeekly ? "weekly_refund" : "one_time_refund",
    refundId: meta.stripeRefundId || null,
    creditNoteNo: meta.creditNoteNo || null,
    creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
  };
}

async function revokeBooking(req, res) {
  try {
    const id = safeText(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid booking id" });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    if (!within14Days(booking)) {
      return res.status(409).json({
        ok: false,
        error: "Widerruf nicht mehr möglich (mehr als 14 Tage).",
      });
    }

    const offer = await loadOffer(booking.owner, booking.offerId);
    const isWeekly = isWeeklyOffer(offer);
    const reason = safeText(req.body?.reason) || "Widerruf (≤14 Tage)";
    const paid = isPaidBooking(booking);

    const customer = await findCustomerForBooking(booking.owner, booking);
    if (!customer) {
      return res.status(404).json({
        ok: false,
        error: "Customer not found for booking",
      });
    }

    if (!paid) {
      const result = await markUnpaidRevocation({
        ownerId: booking.owner,
        booking,
        customer,
        reason,
      });

      return res.json(result);
    }

    const result = await markPaidRevocation({
      booking,
      reason,
      isWeekly,
    });

    return res.json(result);
  } catch (err) {
    const msg = safeText(err?.message);

    if (msg === "MISSING_PAYMENT_INTENT") {
      return res.status(409).json({
        ok: false,
        error: "Missing paymentIntentId",
      });
    }

    if (msg === "BOOKING_REF_NOT_FOUND") {
      return res.status(404).json({
        ok: false,
        error: "Booking reference not found on customer",
      });
    }

    console.error("[bookings:revoke] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { revokeBooking };
