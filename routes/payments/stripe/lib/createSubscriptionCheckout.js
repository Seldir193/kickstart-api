"use strict";

const { stripeClient } = require("./stripeClient");
const { successUrl, cancelUrl } = require("./env");
const { moneyCents } = require("./money");
const { safeStr, safeUrl } = require("./strings");
const { ensureStripeShape, ensureMeta } = require("./bookingStripe");
const { loadOffer, isSubscriptionOffer, displayName } = require("./offer");
const { metaForBooking, stripeDescriptionLines } = require("./meta");
const { getOrCreateStripeCustomer } = require("./stripeCustomer");

function bookingMeta(booking) {
  return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
}

function firstMonthAmount(booking) {
  return typeof booking?.priceFirstMonth === "number"
    ? booking.priceFirstMonth
    : null;
}

function monthlyAmount(booking, offer) {
  if (typeof booking?.priceMonthly === "number") return booking.priceMonthly;
  if (typeof offer?.price === "number") return offer.price;
  return null;
}

function needsDeferredWeeklySubscription(booking) {
  return typeof booking?.priceFirstMonth === "number";
}

async function reuseCheckoutUrl(booking) {
  const sid = safeStr(booking?.stripe?.checkoutSessionId);
  if (!sid) return "";
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(sid);
  return safeStr(session?.url);
}

function deferredSubscriptionMeta(booking, offer) {
  const meta = bookingMeta(booking);
  return {
    ...metaForBooking(booking),
    deferredWeeklySubscription: "true",
    deferredMonthlyAmount:
      typeof monthlyAmount(booking, offer) === "number"
        ? String(monthlyAmount(booking, offer))
        : "",
    deferredFirstMonthAmount:
      typeof firstMonthAmount(booking) === "number"
        ? String(firstMonthAmount(booking))
        : "",
    deferredOfferTitle: safeStr(displayName(booking, offer)),
    deferredOfferLocation: safeStr(offer?.location),
    deferredBasePrice:
      typeof meta?.basePrice === "number" ? String(meta.basePrice) : "",
    deferredSiblingDiscount:
      typeof meta?.siblingDiscount === "number"
        ? String(meta.siblingDiscount)
        : "",
    deferredMemberDiscount:
      typeof meta?.memberDiscount === "number"
        ? String(meta.memberDiscount)
        : "",
    deferredTotalDiscount:
      typeof meta?.totalDiscount === "number" ? String(meta.totalDiscount) : "",
  };
}

function nextMonthStartLabel(dateValue) {
  const base = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(base.getTime())) return "";

  const next = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0),
  );

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(next);
}

function deferredInvoiceCustomFields(booking) {
  const fields = [];

  if (booking?.invoiceNumber || booking?.invoiceNo) {
    fields.push({
      name: "Interne Rechnung",
      value: safeStr(booking.invoiceNo || booking.invoiceNumber),
    });
  }

  if (booking?.customerId) {
    fields.push({
      name: "Kundennummer",
      value: String(booking.customerId),
    });
  }

  return fields.slice(0, 4);
}

function deferredInvoiceFooter(booking) {
  const parts = [];

  if (typeof booking?.priceFirstMonth === "number") {
    parts.push(`Erstmonat/Teilmonat: ${booking.priceFirstMonth} EUR`);
  }

  if (typeof booking?.priceMonthly === "number") {
    const nextStart = nextMonthStartLabel(booking?.date);
    parts.push(
      nextStart
        ? `Reguläres Abo ab ${nextStart}: ${booking.priceMonthly} EUR`
        : `Reguläres Abo: ${booking.priceMonthly} EUR`,
    );
  }

  return parts.join(" | ");
}

