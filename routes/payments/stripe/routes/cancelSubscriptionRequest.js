//routes\payments\stripe\routes\cancelSubscriptionRequest.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../../models/Booking");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const { stripeClient } = require("../lib/stripeClient");
const { safeStr } = require("../lib/strings");
const { ensureStripeShape, ensureMeta } = require("../lib/bookingStripe");
const { sendCancellationEmail } = require("../../../../utils/mailer");

function lower(v) {
  return safeStr(v).toLowerCase();
}

function parseBirthDate(value) {
  const raw = safeStr(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function isoDay(value) {
  const date = value instanceof Date ? value : parseBirthDate(value);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

function isMonthEnd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const probe = new Date(date);
  return (
    probe.getDate() ===
    new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate()
  );
}

function endOfMonthAfterThreeMonths(date) {
  const base = new Date(date);
  return new Date(base.getFullYear(), base.getMonth() + 4, 0, 23, 59, 59, 999);
}

function endOfRequestedDate(value) {
  const date = parseBirthDate(value);
  if (!date) return null;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  );
}

function formatCancellationNo() {
  const date = new Date();
  const yy = String(date.getFullYear()).slice(-2);
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KND-${yy}-${rnd}`;
}

function resolveOwner(req) {
  const headerOwner = safeStr(req.get("x-provider-id"));
  if (headerOwner && mongoose.isValidObjectId(headerOwner)) {
    return headerOwner;
  }

  const envOwner = safeStr(process.env.DEFAULT_OWNER_ID);
  if (envOwner && mongoose.isValidObjectId(envOwner)) {
    return envOwner;
  }

  return "";
}

function hasCancellation(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  return Boolean(
    booking?.status === "cancelled" ||
    booking?.cancelDate ||
    booking?.cancellationDate ||
    safeStr(booking?.cancellationNo) ||
    booking?.stripe?.cancelRequestedAt ||
    booking?.stripe?.cancelEffectiveAt ||
    safeStr(meta.subscriptionCancelStatus),
  );
}

function alreadyMessage(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  if (
    safeStr(meta.subscriptionCancelSource) === "customer_button" ||
    safeStr(meta.subscriptionCancelSource) === "customer_form"
  ) {
    return "Sie haben bereits gekündigt.";
  }

  return "Ihr Vertrag wurde bereits gekündigt.";
}

function isActiveSubscriptionBooking(booking) {
  return Boolean(
    booking &&
    safeStr(booking?.stripe?.mode) === "subscription" &&
    safeStr(booking?.stripe?.subscriptionId) &&
    booking?.paymentStatus === "paid",
  );
}

function pickRecipient(customer, booking) {
  return safeStr(customer?.parent?.email) || safeStr(booking?.email);
}

function pickRecipient(customer, booking) {
  return (
    safeStr(booking?.invoiceTo?.parent?.email) ||
    safeStr(booking?.email) ||
    safeStr(customer?.parent?.email) ||
    safeStr(customer?.email)
  );
}

function customerMailSnapshot(customer, booking, recipientEmail) {
  const bookingParent = booking?.invoiceTo?.parent || {};
  const customerParent = customer?.parent || {};
  const raw = customer?.toObject
    ? customer.toObject()
    : { ...(customer || {}) };

  return {
    ...raw,
    parent: {
      salutation:
        safeStr(bookingParent?.salutation) ||
        safeStr(customerParent?.salutation),
      firstName:
        safeStr(bookingParent?.firstName) || safeStr(customerParent?.firstName),
      lastName:
        safeStr(bookingParent?.lastName) || safeStr(customerParent?.lastName),
      email: recipientEmail,
      phone: safeStr(bookingParent?.phone) || safeStr(customerParent?.phone),
      phone2: safeStr(bookingParent?.phone2) || safeStr(customerParent?.phone2),
    },
    email: recipientEmail,
    emailLower: recipientEmail.toLowerCase(),
  };
}

// async function sendCancellationMail(customer, booking, offer) {
//   const to = pickRecipient(customer, booking);
//   if (!to) return;

//   await sendCancellationEmail({
//     to,
//     customer: customer.toObject ? customer.toObject() : customer,
//     booking: booking.toObject ? booking.toObject() : booking,
//     offer,
//   });
// }

function bookingMailPayload(booking) {
  const base = booking?.toObject ? booking.toObject() : { ...(booking || {}) };

  return {
    ...base,
    childFirstName: safeStr(booking?.childFirstName),
    childLastName: safeStr(booking?.childLastName),
    childName:
      safeStr(booking?.childName) ||
      [safeStr(booking?.childFirstName), safeStr(booking?.childLastName)]
        .filter(Boolean)
        .join(" "),
    childUid: safeStr(booking?.childUid),
  };
}

// async function sendCancellationMail(customer, booking, offer) {
//   const to = pickRecipient(customer, booking);
//   if (!to) return;

//   await sendCancellationEmail({
//     to,
//     customer: customer.toObject ? customer.toObject() : customer,
//     booking: bookingMailPayload(booking),
//     offer,
//   });
// }

async function sendCancellationMail(customer, booking, offer) {
  const to = pickRecipient(customer, booking);
  if (!to) return;

  const effectiveCustomer = customerMailSnapshot(customer, booking, to);

  await sendCancellationEmail({
    to,
    customer: effectiveCustomer,
    booking: bookingMailPayload(booking),
    offer,
  });
}

function applyBookingCancellation(booking, now, effectiveAt, reason) {
  const meta = ensureMeta(booking);

  booking.status = "cancelled";
  booking.cancelledAt = booking.cancelledAt || now;
  booking.cancelDate = booking.cancelDate || now;
  booking.cancellationDate = booking.cancellationDate || now;
  booking.endDate = booking.endDate || effectiveAt;
  booking.cancelReason = booking.cancelReason || reason;
  booking.cancellationReason = booking.cancellationReason || reason;
  booking.cancellationNo =
    safeStr(booking.cancellationNo) || formatCancellationNo();

  booking.stripe.cancelRequestedAt = booking.stripe.cancelRequestedAt || now;
  booking.stripe.cancelEffectiveAt =
    booking.stripe.cancelEffectiveAt || effectiveAt;

  meta.subscriptionCancelSource = "customer_form";
  meta.subscriptionCancelStatus = "requested";
  meta.subscriptionCancelRequestedAt = now.toISOString();
  meta.subscriptionCancelEffectiveAt = effectiveAt.toISOString();
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

  // const candidates = await Customer.find({
  //   owner,
  //   $or: [
  //     { emailLower },
  //     { "parent.email": emailLower },
  //     { email: emailLower },
  //   ],
  // });

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
//       if (safeStr(ref?.status) === "cancelled") return false;
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

// async function findBookingForRequest(customer, childUid) {
//   const bookings = await loadCandidateBookings(customer, childUid);
//   return (
//     bookings.find((booking) => {
//       return isActiveSubscriptionBooking(booking) && !hasCancellation(booking);
//     }) || null
//   );
// }

function sameReference(booking, refNo) {
  const want = lower(refNo);

  return [
    booking?.invoiceNumber,
    booking?.invoiceNo,
    booking?.confirmationCode,
  ].some((value) => lower(value) === want);
}

async function findBookingForRequest(customer, childUid, referenceNo) {
  const bookings = await loadCandidateBookings(customer, childUid);

  return (
    bookings.find((booking) => {
      return (
        isActiveSubscriptionBooking(booking) &&
        !hasCancellation(booking) &&
        sameReference(booking, referenceNo)
      );
    }) || null
  );
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
  const terminationMode = safeStr(body?.terminationMode);
  const requestedEndDate = safeStr(body?.requestedEndDate);
  const reason = safeStr(body?.reason) || "Mitgliedschaft gekündigt";

  if (
    !parentEmail ||
    !referenceNo ||
    !childFirstName ||
    !childLastName ||
    !childBirthDate
  ) {
    return { ok: false, code: "MISSING_FIELDS" };
  }

  if (!["earliest", "requested"].includes(terminationMode)) {
    return { ok: false, code: "INVALID_TERMINATION_MODE" };
  }

  if (terminationMode === "requested" && !requestedEndDate) {
    return { ok: false, code: "MISSING_REQUESTED_END_DATE" };
  }

  const birthDate = parseBirthDate(childBirthDate);
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
      terminationMode,
      requestedEndDate,
      reason,
    },
  };
}

function resolveEffectiveAt(mode, requestedEndDate, now) {
  const earliest = endOfMonthAfterThreeMonths(now);

  if (mode === "earliest") {
    return { ok: true, effectiveAt: earliest };
  }

  const requested = endOfRequestedDate(requestedEndDate);
  if (!requested || !isMonthEnd(requested)) {
    return { ok: false, code: "INVALID_REQUESTED_END_DATE" };
  }

  if (requested.getTime() < earliest.getTime()) {
    return { ok: false, code: "REQUESTED_END_DATE_TOO_EARLY", earliest };
  }

  return { ok: true, effectiveAt: requested };
}

async function applyCustomerCancellation(customer, booking, now, reason) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  const ref =
    refs.find(
      (item) => String(item?.bookingId || "") === String(booking?._id || ""),
    ) ||
    refs.find((item) => String(item?._id || "") === String(booking?._id || ""));

  if (!ref) return;

  ref.status = "cancelled";
  ref.cancelDate = ref.cancelDate || now;
  ref.endDate =
    ref.endDate || booking.endDate || booking.stripe.cancelEffectiveAt;
  ref.cancelReason = ref.cancelReason || reason;
  ref.cancellationNo =
    safeStr(ref.cancellationNo) || safeStr(booking.cancellationNo);

  await customer.save();
}

function splitChildName(fullName) {
  const raw = safeStr(fullName);
  if (!raw) return { firstName: "", lastName: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
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

async function cancelSubscriptionRequest(req, res) {
  try {
    const owner = resolveOwner(req);
    if (!owner) {
      return res.status(500).json({
        ok: false,
        code: "OWNER_NOT_CONFIGURED",
        message: "Kündigung ist aktuell nicht verfügbar.",
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
        message: "Es wurde kein passendes aktives Abo gefunden.",
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
    // // applyRequestedChildToBooking(booking, child, form, childUid);
    // const ref = findBookingRef(customer, booking?._id);
    // applyChildToBooking(booking, ref, child, form, childUid);

    // if (!booking) {
    //   return res.status(404).json({
    //     ok: false,
    //     code: "BOOKING_NOT_FOUND",
    //     message: "Es wurde kein passendes aktives Abo gefunden.",
    //   });
    // }

    if (!booking) {
      return res.status(404).json({
        ok: false,
        code: "BOOKING_NOT_FOUND",
        message: "Es wurde kein passendes aktives Abo gefunden.",
      });
    }

    const ref = findBookingRef(customer, booking._id);
    applyChildToBooking(booking, ref, child, form, childUid);

    ensureStripeShape(booking);

    if (hasCancellation(booking)) {
      return res.status(409).json({
        ok: false,
        code: "CANCELLATION_ALREADY_EXISTS",
        message: alreadyMessage(booking),
        cancelEffectiveAt:
          booking.stripe.cancelEffectiveAt || booking.endDate || null,
      });
    }

    const subId = safeStr(booking?.stripe?.subscriptionId);
    if (!subId) {
      return res.status(400).json({
        ok: false,
        code: "NO_SUBSCRIPTION",
        message:
          "Für diese Mitgliedschaft konnte keine Stripe-Subscription gefunden werden.",
      });
    }

    const now = new Date();
    const effective = resolveEffectiveAt(
      form.terminationMode,
      form.requestedEndDate,
      now,
    );

    if (!effective.ok) {
      return res.status(400).json({
        ok: false,
        code: effective.code,
        message:
          effective.code === "REQUESTED_END_DATE_TOO_EARLY"
            ? "Das gewünschte Kündigungsdatum ist zu früh."
            : "Das gewünschte Kündigungsdatum ist nicht zulässig.",
        earliestEndDate: effective.earliest || null,
      });
    }

    const effectiveAt = effective.effectiveAt;
    const cancelAtSec = Math.floor(effectiveAt.getTime() / 1000);

    const stripe = stripeClient();
    const updated = await stripe.subscriptions.update(subId, {
      cancel_at: cancelAtSec,
    });

    booking.stripe.subStatus = safeStr(updated?.status);

    applyBookingCancellation(
      booking,
      now,
      new Date((updated?.cancel_at || cancelAtSec) * 1000),
      form.reason,
    );

    await applyCustomerCancellation(customer, booking, now, form.reason);

    booking.markModified("meta");
    await booking.save();

    const offer = await loadOffer(booking);
    await sendCancellationMail(customer, booking, offer);

    return res.status(200).json({
      ok: true,
      cancellationNo: booking.cancellationNo,
      cancelEffectiveAt: booking.stripe.cancelEffectiveAt,
      subStatus: booking.stripe.subStatus,
      message: "Kündigung erfolgreich vorgemerkt.",
    });
  } catch (e) {
    console.error(
      "[stripe] cancel-subscription-request error:",
      e?.message || e,
    );
    return res.status(500).json({
      ok: false,
      code: "SERVER",
      message: "Serverfehler bei der Kündigung.",
    });
  }
}

module.exports = { cancelSubscriptionRequest };

// "use strict";

// const mongoose = require("mongoose");
// const Booking = require("../../../../models/Booking");
// const Customer = require("../../../../models/Customer");
// const Offer = require("../../../../models/Offer");
// const { stripeClient } = require("../lib/stripeClient");
// const { safeStr } = require("../lib/strings");
// const { ensureStripeShape, ensureMeta } = require("../lib/bookingStripe");
// const { sendCancellationEmail } = require("../../../../utils/mailer");

// // const {
// //   cancelSubscriptionRequest,
// // } = require("./routes/cancelSubscriptionRequest");

// // router.post(
// //   "/cancel-subscription-request",
// //   express.json(),
// //   cancelSubscriptionRequest,
// // );

// function lower(v) {
//   return safeStr(v).toLowerCase();
// }

// function parseBirthDate(value) {
//   const raw = safeStr(value);
//   if (!raw) return null;
//   const date = new Date(raw);
//   if (Number.isNaN(date.getTime())) return null;
//   return date;
// }

// function isoDay(value) {
//   const date = value instanceof Date ? value : parseBirthDate(value);
//   if (!date) return "";
//   return date.toISOString().slice(0, 10);
// }

// function isMonthEnd(date) {
//   if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
//   const probe = new Date(date);
//   return (
//     probe.getDate() ===
//     new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate()
//   );
// }

// function endOfMonthAfterThreeMonths(date) {
//   const base = new Date(date);
//   return new Date(base.getFullYear(), base.getMonth() + 4, 0, 23, 59, 59, 999);
// }

// function endOfRequestedDate(value) {
//   const date = parseBirthDate(value);
//   if (!date) return null;
//   return new Date(
//     date.getFullYear(),
//     date.getMonth(),
//     date.getDate(),
//     23,
//     59,
//     59,
//     999,
//   );
// }

// function formatCancellationNo() {
//   const date = new Date();
//   const yy = String(date.getFullYear()).slice(-2);
//   const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
//   return `KND-${yy}-${rnd}`;
// }

// function resolveOwner(req) {
//   const headerOwner = safeStr(req.get("x-provider-id"));
//   if (headerOwner && mongoose.isValidObjectId(headerOwner)) {
//     return headerOwner;
//   }

//   const envOwner = safeStr(process.env.DEFAULT_OWNER_ID);
//   if (envOwner && mongoose.isValidObjectId(envOwner)) {
//     return envOwner;
//   }

//   return "";
// }

// function hasCancellation(booking) {
//   const meta =
//     booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

//   return Boolean(
//     booking?.status === "cancelled" ||
//     booking?.cancelDate ||
//     booking?.cancellationDate ||
//     safeStr(booking?.cancellationNo) ||
//     booking?.stripe?.cancelRequestedAt ||
//     booking?.stripe?.cancelEffectiveAt ||
//     safeStr(meta.subscriptionCancelStatus),
//   );
// }

// function alreadyMessage(booking) {
//   const meta =
//     booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

//   if (
//     safeStr(meta.subscriptionCancelSource) === "customer_button" ||
//     safeStr(meta.subscriptionCancelSource) === "customer_form"
//   ) {
//     return "Sie haben bereits gekündigt.";
//   }

//   return "Ihr Vertrag wurde bereits gekündigt.";
// }

// function isActiveSubscriptionBooking(booking) {
//   return Boolean(
//     booking &&
//     safeStr(booking?.stripe?.mode) === "subscription" &&
//     safeStr(booking?.stripe?.subscriptionId) &&
//     booking?.paymentStatus === "paid",
//   );
// }

// function pickRecipient(customer, booking) {
//   return safeStr(customer?.parent?.email) || safeStr(booking?.email);
// }

// async function sendCancellationMail(customer, booking, offer) {
//   const to = pickRecipient(customer, booking);
//   if (!to) return;

//   await sendCancellationEmail({
//     to,
//     customer: customer.toObject ? customer.toObject() : customer,
//     booking: booking.toObject ? booking.toObject() : booking,
//     offer,
//   });
// }

// function applyBookingCancellation(booking, now, effectiveAt, reason) {
//   const meta = ensureMeta(booking);

//   booking.status = "cancelled";
//   booking.cancelledAt = booking.cancelledAt || now;
//   booking.cancelDate = booking.cancelDate || now;
//   booking.cancellationDate = booking.cancellationDate || now;
//   booking.endDate = booking.endDate || effectiveAt;
//   booking.cancelReason = booking.cancelReason || reason;
//   booking.cancellationReason = booking.cancellationReason || reason;
//   booking.cancellationNo =
//     safeStr(booking.cancellationNo) || formatCancellationNo();

//   booking.stripe.cancelRequestedAt = booking.stripe.cancelRequestedAt || now;
//   booking.stripe.cancelEffectiveAt =
//     booking.stripe.cancelEffectiveAt || effectiveAt;

//   meta.subscriptionCancelSource = "customer_form";
//   meta.subscriptionCancelStatus = "requested";
//   meta.subscriptionCancelRequestedAt = now.toISOString();
//   meta.subscriptionCancelEffectiveAt = effectiveAt.toISOString();
// }

// function childMatches(child, firstName, lastName, birthDateIso) {
//   return (
//     lower(child?.firstName) === lower(firstName) &&
//     lower(child?.lastName) === lower(lastName) &&
//     isoDay(child?.birthDate) === birthDateIso
//   );
// }

// // function findMatchingChild(customer, firstName, lastName, birthDateIso) {
// //   const list = Array.isArray(customer?.children) ? customer.children : [];
// //   const hit = list.find((child) =>
// //     childMatches(child, firstName, lastName, birthDateIso),
// //   );
// //   if (hit) return hit;

// //   const fallback = customer?.child;
// //   return childMatches(fallback, firstName, lastName, birthDateIso)
// //     ? fallback
// //     : null;
// // }

// function findMatchingChild(customer, firstName, lastName, birthDateIso) {
//   const list = Array.isArray(customer?.children) ? customer.children : [];

//   const strictHit = list.find((child) =>
//     childMatches(child, firstName, lastName, birthDateIso, false),
//   );
//   if (strictHit) return strictHit;

//   const fallbackHits = list.filter((child) =>
//     childMatches(child, firstName, lastName, birthDateIso, true),
//   );
//   if (fallbackHits.length === 1) return fallbackHits[0];

//   const fallback = customer?.child;
//   if (childMatches(fallback, firstName, lastName, birthDateIso, false)) {
//     return fallback;
//   }

//   if (
//     fallbackHits.length === 0 &&
//     childMatches(fallback, firstName, lastName, birthDateIso, true)
//   ) {
//     return fallback;
//   }

//   return null;
// }

// async function findCustomerByForm(
//   owner,
//   parentEmail,
//   firstName,
//   lastName,
//   birthDateIso,
// ) {
//   const emailLower = lower(parentEmail);

//   const candidates = await Customer.find({
//     owner,
//     $or: [
//       { emailLower },
//       { "parent.email": emailLower },
//       { email: emailLower },
//     ],
//   });

//   return (
//     candidates.find(
//       (customer) =>
//         !!findMatchingChild(customer, firstName, lastName, birthDateIso),
//     ) || null
//   );
// }

// function pickChildUid(customer, child, firstName, lastName) {
//   const uid = safeStr(child?.uid);
//   if (uid) return uid;

//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const hit = refs.find((ref) => {
//     return (
//       lower(ref?.childFirstName) === lower(firstName) &&
//       lower(ref?.childLastName) === lower(lastName)
//     );
//   });

//   return safeStr(hit?.childUid);
// }

// async function loadCandidateBookings(customer, childUid) {
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const ids = refs
//     .filter((ref) => {
//       if (!ref?.bookingId) return false;
//       if (safeStr(ref?.status) === "cancelled") return false;
//       if (childUid && safeStr(ref?.childUid) !== childUid) return false;
//       return true;
//     })
//     .map((ref) => ref.bookingId);

//   if (!ids.length) return [];

//   return Booking.find({ _id: { $in: ids }, customerId: customer._id }).sort({
//     createdAt: -1,
//   });
// }

// async function findBookingForRequest(customer, childUid) {
//   const bookings = await loadCandidateBookings(customer, childUid);
//   return (
//     bookings.find((booking) => {
//       return isActiveSubscriptionBooking(booking) && !hasCancellation(booking);
//     }) || null
//   );
// }

// async function loadOffer(booking) {
//   const offerId = safeStr(booking?.offerId);
//   if (!offerId) return null;
//   return Offer.findById(offerId).lean();
// }

// function validateBody(body) {
//   const parentEmail = safeStr(body?.parentEmail).toLowerCase();
//   const childFirstName = safeStr(body?.childFirstName);
//   const childLastName = safeStr(body?.childLastName);
//   const childBirthDate = safeStr(body?.childBirthDate);
//   const terminationMode = safeStr(body?.terminationMode);
//   const requestedEndDate = safeStr(body?.requestedEndDate);
//   const reason = safeStr(body?.reason) || "Mitgliedschaft gekündigt";

//   if (!parentEmail || !childFirstName || !childLastName || !childBirthDate) {
//     return { ok: false, code: "MISSING_FIELDS" };
//   }

//   if (!["earliest", "requested"].includes(terminationMode)) {
//     return { ok: false, code: "INVALID_TERMINATION_MODE" };
//   }

//   if (terminationMode === "requested" && !requestedEndDate) {
//     return { ok: false, code: "MISSING_REQUESTED_END_DATE" };
//   }

//   const birthDate = parseBirthDate(childBirthDate);
//   if (!birthDate) {
//     return { ok: false, code: "INVALID_BIRTH_DATE" };
//   }

//   return {
//     ok: true,
//     value: {
//       parentEmail,
//       childFirstName,
//       childLastName,
//       childBirthDate,
//       terminationMode,
//       requestedEndDate,
//       reason,
//     },
//   };
// }

// function resolveEffectiveAt(mode, requestedEndDate, now) {
//   const earliest = endOfMonthAfterThreeMonths(now);

//   if (mode === "earliest") {
//     return { ok: true, effectiveAt: earliest };
//   }

//   const requested = endOfRequestedDate(requestedEndDate);
//   if (!requested || !isMonthEnd(requested)) {
//     return { ok: false, code: "INVALID_REQUESTED_END_DATE" };
//   }

//   if (requested.getTime() < earliest.getTime()) {
//     return { ok: false, code: "REQUESTED_END_DATE_TOO_EARLY", earliest };
//   }

//   return { ok: true, effectiveAt: requested };
// }

// async function applyCustomerCancellation(customer, booking, now, reason) {
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const ref =
//     refs.find(
//       (item) => String(item?.bookingId || "") === String(booking?._id || ""),
//     ) ||
//     refs.find((item) => String(item?._id || "") === String(booking?._id || ""));

//   if (!ref) return;

//   ref.status = "cancelled";
//   ref.cancelDate = ref.cancelDate || now;
//   ref.endDate =
//     ref.endDate || booking.endDate || booking.stripe.cancelEffectiveAt;
//   ref.cancelReason = ref.cancelReason || reason;
//   ref.cancellationNo =
//     safeStr(ref.cancellationNo) || safeStr(booking.cancellationNo);

//   await customer.save();
// }

// async function cancelSubscriptionRequest(req, res) {
//   try {
//     const owner = resolveOwner(req);
//     if (!owner) {
//       return res.status(500).json({
//         ok: false,
//         code: "OWNER_NOT_CONFIGURED",
//         message: "Kündigung ist aktuell nicht verfügbar.",
//       });
//     }

//     const parsed = validateBody(req.body || {});
//     if (!parsed.ok) {
//       return res.status(400).json({
//         ok: false,
//         code: parsed.code,
//         message: "Die eingegebenen Daten sind unvollständig oder ungültig.",
//       });
//     }

//     const form = parsed.value;
//     const birthDateIso = isoDay(form.childBirthDate);

//     const customer = await findCustomerByForm(
//       owner,
//       form.parentEmail,
//       form.childFirstName,
//       form.childLastName,
//       birthDateIso,
//     );

//     if (!customer) {
//       return res.status(404).json({
//         ok: false,
//         code: "CUSTOMER_NOT_FOUND",
//         message: "Es wurde kein passendes aktives Abo gefunden.",
//       });
//     }

//     const child = findMatchingChild(
//       customer,
//       form.childFirstName,
//       form.childLastName,
//       birthDateIso,
//     );

//     const childUid = pickChildUid(
//       customer,
//       child,
//       form.childFirstName,
//       form.childLastName,
//     );

//     const booking = await findBookingForRequest(customer, childUid);

//     if (!booking) {
//       return res.status(404).json({
//         ok: false,
//         code: "BOOKING_NOT_FOUND",
//         message: "Es wurde kein passendes aktives Abo gefunden.",
//       });
//     }

//     ensureStripeShape(booking);

//     if (hasCancellation(booking)) {
//       return res.status(409).json({
//         ok: false,
//         code: "CANCELLATION_ALREADY_EXISTS",
//         message: alreadyMessage(booking),
//         cancelEffectiveAt:
//           booking.stripe.cancelEffectiveAt || booking.endDate || null,
//       });
//     }

//     const subId = safeStr(booking?.stripe?.subscriptionId);
//     if (!subId) {
//       return res.status(400).json({
//         ok: false,
//         code: "NO_SUBSCRIPTION",
//         message:
//           "Für diese Mitgliedschaft konnte keine Stripe-Subscription gefunden werden.",
//       });
//     }

//     const now = new Date();
//     const effective = resolveEffectiveAt(
//       form.terminationMode,
//       form.requestedEndDate,
//       now,
//     );

//     if (!effective.ok) {
//       return res.status(400).json({
//         ok: false,
//         code: effective.code,
//         message:
//           effective.code === "REQUESTED_END_DATE_TOO_EARLY"
//             ? "Das gewünschte Kündigungsdatum ist zu früh."
//             : "Das gewünschte Kündigungsdatum ist nicht zulässig.",
//         earliestEndDate: effective.earliest || null,
//       });
//     }

//     const effectiveAt = effective.effectiveAt;
//     const cancelAtSec = Math.floor(effectiveAt.getTime() / 1000);

//     const stripe = stripeClient();
//     const updated = await stripe.subscriptions.update(subId, {
//       cancel_at: cancelAtSec,
//     });

//     booking.stripe.subStatus = safeStr(updated?.status);

//     applyBookingCancellation(
//       booking,
//       now,
//       new Date((updated?.cancel_at || cancelAtSec) * 1000),
//       form.reason,
//     );

//     await applyCustomerCancellation(customer, booking, now, form.reason);

//     booking.markModified("meta");
//     await booking.save();

//     const offer = await loadOffer(booking);
//     await sendCancellationMail(customer, booking, offer);

//     return res.status(200).json({
//       ok: true,
//       cancellationNo: booking.cancellationNo,
//       cancelEffectiveAt: booking.stripe.cancelEffectiveAt,
//       subStatus: booking.stripe.subStatus,
//       message: "Kündigung erfolgreich vorgemerkt.",
//     });
//   } catch (e) {
//     console.error(
//       "[stripe] cancel-subscription-request error:",
//       e?.message || e,
//     );
//     return res.status(500).json({
//       ok: false,
//       code: "SERVER",
//       message: "Serverfehler bei der Kündigung.",
//     });
//   }
// }

// module.exports = { cancelSubscriptionRequest };
