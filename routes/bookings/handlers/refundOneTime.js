// routes/bookings/handlers/refundOneTime.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const { resolveOwner } = require("../helpers/owner");
const { stripeClient } = require("../../payments/stripe/lib/stripeClient");
const { createCreditNoteForBooking } = require("../../../utils/creditNotes");

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

function within14DaysFromBooking(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
  const base =
    parseIso(meta.contractSignedAt) ||
    (booking?.paidAt ? new Date(booking.paidAt) : null) ||
    (booking?.createdAt ? new Date(booking.createdAt) : null);

  if (!base) return false;
  const diff = Date.now() - base.getTime();
  return diff >= 0 && diff <= 14 * 24 * 60 * 60 * 1000;
}

function refundAmountFromBooking(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
  const a =
    meta.creditNoteAmount != null
      ? Number(meta.creditNoteAmount)
      : booking?.priceAtBooking != null
        ? Number(booking.priceAtBooking)
        : null;
  if (!Number.isFinite(a)) return null;
  return Math.abs(Math.round(a * 100) / 100);
}

async function inferRefundPaymentIntentFromSubscription(stripe, subId) {
  if (!subId) return "";
  try {
    const inv = await stripe.invoices.list({ subscription: subId, limit: 1 });
    const invoiceId = safeText(inv?.data?.[0]?.id);
    if (!invoiceId) return "";

    const pays = await stripe.invoicePayments.list({
      invoice: invoiceId,
      limit: 1,
    });

    const p0 = pays?.data?.[0] || null;
    const pi1 = safeText(p0?.payment?.payment_intent);
    const pi2 = safeText(p0?.payment?.payment_intent?.id);
    return pi1 || pi2 || "";
  } catch (_) {
    return "";
  }
}

async function refundOneTime(req, res) {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
    }

    const id = safeText(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking)
      return res.status(404).json({ ok: false, error: "Not found" });

    const meta = ensureMeta(booking);
    const reason = safeText(req.body?.reason) || "Refund";

    if (booking.paymentStatus === "returned" || booking.returnedAt) {
      if (!safeText(meta.creditNoteEmailSentAt)) {
        const amt =
          refundAmountFromBooking(booking) != null
            ? refundAmountFromBooking(booking)
            : booking.priceAtBooking != null
              ? booking.priceAtBooking
              : 0;

        await createCreditNoteForBooking({
          ownerId: String(ownerId),
          offer: null,
          booking,
          amount: amt,
          reason: safeText(meta.refundReason) || reason,
        });
      }

      return res.json({
        ok: true,
        already: true,
        refundId: meta.stripeRefundId || null,
        creditNoteNo: meta.creditNoteNo || null,
        creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
      });
    }

    const hasPaidAt = Boolean(booking.paidAt);
    const isPaid = booking.paymentStatus === "paid" || hasPaidAt;

    if (!isPaid) {
      return res.status(409).json({ ok: false, error: "Booking not paid" });
    }

    if (safeText(meta.stripeRefundId)) {
      return res.json({
        ok: true,
        already: true,
        refundId: meta.stripeRefundId,
        creditNoteNo: meta.creditNoteNo || null,
        creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
      });
    }

    const stripe = stripeClient();

    const mode = safeText(booking?.stripe?.mode);
    const subId = safeText(booking?.stripe?.subscriptionId);

    if (mode === "subscription") {
      if (!within14DaysFromBooking(booking)) {
        return res.status(409).json({ ok: false, error: "Not within 14 days" });
      }
      if (!subId) {
        return res
          .status(409)
          .json({ ok: false, error: "Missing subscriptionId" });
      }
    }

    let pi = safeText(booking?.stripe?.paymentIntentId);

    if (!pi && mode === "subscription" && subId) {
      pi = await inferRefundPaymentIntentFromSubscription(stripe, subId);
      if (pi) {
        booking.stripe = booking.stripe || {};
        booking.stripe.paymentIntentId = pi;
      }
    }

    if (!pi) {
      return res
        .status(409)
        .json({ ok: false, error: "Missing paymentIntentId" });
    }

    const refund = await stripe.refunds.create({ payment_intent: pi });

    meta.stripeRefundId = refund.id;
    meta.refundReason = reason;

    booking.paymentStatus = "returned";
    booking.returnedAt = new Date();
    booking.returnNote = reason;

    const refundAmount = refundAmountFromBooking(booking);
    if (refundAmount != null) meta.creditNoteAmount = refundAmount;

    booking.markModified("meta");
    await booking.save();

    const amt =
      refundAmount != null
        ? refundAmount
        : booking.priceAtBooking != null
          ? booking.priceAtBooking
          : 0;

    await createCreditNoteForBooking({
      ownerId: String(ownerId),
      offer: null,
      booking,
      amount: amt,
      reason,
    });

    return res.json({
      ok: true,
      refundId: refund.id,
      creditNoteNo: meta.creditNoteNo || null,
      creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
    });
  } catch (err) {
    console.error("[bookings:refund-one-time] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { refundOneTime };
