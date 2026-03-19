//routes\payments\stripe\lib\createPaymentCheckout.js
"use strict";

const { stripeClient } = require("./stripeClient");
const { successUrl, cancelUrl } = require("./env");
const { moneyCents } = require("./money");
const { safeStr } = require("./strings");
const { ensureStripeShape } = require("./bookingStripe");
const { loadOffer, isSubscriptionOffer, displayName } = require("./offer");
//const { metaForBooking } = require("./meta");

const { metaForBooking, stripeDescriptionLines } = require("./meta");

async function createPaymentCheckout({ booking }) {
  // console.log("DEBUG createPaymentCheckout start", {
  //   bookingId: String(booking?._id || ""),
  //   offerId: String(booking?.offerId || ""),
  //   offerType: booking?.offerType,
  //   offerTitle: booking?.offerTitle,
  //   paymentStatus: booking?.paymentStatus,
  //   priceAtBooking: booking?.priceAtBooking,
  // });

  const offer = await loadOffer(booking);

  // console.log("DEBUG createPaymentCheckout offer", {
  //   found: !!offer,
  //   category: offer?.category,
  //   type: offer?.type,
  //   sub_type: offer?.sub_type,
  //   price: offer?.price,
  //   location: offer?.location,
  // });

  if (!offer) return { ok: false, code: "OFFER_NOT_FOUND" };
  if (isSubscriptionOffer(offer))
    return { ok: false, code: "USE_SUBSCRIPTION_ENDPOINT" };
  if (booking.paymentStatus === "paid") return { ok: true, alreadyPaid: true };

  const amount =
    typeof booking.priceAtBooking === "number"
      ? booking.priceAtBooking
      : offer.price;
  const cents = moneyCents(amount);
  if (!cents) return { ok: false, code: "INVALID_AMOUNT" };

  ensureStripeShape(booking);
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: successUrl(),
    cancel_url: cancelUrl(),
    customer_email: safeStr(booking.email).toLowerCase() || undefined,
    payment_method_types: ["card", "sepa_debit"],
    invoice_creation: {
      enabled: true,
    },
    metadata: metaForBooking(booking),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: cents,
          product_data: {
            name: displayName(booking, offer),
            //  description: safeStr(offer.location),
            description: stripeDescriptionLines(booking, offer),
          },
        },
      },
    ],
  });

  booking.stripe.mode = "payment";
  booking.stripe.checkoutSessionId = session.id;
  booking.paymentStatus = "open";
  await booking.save();

  return { ok: true, url: session.url, sessionId: session.id };
}

module.exports = { createPaymentCheckout };