async function createDeferredWeeklyCheckout({
  booking,
  offer,
  stripeCustomerId,
  returnTo,
}) {
  const first = firstMonthAmount(booking);
  const cents = moneyCents(first);
  if (!cents) return { ok: false, code: "INVALID_AMOUNT" };

  const stripe = stripeClient();
  const metadata = deferredSubscriptionMeta(booking, offer);
  const rt = safeUrl(returnTo);
  const okUrl = rt
    ? `${rt}${rt.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`
    : successUrl();
  const cancel = rt || cancelUrl();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: okUrl,
    cancel_url: cancel,
    customer: stripeCustomerId || undefined,
    customer_email: stripeCustomerId
      ? undefined
      : safeStr(booking.email).toLowerCase() || undefined,
    payment_method_types: ["sepa_debit", "card"],
    saved_payment_method_options: {
      payment_method_save: "enabled",
    },
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata,
    },
    // metadata,
    // invoice_creation: {
    //   enabled: true,
    // },
    //  metadata,

    metadata,
    invoice_creation: {
      enabled: true,
      invoice_data: {
        description: stripeDescriptionLines(booking, offer),
        footer: deferredInvoiceFooter(booking),
        custom_fields: deferredInvoiceCustomFields(booking),
        metadata,
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: cents,
          product_data: {
            name: `${displayName(booking, offer)} · Erstmonat`,
            description: stripeDescriptionLines(booking, offer),
          },
        },
      },
    ],
  });

  // ensureMeta(booking).deferredWeeklySubscription = true;
  // booking.stripe.mode = "payment";
  // booking.stripe.checkoutSessionId = session.id;
  // booking.paymentStatus = "open";
  // await booking.save();

  const meta = ensureMeta(booking);
  meta.deferredWeeklySubscription = true;
  booking.markModified("meta");
  booking.stripe.mode = "payment";
  booking.stripe.checkoutSessionId = session.id;
  booking.paymentStatus = "open";
  await booking.save();

  return { ok: true, url: session.url, sessionId: session.id };
}

async function createNormalSubscriptionCheckout({
  booking,
  offer,
  stripeCustomerId,
  returnTo,
}) {
  const monthly = monthlyAmount(booking, offer);
  const cents = moneyCents(monthly);
  if (!cents) return { ok: false, code: "INVALID_AMOUNT" };

  const stripe = stripeClient();
  const metadata = metaForBooking(booking);
  const rt = safeUrl(returnTo);
  const okUrl = rt
    ? `${rt}${rt.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`
    : successUrl();
  const cancel = rt || cancelUrl();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    success_url: okUrl,
    cancel_url: cancel,
    customer: stripeCustomerId || undefined,
    customer_email: stripeCustomerId
      ? undefined
      : safeStr(booking.email).toLowerCase() || undefined,
    payment_method_types: ["sepa_debit", "card"],
    metadata,
    subscription_data: { metadata },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: cents,
          recurring: { interval: "month" },
          product_data: {
            name: displayName(booking, offer),
            description: stripeDescriptionLines(booking, offer),
          },
        },
      },
    ],
  });

  booking.stripe.mode = "subscription";
  booking.stripe.checkoutSessionId = session.id;
  booking.paymentStatus = "open";
  await booking.save();

  return { ok: true, url: session.url, sessionId: session.id };
}

