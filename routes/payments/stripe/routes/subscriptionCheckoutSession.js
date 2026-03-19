// routes/payments/stripe/routes/subscriptionCheckoutSession.js
"use strict";

const Booking = require("../../../../models/Booking");
const { safeStr } = require("../lib/strings");
const {
  createSubscriptionCheckout,
} = require("../lib/createSubscriptionCheckout");

function bookingMeta(booking) {
  return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
}

function hasSignedContract(meta) {
  return !!safeStr(meta?.contractSignedAt);
}

async function subscriptionCheckoutSession(req, res) {
  try {
    const bookingId = safeStr(req.body?.bookingId);
    if (!bookingId) {
      return res.status(400).json({ ok: false, code: "MISSING_BOOKING_ID" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });
    }

    const meta = bookingMeta(booking);
    if (!hasSignedContract(meta)) {
      return res.status(403).json({ ok: false, code: "CONTRACT_NOT_SIGNED" });
    }

    const out = await createSubscriptionCheckout({
      booking,
      returnTo: req.body?.returnTo,
    });

    if (!out?.ok) {
      const code = out?.code || "SERVER";
      const status =
        code === "PAYMENT_NOT_APPROVED" || code === "SUBSCRIPTION_NOT_ALLOWED"
          ? 403
          : code === "SUBSCRIPTION_ALREADY_CREATED"
            ? 409
            : 400;
      return res.status(status).json({ ok: false, code });
    }

    return res.status(200).json({
      ok: true,
      url: out.url,
      sessionId: out.sessionId,
    });
  } catch (e) {
    console.error(
      "[stripe] subscription-checkout-session error:",
      e?.message || e,
    );
    const msg = String(e?.message || e || "");
    return res.status(500).json({
      ok: false,
      code: "SERVER",
      message: process.env.NODE_ENV === "production" ? "" : msg,
    });
  }
}

module.exports = { subscriptionCheckoutSession };

// // routes/payments/stripe/routes/subscriptionCheckoutSession.js
// "use strict";

// const Booking = require("../../../../models/Booking");
// const { safeStr } = require("../lib/strings");
// const {
//   createSubscriptionCheckout,
// } = require("../lib/createSubscriptionCheckout");

// async function subscriptionCheckoutSession(req, res) {
//   try {
//     const bookingId = safeStr(req.body?.bookingId);
//     if (!bookingId)
//       return res.status(400).json({ ok: false, code: "MISSING_BOOKING_ID" });

//     const booking = await Booking.findById(bookingId);
//     if (!booking)
//       return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });

//     const out = await createSubscriptionCheckout({
//       booking,
//       returnTo: req.body?.returnTo,
//     });

//     if (!out?.ok) {
//       const code = out?.code || "SERVER";
//       const status =
//         code === "PAYMENT_NOT_APPROVED" || code === "SUBSCRIPTION_NOT_ALLOWED"
//           ? 403
//           : code === "SUBSCRIPTION_ALREADY_CREATED"
//             ? 409
//             : 400;
//       return res.status(status).json({ ok: false, code });
//     }

//     return res
//       .status(200)
//       .json({ ok: true, url: out.url, sessionId: out.sessionId });
//   } catch (e) {
//     console.error(
//       "[stripe] subscription-checkout-session error:",
//       e?.message || e,
//     );
//     const msg = String(e?.message || e || "");
//     return res.status(500).json({
//       ok: false,
//       code: "SERVER",
//       message: process.env.NODE_ENV === "production" ? "" : msg,
//     });
//   }
// }

// module.exports = { subscriptionCheckoutSession };

// //routes\payments\stripe\routes\subscriptionCheckoutSession.js
// "use strict";

