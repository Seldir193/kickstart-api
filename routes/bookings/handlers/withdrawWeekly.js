// routes/bookings/handlers/withdrawWeekly.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const { resolveOwner } = require("../helpers/owner");
const { stripeClient } = require("../../payments/stripe/lib/stripeClient");
const { createCreditNoteForBooking } = require("../../../utils/creditNotes");

const Customer = require("../../../models/Customer");
const { buildCancellationPdf } = require("../../../utils/pdf");
const { sendCancellationEmail } = require("../../../utils/mailer");

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

function bookingRecipientEmail(booking, customer) {
  return (
    safeText(booking?.invoiceTo?.parent?.email) ||
    safeText(booking?.email) ||
    safeText(customer?.parent?.email) ||
    safeText(customer?.email)
  ).toLowerCase();
}

function bookingCustomerSnapshot(customer, booking, recipientEmail) {
  const bookingParent = booking?.invoiceTo?.parent || {};
  const customerParent = customer?.parent || {};

  return {
    ...customer,
    parent: {
      salutation:
        safeText(bookingParent?.salutation) ||
        safeText(customerParent?.salutation),
      firstName:
        safeText(bookingParent?.firstName) ||
        safeText(customerParent?.firstName),
      lastName:
        safeText(bookingParent?.lastName) || safeText(customerParent?.lastName),
      email: recipientEmail,
      phone: safeText(bookingParent?.phone) || safeText(customerParent?.phone),
      phone2:
        safeText(bookingParent?.phone2) || safeText(customerParent?.phone2),
    },
    email: recipientEmail,
    emailLower: recipientEmail,
  };
}

async function findCustomerByBooking(ownerId, booking) {
  const byCustomerId = safeText(booking?.customerId);
  if (byCustomerId && mongoose.isValidObjectId(byCustomerId)) {
    const doc = await Customer.findOne({ _id: byCustomerId, owner: ownerId });
    if (doc) return doc;
  }

  return Customer.findOne({
    owner: ownerId,
    "bookings.bookingId": booking._id,
  });
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

async function withdrawWeekly(req, res) {
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

    if (!within14Days(booking)) {
      return res.status(409).json({ ok: false, error: "Not within 14 days" });
    }

    if (booking.paymentStatus === "returned" || booking.returnedAt) {
      if (!safeText(meta.creditNoteEmailSentAt)) {
        const refundAmount = refundAmountFromBooking(booking);

        await createCreditNoteForBooking({
          ownerId: String(ownerId),
          offer: null,
          booking,
          amount:
            refundAmount != null
              ? refundAmount
              : booking.priceAtBooking != null
                ? booking.priceAtBooking
                : 0,
          reason: safeText(meta.withdrawReason) || "Widerruf (≤14 Tage)",
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

    const subId = safeText(booking?.stripe?.subscriptionId);
    if (!subId) {
      return res
        .status(409)
        .json({ ok: false, error: "Missing subscriptionId" });
    }

    const stripe = stripeClient();

    if (!safeText(meta.weeklyWithdrawCancelledAt)) {
      await stripe.subscriptions.cancel(subId);
      meta.weeklyWithdrawCancelledAt = new Date().toISOString();
    }

    let pi = safeText(booking?.stripe?.paymentIntentId);

    if (!pi) {
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

    if (!safeText(meta.stripeRefundId)) {
      const refund = await stripe.refunds.create({ payment_intent: pi });
      meta.stripeRefundId = refund.id;
    }

    meta.withdrawReason = safeText(req.body?.reason) || "Widerruf (≤14 Tage)";

    booking.paymentStatus = "returned";
    booking.returnedAt = new Date();

    const refundAmount = refundAmountFromBooking(booking);

    booking.markModified("meta");
    await booking.save();

    let cancellationEmailSent = false;

    try {
      const customerDoc = await findCustomerByBooking(ownerId, booking);

      if (customerDoc) {
        const recipientEmail = bookingRecipientEmail(booking, customerDoc);

        if (recipientEmail) {
          const customer = customerDoc.toObject
            ? customerDoc.toObject()
            : customerDoc;

          const effectiveCustomer = bookingCustomerSnapshot(
            customer,
            booking,
            recipientEmail,
          );

          const cancellationPdf = await buildCancellationPdf({
            customer: effectiveCustomer,
            booking,
            offer: null,
            date: booking.returnedAt || new Date(),
            endDate: booking.returnedAt || new Date(),
            reason: meta.withdrawReason,
            cancellationNo: booking.cancellationNo || "",
            refInvoiceNo: booking.invoiceNumber || booking.invoiceNo || "",
            refInvoiceDate: booking.invoiceDate || "",
          });

          await sendCancellationEmail({
            to: recipientEmail,
            customer: effectiveCustomer,
            booking: {
              ...booking.toObject(),
              cancelDate: booking.returnedAt || new Date(),
              endDate: booking.returnedAt || new Date(),
              cancelReason: meta.withdrawReason,
            },
            offer: null,
            pdfBuffer: cancellationPdf,
          });

          cancellationEmailSent = true;
        }
      }
    } catch (e) {
      console.error(
        "[bookings:withdraw-weekly] cancellation email failed:",
        e?.message || e,
      );
    }

    await createCreditNoteForBooking({
      ownerId: String(ownerId),
      offer: null,
      booking,
      amount:
        refundAmount != null
          ? refundAmount
          : booking.priceAtBooking != null
            ? booking.priceAtBooking
            : 0,
      reason: meta.withdrawReason,
    });

    return res.json({
      ok: true,
      refundId: meta.stripeRefundId,
      paymentIntentId: pi,
      creditNoteNo: meta.creditNoteNo || null,
      creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
      cancellationEmailSent,
    });
  } catch (err) {
    console.error("[bookings:withdraw-weekly] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { withdrawWeekly };