async function createSubscriptionCheckout({ booking, returnTo }) {
  const meta = bookingMeta(booking);
  const approvalRequired = meta.paymentApprovalRequired === true;
  const approvedAt = safeStr(meta.paymentApprovedAt);

  if (approvalRequired && !approvedAt) {
    return { ok: false, code: "PAYMENT_NOT_APPROVED" };
  }

  if (meta.subscriptionEligible !== true) {
    return { ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" };
  }

  const offer = await loadOffer(booking);
  if (!offer) return { ok: false, code: "OFFER_NOT_FOUND" };
  if (!isSubscriptionOffer(offer)) {
    return { ok: false, code: "NOT_A_SUBSCRIPTION_OFFER" };
  }

  ensureStripeShape(booking);

  const existingUrl = await reuseCheckoutUrl(booking);
  if (existingUrl) {
    return {
      ok: true,
      url: existingUrl,
      sessionId: booking.stripe.checkoutSessionId,
    };
  }

  if (safeStr(booking?.stripe?.subscriptionId)) {
    return { ok: false, code: "SUBSCRIPTION_ALREADY_CREATED" };
  }

  const stripeCustomerId = await getOrCreateStripeCustomer(booking);

  if (needsDeferredWeeklySubscription(booking)) {
    return createDeferredWeeklyCheckout({
      booking,
      offer,
      stripeCustomerId,
      returnTo,
    });
  }

  return createNormalSubscriptionCheckout({
    booking,
    offer,
    stripeCustomerId,
    returnTo,
  });
}

module.exports = { createSubscriptionCheckout };

// "use strict";

// const { stripeClient } = require("./stripeClient");
// const { successUrl, cancelUrl } = require("./env");
// const { moneyCents } = require("./money");
// const { safeStr, safeUrl } = require("./strings");
// const { ensureStripeShape } = require("./bookingStripe");
// const { loadOffer, isSubscriptionOffer, displayName } = require("./offer");
// const { metaForBooking, stripeDescriptionLines } = require("./meta");
// const { getOrCreateStripeCustomer } = require("./stripeCustomer");

// function bookingMeta(booking) {
//   return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
// }

// function startOfNextMonth(dateValue) {
//   const base = dateValue ? new Date(dateValue) : new Date();
//   const year = base.getUTCFullYear();
//   const month = base.getUTCMonth();
//   return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
// }

// function firstMonthAmount(booking) {
//   return typeof booking?.priceFirstMonth === "number"
//     ? booking.priceFirstMonth
//     : null;
// }

// function monthlyAmount(booking, offer) {
//   if (typeof booking?.priceMonthly === "number") return booking.priceMonthly;
//   if (typeof offer?.price === "number") return offer.price;
//   return null;
// }

// function needsProratedStart(booking) {
//   return typeof booking?.priceFirstMonth === "number";
// }

// function initialOneTimeLineItem(booking, offer) {
//   const first = firstMonthAmount(booking);
//   const cents = moneyCents(first);
//   if (!cents) return null;

//   return {
//     quantity: 1,
//     price_data: {
//       currency: "eur",
//       unit_amount: cents,
//       product_data: {
//         name: `${displayName(booking, offer)} · Erstmonat`,
//         description: stripeDescriptionLines(booking, offer),
//       },
//     },
//   };
// }

// function recurringLineItem(booking, offer) {
//   const monthly = monthlyAmount(booking, offer);
//   const cents = moneyCents(monthly);
//   if (!cents) return null;

//   return {
//     quantity: 1,
//     price_data: {
//       currency: "eur",
//       unit_amount: cents,
//       recurring: { interval: "month" },
//       product_data: {
//         name: displayName(booking, offer),
//         description: stripeDescriptionLines(booking, offer),
//       },
//     },
//   };
// }

// async function reuseCheckoutUrl(booking) {
//   const sid = safeStr(booking?.stripe?.checkoutSessionId);
//   if (!sid) return "";
//   const stripe = stripeClient();
//   const session = await stripe.checkout.sessions.retrieve(sid);
//   return safeStr(session?.url);
// }

// async function createSubscriptionCheckout({ booking, returnTo }) {
//   const meta = bookingMeta(booking);
//   const approvalRequired = meta.paymentApprovalRequired === true;
//   const approvedAt = safeStr(meta.paymentApprovedAt);

//   if (approvalRequired && !approvedAt) {
//     return { ok: false, code: "PAYMENT_NOT_APPROVED" };
//   }

//   if (meta.subscriptionEligible !== true) {
//     return { ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" };
//   }

//   const offer = await loadOffer(booking);
//   if (!offer) return { ok: false, code: "OFFER_NOT_FOUND" };
//   if (!isSubscriptionOffer(offer)) {
//     return { ok: false, code: "NOT_A_SUBSCRIPTION_OFFER" };
//   }

//   ensureStripeShape(booking);

//   const existingUrl = await reuseCheckoutUrl(booking);
//   if (existingUrl) {
//     return {
//       ok: true,
//       url: existingUrl,
//       sessionId: booking.stripe.checkoutSessionId,
//     };
//   }

//   if (safeStr(booking?.stripe?.subscriptionId)) {
//     return { ok: false, code: "SUBSCRIPTION_ALREADY_CREATED" };
//   }

//   const recurring = recurringLineItem(booking, offer);
//   if (!recurring) return { ok: false, code: "INVALID_AMOUNT" };

//   const stripeCustomerId = await getOrCreateStripeCustomer(booking);
//   const stripe = stripeClient();
//   const metadata = metaForBooking(booking);

//   const rt = safeUrl(returnTo);
//   const okUrl = rt
//     ? `${rt}${rt.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`
//     : successUrl();
//   const cancel = rt || cancelUrl();

//   const lineItems = [recurring];
//   const subscriptionData = { metadata };

//   if (needsProratedStart(booking)) {
//     const oneTime = initialOneTimeLineItem(booking, offer);
//     if (oneTime) lineItems.unshift(oneTime);

//     subscriptionData.billing_cycle_anchor = Math.floor(
//       startOfNextMonth(booking?.date).getTime() / 1000,
//     );
//     // subscriptionData.proration_behavior = "none";
//   }

//   console.log("[stripe subscription checkout payload]", {
//     bookingId: String(booking?._id || ""),
//     hasProratedStart: needsProratedStart(booking),
//     priceFirstMonth: booking?.priceFirstMonth,
//     priceMonthly: booking?.priceMonthly,
//     billingCycleAnchor: subscriptionData.billing_cycle_anchor || null,
//     prorationBehavior: subscriptionData.proration_behavior || null,
//     lineItems: lineItems.map((item) => ({
//       recurring: !!item?.price_data?.recurring,
//       unitAmount: item?.price_data?.unit_amount,
//       name: item?.price_data?.product_data?.name,
//     })),
//   });
//   const session = await stripe.checkout.sessions.create({
//     mode: "subscription",
//     success_url: okUrl,
//     cancel_url: cancel,
//     customer: stripeCustomerId || undefined,
//     customer_email: stripeCustomerId
//       ? undefined
//       : safeStr(booking.email).toLowerCase() || undefined,
//     payment_method_types: ["sepa_debit", "card"],
//     metadata,
//     subscription_data: subscriptionData,
//     line_items: lineItems,
//   });

//   booking.stripe.mode = "subscription";
//   booking.stripe.checkoutSessionId = session.id;
//   booking.paymentStatus = "open";
//   await booking.save();

//   return { ok: true, url: session.url, sessionId: session.id };
// }

// module.exports = { createSubscriptionCheckout };

// //routes\payments\stripe\lib\createSubscriptionCheckout.js
// "use strict";

// const { stripeClient } = require("./stripeClient");
// const { successUrl, cancelUrl } = require("./env");
// const { moneyCents } = require("./money");
// const { safeStr, safeUrl } = require("./strings");
// const { ensureStripeShape } = require("./bookingStripe");
// const { loadOffer, isSubscriptionOffer, displayName } = require("./offer");
// const { metaForBooking, stripeDescriptionLines } = require("./meta");
// const { getOrCreateStripeCustomer } = require("./stripeCustomer");

// function bookingMeta(booking) {
//   return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
// }

// function startOfNextMonth(dateValue) {
//   const base = dateValue ? new Date(dateValue) : new Date();
//   const year = base.getUTCFullYear();
//   const month = base.getUTCMonth();
//   return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
// }

// function firstMonthAmount(booking) {
//   return typeof booking?.priceFirstMonth === "number"
//     ? booking.priceFirstMonth
//     : null;
// }

// function monthlyAmount(booking, offer) {
//   if (typeof booking?.priceMonthly === "number") return booking.priceMonthly;
//   if (typeof offer?.price === "number") return offer.price;
//   return null;
// }

// function needsProratedStart(booking) {
//   return typeof booking?.priceFirstMonth === "number";
// }

// function initialOneTimeLineItem(booking, offer) {
//   const first = firstMonthAmount(booking);
//   const cents = moneyCents(first);
//   if (!cents) return null;

//   return {
//     quantity: 1,
//     price_data: {
//       currency: "eur",
//       unit_amount: cents,
//       product_data: {
//         name: `${displayName(booking, offer)} · Erstmonat`,
//         description: stripeDescriptionLines(booking, offer),
//       },
//     },
//   };
// }

// function recurringLineItem(booking, offer) {
//   const monthly = monthlyAmount(booking, offer);
//   const cents = moneyCents(monthly);
//   if (!cents) return null;

//   return {
//     quantity: 1,
//     price_data: {
//       currency: "eur",
//       unit_amount: cents,
//       recurring: { interval: "month" },
//       product_data: {
//         name: displayName(booking, offer),
//         description: stripeDescriptionLines(booking, offer),
//       },
//     },
//   };
// }

// async function reuseCheckoutUrl(booking) {
//   const sid = safeStr(booking?.stripe?.checkoutSessionId);
//   if (!sid) return "";
//   const stripe = stripeClient();
//   const s = await stripe.checkout.sessions.retrieve(sid);
//   return safeStr(s?.url);
// }

// async function createSubscriptionCheckout({ booking, returnTo }) {
//   const meta = bookingMeta(booking);
//   const approvalRequired = meta.paymentApprovalRequired === true;
//   const approvedAt = safeStr(meta.paymentApprovedAt);

//   if (approvalRequired && !approvedAt) {
//     return { ok: false, code: "PAYMENT_NOT_APPROVED" };
//   }

//   if (meta.subscriptionEligible !== true) {
//     return { ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" };
//   }

//   const offer = await loadOffer(booking);
//   if (!offer) return { ok: false, code: "OFFER_NOT_FOUND" };
//   if (!isSubscriptionOffer(offer)) {
//     return { ok: false, code: "NOT_A_SUBSCRIPTION_OFFER" };
//   }

//   ensureStripeShape(booking);

//   const existingUrl = await reuseCheckoutUrl(booking);
//   if (existingUrl) {
//     return {
//       ok: true,
//       url: existingUrl,
//       sessionId: booking.stripe.checkoutSessionId,
//     };
//   }

//   if (safeStr(booking?.stripe?.subscriptionId)) {
//     return { ok: false, code: "SUBSCRIPTION_ALREADY_CREATED" };
//   }

//   const recurring = recurringLineItem(booking, offer);
//   if (!recurring) return { ok: false, code: "INVALID_AMOUNT" };

//   const stripeCustomerId = await getOrCreateStripeCustomer(booking);
//   const stripe = stripeClient();
//   const m = metaForBooking(booking);

//   const rt = safeUrl(returnTo);
//   const okUrl = rt
//     ? `${rt}${rt.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`
//     : successUrl();
//   const cancel = rt || cancelUrl();

//   const lineItems = [recurring];
//   const subscriptionData = { metadata: m };

//   // if (needsProratedStart(booking)) {
//   //   const oneTime = initialOneTimeLineItem(booking, offer);
//   //   if (oneTime) lineItems.unshift(oneTime);
//   //   subscriptionData.trial_end = Math.floor(
//   //     startOfNextMonth(booking?.date).getTime() / 1000,
//   //   );
//   // }

//   if (needsProratedStart(booking)) {
//     const oneTime = initialOneTimeLineItem(booking, offer);
//     if (oneTime) lineItems.unshift(oneTime);

//     subscriptionData.billing_cycle_anchor = Math.floor(
//       startOfNextMonth(booking?.date).getTime() / 1000,
//     );
//     subscriptionData.proration_behavior = "none";
//   }

//   const session = await stripe.checkout.sessions.create({
//     mode: "subscription",
//     success_url: okUrl,
//     cancel_url: cancel,
//     customer: stripeCustomerId || undefined,
//     customer_email: stripeCustomerId
//       ? undefined
//       : safeStr(booking.email).toLowerCase() || undefined,
//     payment_method_types: ["sepa_debit", "card"],
//     metadata: m,
//     subscription_data: subscriptionData,
//     line_items: lineItems,
//   });

//   booking.stripe.mode = "subscription";
//   booking.stripe.checkoutSessionId = session.id;
//   booking.paymentStatus = "open";
//   await booking.save();

//   return { ok: true, url: session.url, sessionId: session.id };
// }

// module.exports = { createSubscriptionCheckout };

// //routes\payments\stripe\lib\createSubscriptionCheckout.js
// "use strict";

// const { stripeClient } = require("./stripeClient");
// const { successUrl, cancelUrl } = require("./env");
// const { moneyCents } = require("./money");
// const { safeStr, safeUrl } = require("./strings");
// const { ensureStripeShape } = require("./bookingStripe");
// const { loadOffer, isSubscriptionOffer, displayName } = require("./offer");
// //const { metaForBooking } = require("./meta");
// const { getOrCreateStripeCustomer } = require("./stripeCustomer");

// const { metaForBooking, stripeDescriptionLines } = require("./meta");

// function bookingMeta(booking) {
//   return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
// }

// async function reuseCheckoutUrl(booking) {
//   const sid = safeStr(booking?.stripe?.checkoutSessionId);
//   if (!sid) return "";
//   const stripe = stripeClient();
//   const s = await stripe.checkout.sessions.retrieve(sid);
//   return safeStr(s?.url);
// }

// async function createSubscriptionCheckout({ booking, returnTo }) {
//   const meta = bookingMeta(booking);
//   const approvalRequired = meta.paymentApprovalRequired === true;
//   const approvedAt = safeStr(meta.paymentApprovedAt);

//   if (approvalRequired && !approvedAt)
//     return { ok: false, code: "PAYMENT_NOT_APPROVED" };
//   if (meta.subscriptionEligible !== true)
//     return { ok: false, code: "SUBSCRIPTION_NOT_ALLOWED" };

//   const offer = await loadOffer(booking);
//   if (!offer) return { ok: false, code: "OFFER_NOT_FOUND" };
//   if (!isSubscriptionOffer(offer))
//     return { ok: false, code: "NOT_A_SUBSCRIPTION_OFFER" };

//   ensureStripeShape(booking);

//   const existingUrl = await reuseCheckoutUrl(booking);
//   if (existingUrl)
//     return {
//       ok: true,
//       url: existingUrl,
//       sessionId: booking.stripe.checkoutSessionId,
//     };

//   if (safeStr(booking?.stripe?.subscriptionId)) {
//     return { ok: false, code: "SUBSCRIPTION_ALREADY_CREATED" };
//   }

//   const monthly =
//     typeof booking.priceMonthly === "number"
//       ? booking.priceMonthly
//       : offer.price;
//   const cents = moneyCents(monthly);
//   if (!cents) return { ok: false, code: "INVALID_AMOUNT" };

//   const stripeCustomerId = await getOrCreateStripeCustomer(booking);
//   const stripe = stripeClient();
//   const m = metaForBooking(booking);

//   const rt = safeUrl(returnTo);
//   const okUrl = rt
//     ? `${rt}${rt.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`
//     : successUrl();
//   const cancel = rt || cancelUrl();

//   const session = await stripe.checkout.sessions.create({
//     mode: "subscription",
//     success_url: okUrl,
//     cancel_url: cancel,
//     customer: stripeCustomerId || undefined,
//     customer_email: stripeCustomerId
//       ? undefined
//       : safeStr(booking.email).toLowerCase() || undefined,
//     payment_method_types: ["sepa_debit", "card"],
//     metadata: m,
//     subscription_data: { metadata: m },
//     line_items: [
//       {
//         quantity: 1,
//         price_data: {
//           currency: "eur",
//           unit_amount: cents,
//           recurring: { interval: "month" },
//           //  product_data: { name: displayName(booking, offer) },
//           product_data: {
//             name: displayName(booking, offer),
//             description: stripeDescriptionLines(booking, offer),
//           },
//         },
//       },
//     ],
//   });

//   booking.stripe.mode = "subscription";
//   booking.stripe.checkoutSessionId = session.id;
//   booking.paymentStatus = "open";
//   await booking.save();

//   return { ok: true, url: session.url, sessionId: session.id };
// }

// module.exports = { createSubscriptionCheckout };
