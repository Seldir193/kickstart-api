//routes\payments\stripe\lib\bookingStripe.js
"use strict";

function ensureStripeShape(booking) {
  if (!booking.stripe || typeof booking.stripe !== "object")
    booking.stripe = {};
  booking.stripe.mode = booking.stripe.mode || "";
  booking.stripe.checkoutSessionId = booking.stripe.checkoutSessionId || "";
  booking.stripe.paymentIntentId = booking.stripe.paymentIntentId || "";
  booking.stripe.subscriptionId = booking.stripe.subscriptionId || "";
  booking.stripe.subStatus = booking.stripe.subStatus || "";
  booking.stripe.currentPeriodStart = booking.stripe.currentPeriodStart || null;
  booking.stripe.currentPeriodEnd = booking.stripe.currentPeriodEnd || null;
  booking.stripe.cancelRequestedAt = booking.stripe.cancelRequestedAt || null;
  booking.stripe.cancelEffectiveAt = booking.stripe.cancelEffectiveAt || null;
  booking.stripe.lastEventId = booking.stripe.lastEventId || "";
  booking.stripe.lastEventType = booking.stripe.lastEventType || "";
}

function ensureMeta(booking) {
  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
  return booking.meta;
}

module.exports = { ensureStripeShape, ensureMeta };
