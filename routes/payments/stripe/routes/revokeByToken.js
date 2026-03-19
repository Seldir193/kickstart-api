//routes\payments\stripe\routes\revokeByToken.js
"use strict";

const crypto = require("crypto");
const Booking = require("../../../../models/Booking");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const { stripeClient } = require("../lib/stripeClient");
const { safeStr } = require("../lib/strings");
const { ensureMeta, ensureStripeShape } = require("../lib/bookingStripe");
const { createCreditNoteForBooking } = require("../../../../utils/creditNotes");
const { buildStornoPdf } = require("../../../../utils/pdf");
const { sendStornoEmail } = require("../../../../utils/mailer");

function safeText(v) {
  return String(v ?? "").trim();
}

function lower(v) {
  return safeText(v).toLowerCase();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function parseDate(value) {
  const raw = safeText(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function within14Days(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  const base =
    parseDate(meta.contractSignedAt) ||
    (booking?.paidAt ? new Date(booking.paidAt) : null) ||
    (booking?.createdAt ? new Date(booking.createdAt) : null);

  if (!base) return false;

  const diff = Date.now() - base.getTime();
  return diff >= 0 && diff <= 14 * 24 * 60 * 60 * 1000;
}

function isPaidBooking(booking) {
  return booking?.paymentStatus === "paid" || !!booking?.paidAt;
}

function buildStornoNo() {
  const stamp = Date.now().toString().slice(-8);
  return `STORNO-${stamp}`;
}

function refundAmountFromBooking(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  const amount =
    meta.creditNoteAmount != null
      ? Number(meta.creditNoteAmount)
      : booking?.priceAtBooking != null
        ? Number(booking.priceAtBooking)
        : null;

  if (!Number.isFinite(amount)) return null;
  return Math.abs(Math.round(amount * 100) / 100);
}

function splitChildName(fullName) {
  const raw = safeText(fullName);
  if (!raw) return { firstName: "", lastName: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function findBookingRef(customer, bookingId) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  return (
    refs.find((item) => String(item?.bookingId || "") === String(bookingId)) ||
    refs.find((item) => String(item?._id || "") === String(bookingId)) ||
    null
  );
}

function findChildByUid(customer, childUid) {
  const list = Array.isArray(customer?.children) ? customer.children : [];
  return (
    list.find((child) => safeText(child?.uid) === safeText(childUid)) || null
  );
}

function findChildByBookingRef(customer, ref) {
  const byUid = findChildByUid(customer, safeText(ref?.childUid));
  if (byUid) return byUid;

  const first = lower(ref?.childFirstName);
  const last = lower(ref?.childLastName);
  const list = Array.isArray(customer?.children) ? customer.children : [];

  return (
    list.find((child) => {
      return (
        lower(child?.firstName) === first && lower(child?.lastName) === last
      );
    }) || null
  );
}

function applyChildToBooking(booking, ref, child) {
  const nameFromBooking = splitChildName(booking?.childName);

  const first =
    safeText(ref?.childFirstName) ||
    safeText(child?.firstName) ||
    safeText(booking?.childFirstName) ||
    safeText(nameFromBooking.firstName);

  const last =
    safeText(ref?.childLastName) ||
    safeText(child?.lastName) ||
    safeText(booking?.childLastName) ||
    safeText(nameFromBooking.lastName);

  booking.childFirstName = first;
  booking.childLastName = last;
  booking.childName = [first, last].filter(Boolean).join(" ");
  booking.childUid =
    safeText(ref?.childUid) ||
    safeText(child?.uid) ||
    safeText(booking?.childUid);
}

async function loadCustomer(booking) {
  const customerId = safeText(booking?.customerId);

  if (customerId) {
    const byId = await Customer.findById(customerId);
    if (byId) return byId;
  }

  return Customer.findOne({
    $or: [
      { "bookings.bookingId": booking._id },
      { "bookings._id": booking._id },
    ],
  });
}

async function loadOffer(booking) {
  const offerId = safeText(booking?.offerId);
  if (!offerId) return null;
  return Offer.findById(offerId).lean();
}

function pickRecipient(customer, booking) {
  return (
    safeText(customer?.parent?.email) ||
    safeText(booking?.invoiceTo?.parent?.email) ||
    safeText(booking?.email)
  );
}

async function inferRefundPaymentIntentFromSubscription(stripe, subId) {
  if (!subId) return "";

  try {
    const subscription = await stripe.subscriptions.retrieve(subId);
    const latestInvoiceId = safeText(subscription?.latest_invoice);

    if (latestInvoiceId) {
      const payments = await stripe.invoicePayments.list({
        invoice: latestInvoiceId,
        limit: 10,
      });

      for (const item of payments?.data || []) {
        const pi =
          safeText(item?.payment?.payment_intent) ||
          safeText(item?.payment?.payment_intent?.id);

        if (pi) return pi;
      }

      const invoice = await stripe.invoices.retrieve(latestInvoiceId);
      const invoicePi =
        safeText(invoice?.payment_intent) ||
        safeText(invoice?.payment_intent?.id);

      if (invoicePi) return invoicePi;
    }

    const invoices = await stripe.invoices.list({
      subscription: subId,
      limit: 10,
    });

    for (const invoice of invoices?.data || []) {
      const payments = await stripe.invoicePayments.list({
        invoice: invoice.id,
        limit: 10,
      });

      for (const item of payments?.data || []) {
        const pi =
          safeText(item?.payment?.payment_intent) ||
          safeText(item?.payment?.payment_intent?.id);

        if (pi) return pi;
      }

      const invoicePi =
        safeText(invoice?.payment_intent) ||
        safeText(invoice?.payment_intent?.id);

      if (invoicePi) return invoicePi;
    }

    return "";
  } catch (_) {
    return "";
  }
}

async function findBookingByRevokeToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  return Booking.findOne({
    revocationTokenHash: tokenHash,
    revocationTokenExpires: { $gt: now },
  });
}

function alreadyRevoked(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  return Boolean(
    booking?.paymentStatus === "returned" ||
    booking?.returnedAt ||
    safeText(booking?.stornoNo) ||
    safeText(meta.revocationProcessedAt),
  );
}

function alreadyRevokedMessage(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  if (safeText(meta.revocationProcessedAt)) {
    return "Der Widerruf wurde bereits verarbeitet.";
  }

  return "Der Vertrag wurde bereits widerrufen.";
}

async function sendStornoMail(customer, booking, offer) {
  const to = pickRecipient(customer, booking);
  if (!to) return;

  const pdfBuffer = await buildStornoPdf({
    customer,
    booking,
    offer,
    amount: null,
    currency: safeText(booking.currency || "EUR") || "EUR",
    stornoNo: booking.stornoNo,
    refInvoiceNo: booking.invoiceNo || booking.invoiceNumber || "",
    refInvoiceDate: booking.invoiceDate || null,
  });

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

async function revokeUnpaid({ booking, customer, offer, reason }) {
  const meta = ensureMeta(booking);
  const now = new Date();
  const ref = findBookingRef(customer, booking._id);

  booking.status = "storno";
  booking.stornoNo = booking.stornoNo || buildStornoNo();
  booking.stornoDate = booking.stornoDate || now;
  booking.returnNote = reason;
  meta.revocationProcessedAt = now.toISOString();
  meta.revocationSource = "customer_button";

  if (ref) {
    ref.status = "cancelled";
    ref.stornoNo = ref.stornoNo || booking.stornoNo;
    ref.stornoDate = ref.stornoDate || booking.stornoDate;
    ref.stornoReason = ref.stornoReason || reason;
    await customer.save();
  }

  booking.markModified("meta");
  await booking.save();
  await sendStornoMail(customer, booking, offer);

  return {
    ok: true,
    mode: "unpaid_storno",
    stornoNo: booking.stornoNo,
    message: "Der Widerruf wurde erfolgreich verarbeitet.",
  };
}

async function revokePaid({ booking, reason }) {
  const meta = ensureMeta(booking);
  const stripe = stripeClient();
  const subId = safeText(booking?.stripe?.subscriptionId);
  const isSubscriptionMode = safeText(booking?.stripe?.mode) === "subscription";

  let pi = safeText(booking?.stripe?.paymentIntentId);

  if (
    isSubscriptionMode &&
    subId &&
    !safeText(meta.weeklyWithdrawCancelledAt)
  ) {
    await stripe.subscriptions.cancel(subId);
    meta.weeklyWithdrawCancelledAt = new Date().toISOString();
  }

  if (!pi && isSubscriptionMode && subId) {
    pi = await inferRefundPaymentIntentFromSubscription(stripe, subId);

    if (pi) {
      booking.stripe = booking.stripe || {};
      booking.stripe.paymentIntentId = pi;
    }
  }

  if (!pi) {
    return {
      ok: false,
      status: 409,
      code: "MISSING_PAYMENT_INTENT",
      message: "Für diese Buchung konnte keine Stripe-Zahlung gefunden werden.",
    };
  }

  if (!safeText(meta.stripeRefundId)) {
    const refund = await stripe.refunds.create({ payment_intent: pi });
    meta.stripeRefundId = refund.id;
  }

  booking.paymentStatus = "returned";
  booking.returnedAt = new Date();
  booking.returnNote = reason;
  booking.cancelledAt = booking.cancelledAt || new Date();
  booking.cancelDate = booking.cancelDate || new Date();
  booking.cancelReason = booking.cancelReason || reason;
  meta.revocationProcessedAt = new Date().toISOString();
  meta.revocationSource = "customer_button";

  if (isSubscriptionMode) {
    booking.status = "cancelled";
    booking.endDate = booking.endDate || new Date();
    booking.stripe.subStatus = "canceled";
  }

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
    mode: isSubscriptionMode ? "weekly_refund" : "one_time_refund",
    refundId: meta.stripeRefundId || null,
    creditNoteNo: meta.creditNoteNo || null,
    creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
    message: "Der Widerruf wurde erfolgreich verarbeitet.",
  };
}

// async function revokePaid({ booking, reason }) {
//   const meta = ensureMeta(booking);
//   const stripe = stripeClient();
//   const subId = safeText(booking?.stripe?.subscriptionId);
//   const isSubscriptionMode = safeText(booking?.stripe?.mode) === "subscription";

//   let pi = safeText(booking?.stripe?.paymentIntentId);

//   if (
//     isSubscriptionMode &&
//     subId &&
//     !safeText(meta.weeklyWithdrawCancelledAt)
//   ) {
//     await stripe.subscriptions.cancel(subId);
//     meta.weeklyWithdrawCancelledAt = new Date().toISOString();
//   }

//   if (!pi && isSubscriptionMode && subId) {
//     pi = await inferRefundPaymentIntentFromSubscription(stripe, subId);

//     if (pi) {
//       booking.stripe = booking.stripe || {};
//       booking.stripe.paymentIntentId = pi;
//     }
//   }

//   if (!pi) {
//     return {
//       ok: false,
//       status: 409,
//       code: "MISSING_PAYMENT_INTENT",
//       message: "Für diese Buchung konnte keine Stripe-Zahlung gefunden werden.",
//     };
//   }

//   if (!safeText(meta.stripeRefundId)) {
//     const refund = await stripe.refunds.create({ payment_intent: pi });
//     meta.stripeRefundId = refund.id;
//   }

//   booking.paymentStatus = "returned";
//   booking.returnedAt = new Date();
//   booking.returnNote = reason;
//   meta.revocationProcessedAt = new Date().toISOString();
//   meta.revocationSource = "customer_button";

//   const amount = refundAmountFromBooking(booking);
//   if (amount != null) meta.creditNoteAmount = amount;

//   booking.markModified("meta");
//   await booking.save();

//   await createCreditNoteForBooking({
//     ownerId: String(booking.owner),
//     offer: null,
//     booking,
//     amount:
//       amount != null
//         ? amount
//         : booking.priceAtBooking != null
//           ? booking.priceAtBooking
//           : 0,
//     reason,
//   });

//   return {
//     ok: true,
//     mode: isSubscriptionMode ? "weekly_refund" : "one_time_refund",
//     refundId: meta.stripeRefundId || null,
//     creditNoteNo: meta.creditNoteNo || null,
//     creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
//     message: "Der Widerruf wurde erfolgreich verarbeitet.",
//   };
// }

async function revokeByToken(req, res) {
  try {
    const rawToken = safeText(req.body?.token);

    if (!rawToken) {
      return res.status(400).json({
        ok: false,
        code: "MISSING_TOKEN",
        message: "Der Widerrufslink ist ungültig.",
      });
    }

    const booking = await findBookingByRevokeToken(rawToken);

    if (!booking) {
      return res.status(404).json({
        ok: false,
        code: "INVALID_OR_EXPIRED_TOKEN",
        message: "Der Widerrufslink ist ungültig oder abgelaufen.",
      });
    }

    ensureStripeShape(booking);

    if (alreadyRevoked(booking)) {
      return res.status(409).json({
        ok: false,
        code: "REVOCATION_ALREADY_EXISTS",
        message: alreadyRevokedMessage(booking),
      });
    }

    if (!within14Days(booking)) {
      return res.status(409).json({
        ok: false,
        code: "REVOCATION_WINDOW_EXPIRED",
        message: "Widerruf nicht mehr möglich (mehr als 14 Tage).",
      });
    }

    const customer = await loadCustomer(booking);
    if (!customer) {
      return res.status(404).json({
        ok: false,
        code: "CUSTOMER_NOT_FOUND",
        message: "Zu dieser Buchung konnte kein Kunde gefunden werden.",
      });
    }

    const ref = findBookingRef(customer, booking._id);
    const child = findChildByBookingRef(customer, ref);
    applyChildToBooking(booking, ref, child);

    const offer = await loadOffer(booking);
    const reason = safeText(req.body?.reason) || "Widerruf (≤14 Tage)";

    if (!isPaidBooking(booking)) {
      const result = await revokeUnpaid({
        booking,
        customer,
        offer,
        reason,
      });

      return res.status(200).json(result);
    }

    const result = await revokePaid({
      booking,
      reason,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json({
        ok: false,
        code: result.code || "SERVER",
        message: result.message || "Serverfehler beim Widerruf.",
      });
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error("[stripe] revoke-by-token error:", e?.message || e);
    return res.status(500).json({
      ok: false,
      code: "SERVER",
      message: "Serverfehler beim Widerruf.",
    });
  }
}

module.exports = { revokeByToken };