// const Booking = require("../../../../models/Booking");
// const { stripeClient } = require("../lib/stripeClient");
// const { successUrl, cancelUrl } = require("../lib/env");
// const { moneyCents } = require("../lib/money");
// const { safeStr, safeUrl } = require("../lib/strings");
// const { ensureStripeShape } = require("../lib/bookingStripe");
// const { loadOffer, isSubscriptionOffer, displayName } = require("../lib/offer");
// const { metaForBooking } = require("../lib/meta");
// const { getOrCreateStripeCustomer } = require("../lib/stripeCustomer");
// const {
//   createSubscriptionCheckout,
// } = require("../lib/createSubscriptionCheckout");

// async function subscriptionCheckoutSession(req, res) {
//   try {
//     const bookingId = safeStr(req.body?.bookingId);
//     if (!bookingId)
//       return res.status(400).json({ ok: false, code: "MISSING_BOOKING_ID" });

//     const booking = await Booking.findById(bookingId);
//     if (!booking)
//       return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });

//     const bookingMeta =
//       booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

//     const approvalRequired = bookingMeta.paymentApprovalRequired === true;
//     const approvedAt = String(bookingMeta.paymentApprovedAt || "").trim();

//     if (approvalRequired && !approvedAt) {
//       return res.status(403).json({
//         ok: false,
//         code: "PAYMENT_NOT_APPROVED",
//       });
//     }

//     if (!booking?.meta?.subscriptionEligible) {
//       return res
//         .status(403)
//         .json({ ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" });
//     }

//     const offer = await loadOffer(booking);
//     if (!offer)
//       return res.status(400).json({ ok: false, code: "OFFER_NOT_FOUND" });
//     if (!isSubscriptionOffer(offer))
//       return res
//         .status(400)
//         .json({ ok: false, code: "NOT_A_SUBSCRIPTION_OFFER" });

//     ensureStripeShape(booking);
//     if (safeStr(booking.stripe.subscriptionId)) {
//       return res
//         .status(409)
//         .json({ ok: false, code: "SUBSCRIPTION_ALREADY_CREATED" });
//     }

//     const monthly =
//       typeof booking.priceMonthly === "number"
//         ? booking.priceMonthly
//         : offer.price;
//     const cents = moneyCents(monthly);
//     if (!cents)
//       return res.status(400).json({ ok: false, code: "INVALID_AMOUNT" });

//     const stripeCustomerId = await getOrCreateStripeCustomer(booking);
//     const stripe = stripeClient();
//     const meta = metaForBooking(booking);

//     const returnTo = safeUrl(req.body?.returnTo);
//     const okUrl = returnTo
//       ? `${returnTo}${returnTo.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`
//       : successUrl();
//     const cancel = returnTo || cancelUrl();

//     const session = await stripe.checkout.sessions.create({
//       mode: "subscription",
//       success_url: okUrl,
//       cancel_url: cancel,
//       customer: stripeCustomerId || undefined,
//       customer_email: stripeCustomerId
//         ? undefined
//         : safeStr(booking.email).toLowerCase() || undefined,
//       payment_method_types: ["sepa_debit", "card"],
//       metadata: meta,
//       subscription_data: { metadata: meta },
//       line_items: [
//         {
//           quantity: 1,
//           price_data: {
//             currency: "eur",
//             unit_amount: cents,
//             recurring: { interval: "month" },
//             product_data: { name: displayName(booking, offer) },
//           },
//         },
//       ],
//     });

//     booking.stripe.mode = "subscription";
//     booking.stripe.checkoutSessionId = session.id;
//     booking.paymentStatus = "open";
//     await booking.save();

//     return res
//       .status(200)
//       .json({ ok: true, url: session.url, sessionId: session.id });
//   } catch (e) {
//     console.error(
//       "[stripe] subscription-checkout-session error:",
//       e?.message || e,
//     );
//     const msg = String(e?.message || e || "");
//     return res.status(500).json({
//       ok: false,
//       code: "SERVER",
//       message: process.env.NODE_ENV === "production" ? "" : msg,
//     });
//   }
// }

// module.exports = { subscriptionCheckoutSession };
