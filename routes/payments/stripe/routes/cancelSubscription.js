//routes\payments\stripe\routes\cancelSubscription.js
"use strict";

const crypto = require("crypto");
const Booking = require("../../../../models/Booking");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const { stripeClient } = require("../lib/stripeClient");
const { safeStr } = require("../lib/strings");
const { ensureStripeShape, ensureMeta } = require("../lib/bookingStripe");
const { sendCancellationEmail } = require("../../../../utils/mailer");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function lower(value) {
  return safeStr(value).toLowerCase();
}

function splitChildName(fullName) {
  const raw = safeStr(fullName);
  if (!raw) return { firstName: "", lastName: "" };

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function endOfMonthAfterThreeMonths(date) {
  const base = new Date(date);
  return new Date(base.getFullYear(), base.getMonth() + 4, 0, 23, 59, 59, 999);
}

function formatCancellationNo() {
  const date = new Date();
  const yy = String(date.getFullYear()).slice(-2);
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KND-${yy}-${rnd}`;
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

  if (safeStr(meta.subscriptionCancelSource) === "customer_button") {
    return "Sie haben bereits gekündigt.";
  }

  return "Ihr Vertrag wurde bereits gekündigt.";
}

async function loadCustomer(booking) {
  const customerId = safeStr(booking?.customerId);

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

function findBookingRef(customer, bookingId) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

  return (
    refs.find((item) => {
      return String(item?.bookingId || "") === String(bookingId || "");
    }) ||
    refs.find((item) => {
      return String(item?._id || "") === String(bookingId || "");
    }) ||
    null
  );
}

function findChildByUid(customer, childUid) {
  const list = Array.isArray(customer?.children) ? customer.children : [];
  return (
    list.find((child) => safeStr(child?.uid) === safeStr(childUid)) || null
  );
}

function findChildByBookingRef(customer, ref) {
  const byUid = findChildByUid(customer, safeStr(ref?.childUid));
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
    safeStr(ref?.childFirstName) ||
    safeStr(child?.firstName) ||
    safeStr(booking?.childFirstName) ||
    safeStr(nameFromBooking.firstName);

  const last =
    safeStr(ref?.childLastName) ||
    safeStr(child?.lastName) ||
    safeStr(booking?.childLastName) ||
    safeStr(nameFromBooking.lastName);

  booking.childFirstName = first;
  booking.childLastName = last;
  booking.childName = [first, last].filter(Boolean).join(" ");
  booking.childUid =
    safeStr(ref?.childUid) || safeStr(child?.uid) || safeStr(booking?.childUid);
}

async function loadOffer(booking) {
  const offerId = safeStr(booking?.offerId);
  if (!offerId) return null;
  return Offer.findById(offerId).lean();
}

// function pickRecipient(customer, booking) {
//   return safeStr(customer?.parent?.email) || safeStr(booking?.email);
// }

function pickRecipient(customer, booking) {
  return (
    safeStr(booking?.invoiceTo?.parent?.email) ||
    safeStr(booking?.email) ||
    safeStr(customer?.parent?.email) ||
    safeStr(customer?.email)
  );
}

// function customerMailSnapshot(customer, booking, recipientEmail) {
//   const bookingParent = booking?.invoiceTo?.parent || {};
//   const customerParent = customer?.parent || {};
//   const raw = customer?.toObject
//     ? customer.toObject()
//     : { ...(customer || {}) };

//   return {
//     ...raw,
//     parent: {
//       salutation:
//         safeStr(bookingParent?.salutation) ||
//         safeStr(customerParent?.salutation),
//       firstName:
//         safeStr(bookingParent?.firstName) || safeStr(customerParent?.firstName),
//       lastName:
//         safeStr(bookingParent?.lastName) || safeStr(customerParent?.lastName),
//       email: recipientEmail,
//       phone: safeStr(bookingParent?.phone) || safeStr(customerParent?.phone),
//       phone2: safeStr(bookingParent?.phone2) || safeStr(customerParent?.phone2),
//     },
//     email: recipientEmail,
//     emailLower: recipientEmail.toLowerCase(),
//   };
// }

function customerMailSnapshot(customer, booking, recipientEmail) {
  const bookingParent = booking?.invoiceTo?.parent || {};
  const customerParent = customer?.parent || {};
  const raw = customer?.toObject
    ? customer.toObject()
    : { ...(customer || {}) };
  const email = safeStr(recipientEmail);

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
      email,
      phone: safeStr(bookingParent?.phone) || safeStr(customerParent?.phone),
      phone2: safeStr(bookingParent?.phone2) || safeStr(customerParent?.phone2),
    },
    email,
    emailLower: email.toLowerCase(),
  };
}

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

  // console.log("[cancelSubscription] cancellation recipient", {
  //   bookingId: String(booking?._id || ""),
  //   bookingEmail: booking?.email,
  //   bookingInvoiceParentEmail: booking?.invoiceTo?.parent?.email,
  //   customerParentEmail: customer?.parent?.email,
  //   to,
  // });

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

  meta.subscriptionCancelSource = "customer_button";
  meta.subscriptionCancelStatus = "requested";
  meta.subscriptionCancelRequestedAt = now.toISOString();
  meta.subscriptionCancelEffectiveAt = effectiveAt.toISOString();
}

async function applyCustomerCancellation(customer, booking, now, reason) {
  if (!customer) return;

  const ref = findBookingRef(customer, booking._id);
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

async function findBookingByCancelToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  return Booking.findOne({
    subscriptionCancelTokenHash: tokenHash,
    subscriptionCancelTokenExpires: { $gt: now },
  });
}

async function cancelSubscription(req, res) {
  try {
    const rawToken = safeStr(req.body?.token);

    if (!rawToken) {
      return res.status(400).json({ ok: false, code: "MISSING_TOKEN" });
    }

    const booking = await findBookingByCancelToken(rawToken);

    if (!booking) {
      return res.status(404).json({
        ok: false,
        code: "INVALID_OR_EXPIRED_TOKEN",
        message: "Der Kündigungslink ist ungültig oder abgelaufen.",
      });
    }

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

    const subId = safeStr(booking.stripe.subscriptionId);

    if (!subId) {
      return res.status(400).json({ ok: false, code: "NO_SUBSCRIPTION" });
    }

    const now = new Date();
    const effectiveAt = endOfMonthAfterThreeMonths(now);
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
      safeStr(req.body?.reason) || "Abo-Kündigung durch Kunde",
    );

    const customer = await loadCustomer(booking);
    const ref = findBookingRef(customer, booking._id);
    const child = findChildByBookingRef(customer, ref);

    applyChildToBooking(booking, ref, child);

    // console.log("[cancelSubscription] final child payload", {
    //   bookingId: String(booking?._id || ""),
    //   childFirstName: booking?.childFirstName,
    //   childLastName: booking?.childLastName,
    //   childName: booking?.childName,
    //   childUid: booking?.childUid,
    //   ref,
    //   child,
    // });

    await applyCustomerCancellation(
      customer,
      booking,
      now,
      safeStr(booking.cancellationReason),
    );

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
    console.error("[stripe] cancel-subscription error:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
}

module.exports = { cancelSubscription };
