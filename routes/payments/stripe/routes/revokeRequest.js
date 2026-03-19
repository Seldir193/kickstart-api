//routes\payments\stripe\routes\revokeRequest.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../../models/Booking");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const { stripeClient } = require("../lib/stripeClient");
const { safeStr } = require("../lib/strings");
const { ensureMeta } = require("../lib/bookingStripe");
const { createCreditNoteForBooking } = require("../../../../utils/creditNotes");
const { buildStornoPdf } = require("../../../../utils/pdf");
const { sendStornoEmail } = require("../../../../utils/mailer");

function lower(v) {
  return safeStr(v).toLowerCase();
}

function parseDate(value) {
  const raw = safeStr(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDay(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

function resolveOwner(req) {
  const headerOwner = safeStr(req.get("x-provider-id"));
  if (headerOwner && mongoose.isValidObjectId(headerOwner)) return headerOwner;

  const envOwner = safeStr(process.env.DEFAULT_OWNER_ID);
  if (envOwner && mongoose.isValidObjectId(envOwner)) return envOwner;

  return "";
}

function isWeeklyOffer(offer) {
  const category = safeStr(offer?.category);
  const type = safeStr(offer?.type);
  return (
    category === "Weekly" ||
    type === "Foerdertraining" ||
    type === "Kindergarten"
  );
}

function isPaidBooking(booking) {
  return booking?.paymentStatus === "paid" || !!booking?.paidAt;
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

function buildStornoNo() {
  const stamp = Date.now().toString().slice(-8);
  return `STORNO-${stamp}`;
}

function childMatches(
  child,
  firstName,
  lastName,
  birthDateIso,
  allowMissingBirthDate = false,
) {
  const sameName =
    lower(child?.firstName) === lower(firstName) &&
    lower(child?.lastName) === lower(lastName);

  if (!sameName) return false;

  const childBirthIso = isoDay(child?.birthDate);
  if (childBirthIso && childBirthIso === birthDateIso) return true;

  return allowMissingBirthDate && !childBirthIso;
}

function findMatchingChild(customer, firstName, lastName, birthDateIso) {
  const list = Array.isArray(customer?.children) ? customer.children : [];

  const strictHit = list.find((child) =>
    childMatches(child, firstName, lastName, birthDateIso, false),
  );
  if (strictHit) return strictHit;

  const fallbackHits = list.filter((child) =>
    childMatches(child, firstName, lastName, birthDateIso, true),
  );
  if (fallbackHits.length === 1) return fallbackHits[0];

  const fallback = customer?.child;

  if (childMatches(fallback, firstName, lastName, birthDateIso, false)) {
    return fallback;
  }

  if (
    fallbackHits.length === 0 &&
    childMatches(fallback, firstName, lastName, birthDateIso, true)
  ) {
    return fallback;
  }

  return null;
}

async function findCustomerByForm(
  owner,
  parentEmail,
  firstName,
  lastName,
  birthDateIso,
) {
  const emailLower = lower(parentEmail);

  const candidates = await Customer.find({
    owner,
    $or: [
      { emailLower },
      { "parent.email": emailLower },
      { "parents.email": emailLower },
      { email: emailLower },
    ],
  });

  return (
    candidates.find(
      (customer) =>
        !!findMatchingChild(customer, firstName, lastName, birthDateIso),
    ) || null
  );
}

function pickChildUid(customer, child, firstName, lastName) {
  const uid = safeStr(child?.uid);
  if (uid) return uid;

  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  const hit = refs.find((ref) => {
    return (
      lower(ref?.childFirstName) === lower(firstName) &&
      lower(ref?.childLastName) === lower(lastName)
    );
  });

  return safeStr(hit?.childUid);
}

// async function loadCandidateBookings(customer, childUid) {
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const ids = refs
//     .filter((ref) => {
//       if (!ref?.bookingId) return false;
//       if (childUid && safeStr(ref?.childUid) !== childUid) return false;
//       return true;
//     })
//     .map((ref) => ref.bookingId);

//   if (!ids.length) return [];

//   return Booking.find({ _id: { $in: ids }, customerId: customer._id }).sort({
//     createdAt: -1,
//   });
// }

async function loadCandidateBookings(customer, childUid) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

  const ids = refs
    .filter((ref) => {
      if (!ref?.bookingId) return false;
      if (safeStr(ref?.status) === "cancelled") return false;
      if (childUid && safeStr(ref?.childUid) !== childUid) return false;
      return true;
    })
    .map((ref) => ref.bookingId);

  if (!ids.length) return [];

  return Booking.find({ _id: { $in: ids } }).sort({ createdAt: -1 });
}

function canStillBeRevoked(booking) {
  if (!booking) return false;
  if (booking.paymentStatus === "returned" || booking.returnedAt) return false;
  if (safeStr(booking?.stornoNo)) return false;
  if (safeStr(booking?.cancellationNo)) return false;
  if (safeStr(booking?.status) === "storno") return false;
  return true;
}

// function sameReference(booking, refNo) {
//   const want = lower(refNo);

//   return [
//     booking?.invoiceNumber,
//     booking?.invoiceNo,
//     booking?.confirmationCode,
//   ].some((value) => lower(value) === want);
// }

function sameReference(booking, ref, refNo) {
  const want = lower(refNo);

  return [
    booking?.invoiceNumber,
    booking?.invoiceNo,
    booking?.confirmationCode,
    ref?.invoiceNumber,
    ref?.invoiceNo,
  ].some((value) => lower(value) === want);
}

// async function findBookingForRequest(customer, childUid, referenceNo) {
//   const bookings = await loadCandidateBookings(customer, childUid);

//   return (
//     bookings.find((booking) => {
//       return canStillBeRevoked(booking) && sameReference(booking, referenceNo);
//     }) || null
//   );
// }

async function findBookingForRequest(customer, childUid, referenceNo) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

  const matchingRefs = refs.filter((ref) => {
    if (!ref?.bookingId) return false;
    if (safeStr(ref?.status) === "cancelled") return false;
    if (childUid && safeStr(ref?.childUid) !== childUid) return false;

    return [ref?.invoiceNumber, ref?.invoiceNo].some(
      (value) => lower(value) === lower(referenceNo),
    );
  });

  if (!matchingRefs.length) return null;

  const ids = matchingRefs.map((ref) => ref.bookingId);
  const bookings = await Booking.find({ _id: { $in: ids } }).sort({
    createdAt: -1,
  });

  return bookings.find((booking) => canStillBeRevoked(booking)) || null;
}

async function loadOffer(booking) {
  const offerId = safeStr(booking?.offerId);
  if (!offerId) return null;
  return Offer.findById(offerId).lean();
}

function validateBody(body) {
  const parentEmail = safeStr(body?.parentEmail).toLowerCase();
  const referenceNo = safeStr(body?.referenceNo);
  const childFirstName = safeStr(body?.childFirstName);
  const childLastName = safeStr(body?.childLastName);
  const childBirthDate = safeStr(body?.childBirthDate);
  const reason = safeStr(body?.reason) || "Widerruf (≤14 Tage)";

  if (
    !parentEmail ||
    !referenceNo ||
    !childFirstName ||
    !childLastName ||
    !childBirthDate
  ) {
    return { ok: false, code: "MISSING_FIELDS" };
  }

  const birthDate = parseDate(childBirthDate);
  if (!birthDate) {
    return { ok: false, code: "INVALID_BIRTH_DATE" };
  }

  return {
    ok: true,
    value: {
      parentEmail,
      referenceNo,
      childFirstName,
      childLastName,
      childBirthDate,
      reason,
    },
  };
}

function findBookingRef(customer, bookingId) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  return (
    refs.find(
      (item) => String(item?.bookingId || "") === String(bookingId || ""),
    ) ||
    refs.find((item) => String(item?._id || "") === String(bookingId || "")) ||
    null
  );
}

function splitChildName(fullName) {
  const raw = safeStr(fullName);
  if (!raw) return { firstName: "", lastName: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function applyChildToBooking(booking, ref, child, form, childUid) {
  const nameFromBooking = splitChildName(booking?.childName);

  const first =
    safeStr(ref?.childFirstName) ||
    safeStr(child?.firstName) ||
    safeStr(form?.childFirstName) ||
    safeStr(booking?.childFirstName) ||
    safeStr(nameFromBooking.firstName);

  const last =
    safeStr(ref?.childLastName) ||
    safeStr(child?.lastName) ||
    safeStr(form?.childLastName) ||
    safeStr(booking?.childLastName) ||
    safeStr(nameFromBooking.lastName);

  booking.childFirstName = first;
  booking.childLastName = last;
  booking.childName = [first, last].filter(Boolean).join(" ");
  booking.childUid =
    safeStr(childUid) || safeStr(ref?.childUid) || safeStr(child?.uid);
}

function pickRecipient(customer, booking) {
  return (
    safeStr(customer?.parent?.email) ||
    safeStr(booking?.invoiceTo?.parent?.email) ||
    safeStr(booking?.email)
  );
}

async function inferRefundPaymentIntentFromSubscription(stripe, subId) {
  if (!subId) return "";

  try {
    const subscription = await stripe.subscriptions.retrieve(subId);
    const latestInvoiceId = safeStr(subscription?.latest_invoice);

    if (latestInvoiceId) {
      const payments = await stripe.invoicePayments.list({
        invoice: latestInvoiceId,
        limit: 10,
      });

      for (const item of payments?.data || []) {
        const pi =
          safeStr(item?.payment?.payment_intent) ||
          safeStr(item?.payment?.payment_intent?.id);

        if (pi) return pi;
      }

      const invoice = await stripe.invoices.retrieve(latestInvoiceId);

      const invoicePi =
        safeStr(invoice?.payment_intent) ||
        safeStr(invoice?.payment_intent?.id);

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
          safeStr(item?.payment?.payment_intent) ||
          safeStr(item?.payment?.payment_intent?.id);

        if (pi) return pi;
      }

      const invoicePi =
        safeStr(invoice?.payment_intent) ||
        safeStr(invoice?.payment_intent?.id);

      if (invoicePi) return invoicePi;
    }

    return "";
  } catch (err) {
    return "";
  }
}

async function markUnpaidRevocation({ customer, booking, offer, reason }) {
  const ref = findBookingRef(customer, booking._id);
  if (!ref) throw new Error("BOOKING_REF_NOT_FOUND");

  const stornoNo = safeStr(ref.stornoNo) || buildStornoNo();
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

  const pdfBuffer = await buildStornoPdf({
    customer,
    booking,
    offer,
    amount: null,
    currency: safeStr(booking.currency || "EUR") || "EUR",
    stornoNo,
    refInvoiceNo: booking.invoiceNo || booking.invoiceNumber || "",
    refInvoiceDate: booking.invoiceDate || null,
  });

  const to = pickRecipient(customer, booking);

  if (to) {
    await sendStornoEmail({
      to,
      customer: customer.toObject ? customer.toObject() : customer,
      booking,
      offer,
      pdfBuffer,
      amount: null,
      currency: safeStr(booking.currency || "EUR") || "EUR",
    });
  }

  return {
    ok: true,
    mode: "unpaid_storno",
    stornoNo,
    message: "Der Widerruf wurde erfolgreich verarbeitet.",
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
      creditNoteEmailSentAt: meta.creditNoteEmailSentAt || null,
      message: "Der Widerruf wurde bereits verarbeitet.",
    };
  }

  const subId = safeStr(booking?.stripe?.subscriptionId);
  let pi = safeStr(booking?.stripe?.paymentIntentId);

  const isSubscriptionMode = safeStr(booking?.stripe?.mode) === "subscription";

  if (isSubscriptionMode && subId && !safeStr(meta.weeklyWithdrawCancelledAt)) {
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

  console.log("[revoke-request] weekly refund debug", {
    bookingId: String(booking?._id || ""),
    subId,
    bookingPaymentIntentId: safeStr(booking?.stripe?.paymentIntentId),
    inferredPi: pi,
    mode: safeStr(booking?.stripe?.mode),
  });
  if (!pi) throw new Error("MISSING_PAYMENT_INTENT");

  if (!safeStr(meta.stripeRefundId)) {
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
    message: "Der Widerruf wurde erfolgreich verarbeitet.",
  };
}

async function revokeRequest(req, res) {
  try {
    const owner = resolveOwner(req);

    if (!owner) {
      return res.status(500).json({
        ok: false,
        code: "OWNER_NOT_CONFIGURED",
        message: "Widerruf ist aktuell nicht verfügbar.",
      });
    }

    const parsed = validateBody(req.body || {});
    if (!parsed.ok) {
      return res.status(400).json({
        ok: false,
        code: parsed.code,
        message: "Die eingegebenen Daten sind unvollständig oder ungültig.",
      });
    }

    const form = parsed.value;
    const birthDateIso = isoDay(form.childBirthDate);

    const customer = await findCustomerByForm(
      owner,
      form.parentEmail,
      form.childFirstName,
      form.childLastName,
      birthDateIso,
    );

    if (!customer) {
      return res.status(404).json({
        ok: false,
        code: "CUSTOMER_NOT_FOUND",
        message: "Es wurde keine passende widerrufbare Buchung gefunden.",
      });
    }

    const child = findMatchingChild(
      customer,
      form.childFirstName,
      form.childLastName,
      birthDateIso,
    );

    const childUid = pickChildUid(
      customer,
      child,
      form.childFirstName,
      form.childLastName,
    );

    const booking = await findBookingForRequest(
      customer,
      childUid,
      form.referenceNo,
    );

    if (!booking) {
      return res.status(404).json({
        ok: false,
        code: "BOOKING_NOT_FOUND",
        message: "Es wurde keine passende widerrufbare Buchung gefunden.",
      });
    }

    const ref = findBookingRef(customer, booking._id);
    applyChildToBooking(booking, ref, child, form, childUid);

    if (!within14Days(booking)) {
      return res.status(409).json({
        ok: false,
        code: "REVOCATION_WINDOW_EXPIRED",
        message: "Widerruf nicht mehr möglich (mehr als 14 Tage).",
      });
    }

    const offer = await loadOffer(booking);
    const isSubscriptionMode =
      safeStr(booking?.stripe?.mode) === "subscription";
    const isWeekly = isSubscriptionMode || isWeeklyOffer(offer);
    const paid = isPaidBooking(booking);

    if (!paid) {
      const result = await markUnpaidRevocation({
        customer,
        booking,
        offer,
        reason: form.reason,
      });

      return res.status(200).json(result);
    }

    const result = await markPaidRevocation({
      booking,
      reason: form.reason,
      isWeekly,
    });

    return res.status(200).json(result);
  } catch (e) {
    const msg = safeStr(e?.message);

    if (msg === "MISSING_PAYMENT_INTENT") {
      return res.status(409).json({
        ok: false,
        code: "MISSING_PAYMENT_INTENT",
        message:
          "Für diese Buchung konnte keine Stripe-Zahlung gefunden werden.",
      });
    }

    if (msg === "BOOKING_REF_NOT_FOUND") {
      return res.status(404).json({
        ok: false,
        code: "BOOKING_REF_NOT_FOUND",
        message: "Die Buchungsreferenz konnte nicht gefunden werden.",
      });
    }

    console.error("[stripe] revoke-request error:", e?.message || e);
    return res.status(500).json({
      ok: false,
      code: "SERVER",
      message: "Serverfehler beim Widerruf.",
    });
  }
}

module.exports = { revokeRequest };
