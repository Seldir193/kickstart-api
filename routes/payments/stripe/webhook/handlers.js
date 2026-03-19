//routes\payments\stripe\webhook\handlers.js
"use strict";

const crypto = require("crypto");
const Booking = require("../../../../models/Booking");
const {
  createHolidayInvoiceForBooking,
} = require("../../../../utils/holidayInvoices");
const {
  sendBookingConfirmedEmail,
  sendParticipationEmail,
  sendWeeklySubscriptionActiveEmail,
} = require("../../../../utils/mailer");
const { assignInvoiceData } = require("../../../../utils/billing");
const { safeStr } = require("../lib/strings");
const { ensureStripeShape, ensureMeta } = require("../lib/bookingStripe");
const {
  loadOffer,
  isHolidayOffer,
  isPowertrainingOffer,
} = require("../lib/offer");
const {
  findBookingByMetadata,
  findBookingForInvoice,
} = require("../lib/findBooking");
const { ensureCustomerForPaidBooking } = require("../lib/customerSync");
const {
  createOneTimeInvoiceForBooking,
} = require("../../../../utils/oneTimeInvoices");
const {
  createCancelTokenPair,
  buildCancelUrl,
} = require("../lib/subscriptionCancelToken");
const { getOrCreateStripeCustomer } = require("../lib/stripeCustomer");

const {
  createWeeklyRecurringInvoiceForBooking,
} = require("../../../../utils/weeklyRecurringInvoices");

// const {
//   createWeeklyRecurringInvoiceForBooking,
// } = require("../../../../utils/weeklyRecurringInvoices");

function weeklyEmailSent(booking) {
  const meta = booking?.meta;
  const v =
    meta && typeof meta === "object"
      ? String(meta.weeklyParticipationEmailSentAt || "").trim()
      : "";
  return !!v;
}

function weeklyMailRecipient(booking, customer) {
  const bookingParentEmail = safeStr(booking?.invoiceTo?.parent?.email);
  const bookingEmail = safeStr(booking?.email);
  const customerParentEmail = safeStr(customer?.parent?.email);
  const customerEmail = safeStr(customer?.email);

  return (
    bookingParentEmail || bookingEmail || customerParentEmail || customerEmail
  );
}

function weeklyMailCustomerSnapshot(customer, booking, recipientEmail) {
  if (!customer) return null;

  const bookingParent = booking?.invoiceTo?.parent || {};
  const currentParent = customer?.parent || {};

  return {
    ...customer,
    parent: {
      salutation:
        safeStr(bookingParent?.salutation) ||
        safeStr(currentParent?.salutation),
      firstName:
        safeStr(bookingParent?.firstName) || safeStr(currentParent?.firstName),
      lastName:
        safeStr(bookingParent?.lastName) || safeStr(currentParent?.lastName),
      email: recipientEmail,
      phone: safeStr(bookingParent?.phone) || safeStr(currentParent?.phone),
      phone2: safeStr(bookingParent?.phone2) || safeStr(currentParent?.phone2),
    },
    email: recipientEmail,
    emailLower: recipientEmail,
  };
}

// function nextMonthAnchorFromBooking(booking) {
//   const base = booking?.date ? new Date(booking.date) : new Date();
//   return new Date(
//     Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0),
//   );
// }

// function nextMonthAnchorFromBooking(booking) {
//   const bookingBase = booking?.date ? new Date(booking.date) : new Date();
//   const now = new Date();
//   const reference = bookingBase > now ? bookingBase : now;

//   return new Date(
//     Date.UTC(
//       reference.getUTCFullYear(),
//       reference.getUTCMonth() + 1,
//       1,
//       0,
//       0,
//       0,
//     ),
//   );
// }

async function referenceNowForStripeCustomer(stripe, stripeCustomerId) {
  const realNow = new Date();

  if (!stripeCustomerId) return realNow;

  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const clockId = safeStr(customer?.test_clock);

    if (!clockId) return realNow;

    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    const frozen = Number(clock?.frozen_time);

    if (!Number.isFinite(frozen) || frozen <= 0) return realNow;

    return new Date(frozen * 1000);
  } catch (e) {
    console.warn("[weekly deferred] clock lookup failed", {
      stripeCustomerId,
      message: e?.message || e,
    });
    return realNow;
  }
}

function nextMonthAnchorFromReference(booking, referenceNow) {
  const bookingBase = booking?.date ? new Date(booking.date) : null;
  const now = referenceNow instanceof Date ? referenceNow : new Date();

  const bookingValid =
    bookingBase instanceof Date && !Number.isNaN(bookingBase.getTime());

  const base = bookingValid && bookingBase > now ? bookingBase : now;

  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0),
  );
}

// function nextMonthAnchorFromBooking(booking) {
//   const bookingBase = booking?.date ? new Date(booking.date) : null;
//   const now = new Date();
//   const base =
//     bookingBase && !Number.isNaN(bookingBase.getTime()) && bookingBase > now
//       ? bookingBase
//       : now;

//   return new Date(
//     Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0),
//   );
// }

function monthlyPriceFromBooking(booking, offer) {
  if (typeof booking?.priceMonthly === "number") return booking.priceMonthly;
  if (typeof offer?.price === "number") return offer.price;
  return null;
}

async function ensureDeferredWeeklySubscription(booking, offer) {
  try {
    const meta = ensureMeta(booking);

    console.log("[weekly deferred] ensure subscription enter", {
      bookingId: String(booking?._id || ""),
      existingSubscriptionId: safeStr(booking?.stripe?.subscriptionId),
      deferredCreatedAt: safeStr(meta.deferredWeeklySubscriptionCreatedAt),
      paymentIntentId: safeStr(booking?.stripe?.paymentIntentId),
      bookingCustomerId: String(booking?.customerId || ""),
      priceMonthly: booking?.priceMonthly,
      offerCategory: safeStr(offer?.category),
    });

    if (safeStr(booking?.stripe?.subscriptionId)) return;
    if (safeStr(meta.deferredWeeklySubscriptionCreatedAt)) return;

    const monthly = monthlyPriceFromBooking(booking, offer);
    const monthlyCents =
      typeof monthly === "number" ? Math.round(monthly * 100) : 0;

    if (!monthlyCents) {
      console.log("[weekly deferred] skip: missing monthly cents", {
        bookingId: String(booking?._id || ""),
        monthly,
      });
      return;
    }

    const stripeCustomerId = await getOrCreateStripeCustomer(booking);

    if (!stripeCustomerId) {
      console.log("[weekly deferred] skip: missing stripe customer", {
        bookingId: String(booking?._id || ""),
        bookingCustomerId: String(booking?.customerId || ""),
      });
      return;
    }

    const paymentIntentId = safeStr(booking?.stripe?.paymentIntentId);
    if (!paymentIntentId) {
      console.log("[weekly deferred] skip: missing payment intent", {
        bookingId: String(booking?._id || ""),
      });
      return;
    }

    const stripe = require("../lib/stripeClient").stripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const paymentMethodId = safeStr(paymentIntent?.payment_method);

    if (!paymentMethodId) {
      console.log("[weekly deferred] skip: missing payment method", {
        bookingId: String(booking?._id || ""),
        paymentIntentId,
      });
      return;
    }

    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    const referenceNow = await referenceNowForStripeCustomer(
      stripe,
      stripeCustomerId,
    );

    const anchorDate = nextMonthAnchorFromReference(booking, referenceNow);

    console.log("[weekly deferred] anchor debug", {
      bookingId: String(booking?._id || ""),
      bookingDate: booking?.date || "",
      referenceNowIso: referenceNow.toISOString(),
      anchorIso: anchorDate.toISOString(),
      stripeCustomerId,
    });

    const billingCycleAnchor = Math.floor(anchorDate.getTime() / 1000);

    // const billingCycleAnchor = Math.floor(
    //   nextMonthAnchorFromBooking(booking).getTime() / 1000,
    // );

    console.log("[weekly deferred] creating subscription", {
      bookingId: String(booking?._id || ""),
      stripeCustomerId,
      paymentMethodId,
      monthlyCents,
      billingCycleAnchor,
    });

    const product = await stripe.products.create({
      name:
        safeStr(booking?.offerTitle) ||
        safeStr(offer?.title) ||
        "Weekly Subscription",
    });

    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      default_payment_method: paymentMethodId,
      billing_cycle_anchor: billingCycleAnchor,
      proration_behavior: "none",
      collection_method: "charge_automatically",
      metadata: {
        bookingId: String(booking._id || ""),
        ownerId: String(booking.owner || ""),
        offerId: String(booking.offerId || ""),
        customerId: String(booking.customerId || ""),
        invoiceNo: String(booking.invoiceNo || booking.invoiceNumber || ""),
      },
      items: [
        // {
        //   price_data: {
        //     currency: "eur",
        //     unit_amount: monthlyCents,
        //     recurring: { interval: "month" },
        //     product_data: {
        //       name: safeStr(booking?.offerTitle) || safeStr(offer?.title),
        //     },
        //   },
        {
          price_data: {
            currency: "eur",
            unit_amount: monthlyCents,
            recurring: { interval: "month" },
            product: product.id,
          },
        },
      ],
    });

    booking.stripe.mode = "subscription";
    booking.stripe.subscriptionId = safeStr(subscription?.id);
    booking.stripe.subStatus = safeStr(subscription?.status);
    meta.deferredWeeklySubscriptionCreatedAt = new Date().toISOString();
    booking.markModified("meta");
    await booking.save();
  } catch (e) {
    console.error("[weekly deferred] create subscription failed", {
      type: e?.type,
      code: e?.code,
      message: e?.message,
      raw: e,
    });
    throw e;
  }
}

async function markEvent(booking, event) {
  ensureStripeShape(booking);
  booking.stripe.lastEventId = String(event?.id || "");
  booking.stripe.lastEventType = String(event?.type || "");
  await booking.save();
}

function handled(booking, event) {
  return safeStr(booking?.stripe?.lastEventId) === String(event?.id || "");
}

async function ensureWeeklyInvoiceNo(booking, offer) {
  const hasNo = safeStr(booking?.invoiceNumber) || safeStr(booking?.invoiceNo);
  if (hasNo) return;

  const providerId = String(booking?.owner || "1").trim() || "1";
  await assignInvoiceData({ booking, offer, providerId });
  await booking.save();
}

async function ensureSubscriptionCancelLink(booking) {
  const hasHash = safeStr(booking?.subscriptionCancelTokenHash);
  const hasExp = booking?.subscriptionCancelTokenExpires;

  if (hasHash && hasExp) {
    return { created: false, cancelUrl: "" };
  }

  const { rawToken, tokenHash } = createCancelTokenPair();

  booking.subscriptionCancelTokenHash = tokenHash;
  booking.subscriptionCancelTokenExpires = new Date(
    Date.now() + 1000 * 60 * 60 * 24 * 30,
  );

  await booking.save();

  return {
    created: true,
    cancelUrl: buildCancelUrl(rawToken),
  };
}

function isAdminPowertrainingBooking(booking, offer) {
  const source = safeStr(booking?.source);
  const text = [
    safeStr(offer?.category),
    safeStr(offer?.sub_type),
    safeStr(offer?.type),
    safeStr(offer?.title),
    safeStr(booking?.offerType),
    safeStr(booking?.offerTitle),
    safeStr(booking?.message),
    safeStr(booking?.meta?.holidayType),
  ]
    .join(" ")
    .toLowerCase();

  return (
    source === "admin_booking" &&
    (text.includes("powertraining") || text.includes("power training"))
  );
}

async function confirmAfterPayment(booking, offer, isNonTrial, skipEmail) {
  const wasAlreadyConfirmed =
    booking.status === "confirmed" || !!booking.confirmedAt;

  if (!booking.confirmationCode) {
    booking.confirmationCode =
      "KS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  }

  if (booking.status === "pending" || booking.status === "processing") {
    booking.status = "confirmed";
    booking.confirmedAt = booking.confirmedAt || new Date();
  }

  await booking.save();

  if (skipEmail || wasAlreadyConfirmed) return;

  await sendBookingConfirmedEmail({
    to: booking.email,
    booking,
    offer,
    isNonTrial,
  }).catch(() => {});
}

async function handleWeeklyMail(booking, offer, event, cancelUrl = "") {
  if (weeklyEmailSent(booking)) return void (await markEvent(booking, event));

  if (offer) await ensureWeeklyInvoiceNo(booking, offer);

  const offerFallback = offer || {
    category: "Weekly",
    type: safeStr(booking?.offerType) || "Foerdertraining",
    sub_type: safeStr(booking?.offerType) || "Foerdertraining",
    title: safeStr(booking?.offerTitle) || safeStr(booking?.offerType),
    location: safeStr(booking?.venue) || "",
    price:
      typeof booking?.priceMonthly === "number"
        ? booking.priceMonthly
        : undefined,
  };

  const customerDoc = await ensureCustomerForPaidBooking(
    booking,
    offerFallback,
  );

  const rawCustomer = customerDoc
    ? customerDoc.toObject
      ? customerDoc.toObject()
      : customerDoc
    : null;

  const to = weeklyMailRecipient(booking, rawCustomer);

  if (!to) return void (await markEvent(booking, event));

  const customer = weeklyMailCustomerSnapshot(rawCustomer, booking, to);

  await sendParticipationEmail({
    to,
    customer,
    booking,
    offer: offerFallback,
  });

  if (cancelUrl) {
    await sendWeeklySubscriptionActiveEmail({
      to,
      booking,
      offer: offerFallback,
      cancelUrl,
    }).catch(() => {});
  }

  ensureMeta(booking).weeklyParticipationEmailSentAt = new Date().toISOString();
  await booking.save();
  await markEvent(booking, event);
}

async function onCheckoutCompleted(event, session) {
  const booking = await findBookingByMetadata(session);
  if (!booking) return;

  ensureStripeShape(booking);

  if (handled(booking, event) && weeklyEmailSent(booking)) return;

  booking.stripe.checkoutSessionId ||= safeStr(session.id);
  booking.stripe.paymentIntentId =
    safeStr(session.payment_intent) || booking.stripe.paymentIntentId;

  const offer = await loadOffer(booking);
  const ps = String(session.payment_status || "");
  const mode = String(session.mode || "");

  if (mode === "subscription") {
    return await onCheckoutSubPaid(booking, offer, ps, session, event);
  }

  return await onCheckoutOneTimePaid(booking, offer, ps, event);
}

async function onCheckoutSubPaid(booking, offer, ps, session, event) {
  booking.stripe.mode = "subscription";
  booking.stripe.subscriptionId = safeStr(session.subscription);

  if (ps === "paid") {
    booking.paymentStatus = "paid";
    booking.paidAt ||= new Date();
    booking.returnedAt = null;
    await booking.save();

    await ensureCustomerForPaidBooking(booking, offer);

    const tokenData = await ensureSubscriptionCancelLink(booking);
    await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
    return;
  }

  await markEvent(booking, event);
}

async function onCheckoutOneTimePaid(booking, offer, ps, event) {
  booking.stripe.mode = "payment";

  if (ps !== "paid") {
    return void (await markEvent(booking, event));
  }

  booking.paymentStatus = "paid";
  booking.paidAt ||= new Date();
  booking.returnedAt = null;
  await booking.save();

  await ensureCustomerForPaidBooking(booking, offer);

  console.log("[weekly deferred] after payment", {
    bookingId: String(booking?._id || ""),
    paymentStatus: booking?.paymentStatus,
    stripeMode: booking?.stripe?.mode,
    paymentIntentId: booking?.stripe?.paymentIntentId,
    deferredWeeklySubscription: booking?.meta?.deferredWeeklySubscription,
  });

  // const deferredWeekly =
  //   safeStr(booking?.meta?.deferredWeeklySubscription) === "true";

  // const deferredWeekly =
  //   safeStr(booking?.meta?.deferredWeeklySubscription) === "true" ||
  //   safeStr(event?.data?.object?.metadata?.deferredWeeklySubscription) ===
  //     "true";

  const sessionMeta = event?.data?.object?.metadata || {};
  const offerCategory = safeStr(offer?.category);
  const deferredWeekly =
    safeStr(booking?.meta?.deferredWeeklySubscription) === "true" ||
    safeStr(sessionMeta?.deferredWeeklySubscription) === "true" ||
    (safeStr(booking?.stripe?.mode) === "payment" &&
      typeof booking?.priceFirstMonth === "number" &&
      typeof booking?.priceMonthly === "number" &&
      offerCategory === "Weekly");

  console.log("[weekly deferred] decision", {
    bookingId: String(booking?._id || ""),
    offerCategory,
    stripeMode: safeStr(booking?.stripe?.mode),
    priceFirstMonth: booking?.priceFirstMonth,
    priceMonthly: booking?.priceMonthly,
    bookingMetaDeferred: booking?.meta?.deferredWeeklySubscription,
    sessionMetaDeferred: sessionMeta?.deferredWeeklySubscription,
    deferredWeekly,
  });

  // if (deferredWeekly) {
  //   await ensureDeferredWeeklySubscription(booking, offer);
  //   const tokenData = await ensureSubscriptionCancelLink(booking);
  //   await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
  //   return;
  // }

  if (deferredWeekly) {
    try {
      await ensureDeferredWeeklySubscription(booking, offer);
    } catch (e) {
      console.error("[weekly deferred] subscription setup failed", {
        bookingId: String(booking?._id || ""),
        message: e?.message || e,
      });
    }

    const tokenData = await ensureSubscriptionCancelLink(booking);
    await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
    return;
  }

  const isHoliday = offer ? isHolidayOffer(offer) : false;
  const isPower = offer ? isPowertrainingOffer(offer) : false;

  const isAdminBooking = safeStr(booking?.source) === "admin_booking";
  const confirmCat = safeStr(offer?.category);
  const confirmSub = safeStr(offer?.sub_type);

  const isClubProgram =
    confirmCat === "ClubPrograms" ||
    confirmCat === "RentACoach" ||
    /^RentACoach/i.test(confirmSub) ||
    /CoachEducation/i.test(confirmSub) ||
    /Trainings?Camp/i.test(confirmSub);

  const skipConfirmEmail =
    isAdminPowertrainingBooking(booking, offer) ||
    (isAdminBooking &&
      !isClubProgram &&
      !!safeStr(booking?.meta?.paymentApprovedAt));

  await confirmAfterPayment(booking, offer, false, skipConfirmEmail);

  if (isHoliday || isPower) {
    const meta = ensureMeta(booking);
    const alreadyInvoiced =
      !!safeStr(booking.invoiceNumber) || !!safeStr(booking.invoiceNo);

    const done =
      alreadyInvoiced ||
      !!safeStr(meta.holidayInvoiceCreatedAt) ||
      !!safeStr(meta.holidayParticipationEmailSentAt);

    if (!done) {
      await createHolidayInvoiceForBooking({
        ownerId: String(booking.owner || "").trim(),
        offer,
        booking,
        payload: {},
      }).catch(() => {});

      meta.holidayInvoiceCreatedAt = new Date().toISOString();
      await booking.save();
    }
  }

  const cat = safeStr(offer?.category);
  const sub = safeStr(offer?.sub_type);

  const isClub =
    cat === "ClubPrograms" ||
    cat === "RentACoach" ||
    /^RentACoach/i.test(sub) ||
    /CoachEducation/i.test(sub) ||
    /Trainings?Camp/i.test(sub);

  const isIndividualCat = cat === "Individual";

  if (isClub || isIndividualCat) {
    const meta = ensureMeta(booking);
    const alreadyInvoiced =
      !!safeStr(booking.invoiceNumber) || !!safeStr(booking.invoiceNo);

    const alreadySent = !!safeStr(meta.oneTimeParticipationEmailSentAt);

    if (!alreadyInvoiced || !alreadySent) {
      await createOneTimeInvoiceForBooking({
        ownerId: String(booking.owner || "").trim(),
        offer,
        booking,
      }).catch((e) => {
        // console.error(
        //   "[stripe:webhook] createOneTimeInvoiceForBooking failed:",
        //   e?.message || e,
        // );
        console.error("[weekly deferred] create subscription failed", {
          type: e?.type,
          code: e?.code,
          message: e?.message,
          raw: e,
        });
        throw e;
      });

      if (!meta.oneTimeInvoiceCreatedAt) {
        meta.oneTimeInvoiceCreatedAt = new Date().toISOString();
      }

      await booking.save();
    }
  }

  await markEvent(booking, event);
}

async function onInvoicePaid(event, invoice) {
  const booking = await findBookingForInvoice(invoice);
  if (!booking) return;

  ensureStripeShape(booking);

  const offer = await loadOffer(booking);
  const subId = safeStr(invoice?.subscription);

  if (subId && !safeStr(booking.stripe.subscriptionId)) {
    booking.stripe.subscriptionId = subId;
  }

  const pi = safeStr(invoice?.payment_intent);

  if (pi && !safeStr(booking.stripe.paymentIntentId)) {
    booking.stripe.paymentIntentId = pi;
  }

  booking.stripe.subStatus = "active";

  const p0 = invoice?.lines?.data?.[0]?.period;
  const cps = Number(p0?.start);
  const cpe = Number(p0?.end);

  if (Number.isFinite(cps)) {
    booking.stripe.currentPeriodStart = new Date(cps * 1000);
  }

  if (Number.isFinite(cpe)) {
    booking.stripe.currentPeriodEnd = new Date(cpe * 1000);
  }

  booking.paymentStatus = "paid";
  booking.paidAt ||= new Date();
  booking.returnedAt = null;

  await booking.save();
  await ensureCustomerForPaidBooking(booking, offer);

  // const billingReason = safeStr(invoice?.billing_reason);
  // const isRecurringCycle =
  //   !!subId && (billingReason === "subscription_cycle" || !billingReason);

  const billingReason = safeStr(invoice?.billing_reason);
  const isRecurringCycle =
    billingReason === "subscription_cycle" || (!!subId && !billingReason);

  console.log("[weekly recurring] invoice paid enter", {
    bookingId: String(booking?._id || ""),
    eventType: safeStr(event?.type),
    stripeInvoiceId: safeStr(invoice?.id),
    subscriptionId: subId,
    billingReason,
    isRecurringCycle,
    currentPeriodStart: booking?.stripe?.currentPeriodStart || null,
    currentPeriodEnd: booking?.stripe?.currentPeriodEnd || null,
  });

  if (isRecurringCycle) {
    const recurring = await createWeeklyRecurringInvoiceForBooking({
      ownerId: String(booking.owner || "").trim(),
      offer,
      booking,
      stripeInvoice: invoice,
    });

    console.log("[weekly recurring] result", {
      bookingId: String(booking?._id || ""),
      stripeInvoiceId: safeStr(invoice?.id),
      created: !!recurring,
      recurringNumber: recurring?.number || "",
    });

    await markEvent(booking, event);
    return;
  }

  if (subId) {
    const tokenData = await ensureSubscriptionCancelLink(booking);
    await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
    return;
  }

  await markEvent(booking, event);
}

// async function onInvoicePaid(event, invoice) {
//   const booking = await findBookingForInvoice(invoice);
//   if (!booking) return;

//   ensureStripeShape(booking);

//   const offer = await loadOffer(booking);
//   const subId = safeStr(invoice?.subscription);

//   if (subId && !safeStr(booking.stripe.subscriptionId)) {
//     booking.stripe.subscriptionId = subId;
//   }

//   const pi = safeStr(invoice?.payment_intent);

//   if (pi && !safeStr(booking.stripe.paymentIntentId)) {
//     booking.stripe.paymentIntentId = pi;
//   }

//   booking.stripe.subStatus = "active";

//   const p0 = invoice?.lines?.data?.[0]?.period;
//   const cps = Number(p0?.start);
//   const cpe = Number(p0?.end);

//   if (Number.isFinite(cps)) {
//     booking.stripe.currentPeriodStart = new Date(cps * 1000);
//   }

//   if (Number.isFinite(cpe)) {
//     booking.stripe.currentPeriodEnd = new Date(cpe * 1000);
//   }

//   booking.paymentStatus = "paid";
//   booking.paidAt ||= new Date();
//   booking.returnedAt = null;

//   await booking.save();
//   await ensureCustomerForPaidBooking(booking, offer);

//   if (subId) {
//     const recurring = await createWeeklyRecurringInvoiceForBooking({
//       ownerId: String(booking.owner || "").trim(),
//       offer,
//       booking,
//       stripeInvoice: invoice,
//     });

//     if (recurring) {
//       await markEvent(booking, event);
//       return;
//     }

//     const tokenData = await ensureSubscriptionCancelLink(booking);
//     await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
//     return;
//   }

//   await markEvent(booking, event);
// }

// async function onInvoicePaid(event, invoice) {
//   const booking = await findBookingForInvoice(invoice);
//   if (!booking) return;

//   ensureStripeShape(booking);

//   const offer = await loadOffer(booking);
//   const subId = safeStr(invoice?.subscription);

//   if (subId && !safeStr(booking.stripe.subscriptionId)) {
//     booking.stripe.subscriptionId = subId;
//   }

//   const pi = safeStr(invoice?.payment_intent);

//   if (pi && !safeStr(booking.stripe.paymentIntentId)) {
//     booking.stripe.paymentIntentId = pi;
//   }

//   booking.stripe.subStatus = "active";

//   const p0 = invoice?.lines?.data?.[0]?.period;
//   const cps = Number(p0?.start);
//   const cpe = Number(p0?.end);

//   if (Number.isFinite(cps)) {
//     booking.stripe.currentPeriodStart = new Date(cps * 1000);
//   }

//   if (Number.isFinite(cpe)) {
//     booking.stripe.currentPeriodEnd = new Date(cpe * 1000);
//   }

//   booking.paymentStatus = "paid";
//   booking.paidAt ||= new Date();
//   booking.returnedAt = null;

//   await booking.save();
//   await ensureCustomerForPaidBooking(booking, offer);

//   if (subId) {
//     const recurring = await createWeeklyRecurringInvoiceForBooking({
//       ownerId: String(booking.owner || "").trim(),
//       offer,
//       booking,
//       stripeInvoice: invoice,
//     });

//     if (recurring) {
//       await markEvent(booking, event);
//       return;
//     }

//     const tokenData = await ensureSubscriptionCancelLink(booking);
//     await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
//     return;
//   }

//   await markEvent(booking, event);
// }

// async function onInvoicePaid(event, invoice) {
//   const booking = await findBookingForInvoice(invoice);
//   if (!booking) return;

//   ensureStripeShape(booking);

//   const offer = await loadOffer(booking);
//   const subId = safeStr(invoice?.subscription);

//   if (subId && !safeStr(booking.stripe.subscriptionId)) {
//     booking.stripe.subscriptionId = subId;
//   }

//   const pi = safeStr(invoice?.payment_intent);

//   if (pi && !safeStr(booking.stripe.paymentIntentId)) {
//     booking.stripe.paymentIntentId = pi;
//   }

//   booking.stripe.subStatus = "active";

//   const p0 = invoice?.lines?.data?.[0]?.period;
//   const cps = Number(p0?.start);
//   const cpe = Number(p0?.end);

//   if (Number.isFinite(cps)) {
//     booking.stripe.currentPeriodStart = new Date(cps * 1000);
//   }

//   if (Number.isFinite(cpe)) {
//     booking.stripe.currentPeriodEnd = new Date(cpe * 1000);
//   }

//   booking.paymentStatus = "paid";
//   booking.paidAt ||= new Date();
//   booking.returnedAt = null;

//   await booking.save();
//   await ensureCustomerForPaidBooking(booking, offer);

//   if (subId) {
//     const tokenData = await ensureSubscriptionCancelLink(booking);
//     await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
//     return;
//   }

//   await markEvent(booking, event);
// }

async function onInvoicePaymentFailed(event, invoice) {
  const subId = safeStr(invoice?.subscription);
  if (!subId) return;

  const booking = await Booking.findOne({ "stripe.subscriptionId": subId });
  if (!booking) return;

  ensureStripeShape(booking);

  if (handled(booking, event)) return;

  booking.stripe.subStatus = "past_due";
  booking.paymentStatus = "open";
  await markEvent(booking, event);
}

async function onSubscriptionUpdated(event, sub) {
  const subId = safeStr(sub?.id);
  if (!subId) return;

  const booking = await Booking.findOne({ "stripe.subscriptionId": subId });
  if (!booking) return;

  ensureStripeShape(booking);

  if (handled(booking, event)) return;

  booking.stripe.subStatus = safeStr(sub?.status);

  const cps = Number(sub?.current_period_start);
  const cpe = Number(sub?.current_period_end);

  if (Number.isFinite(cps)) {
    booking.stripe.currentPeriodStart = new Date(cps * 1000);
  }

  if (Number.isFinite(cpe)) {
    booking.stripe.currentPeriodEnd = new Date(cpe * 1000);
  }

  const cancelAt = Number(sub?.cancel_at);

  if (Number.isFinite(cancelAt) && cancelAt > 0) {
    booking.stripe.cancelEffectiveAt = new Date(cancelAt * 1000);
  }

  await markEvent(booking, event);
}

async function onChargeFailed(event, charge) {
  const pi = safeStr(charge?.payment_intent);
  if (!pi) return;

  const booking = await Booking.findOne({ "stripe.paymentIntentId": pi });
  if (!booking) return;

  ensureStripeShape(booking);

  if (handled(booking, event)) return;

  booking.paymentStatus = "returned";
  booking.returnedAt ||= new Date();
  booking.returnNote =
    safeStr(charge?.failure_message) ||
    safeStr(charge?.failure_code) ||
    booking.returnNote;

  await markEvent(booking, event);
}

module.exports = {
  onCheckoutCompleted,
  onInvoicePaid,
  onInvoicePaymentFailed,
  onSubscriptionUpdated,
  onChargeFailed,
};

// //routes\payments\stripe\webhook\handlers.js
// "use strict";

// const crypto = require("crypto");
// const Booking = require("../../../../models/Booking");
// const {
//   createHolidayInvoiceForBooking,
// } = require("../../../../utils/holidayInvoices");
// const {
//   sendBookingConfirmedEmail,
//   sendParticipationEmail,
//   sendWeeklySubscriptionActiveEmail,
// } = require("../../../../utils/mailer");
// const { assignInvoiceData } = require("../../../../utils/billing");
// const { safeStr } = require("../lib/strings");
// const { ensureStripeShape, ensureMeta } = require("../lib/bookingStripe");
// const {
//   loadOffer,
//   isHolidayOffer,
//   isPowertrainingOffer,
// } = require("../lib/offer");
// const {
//   findBookingByMetadata,
//   findBookingForInvoice,
// } = require("../lib/findBooking");
// const { ensureCustomerForPaidBooking } = require("../lib/customerSync");
// const {
//   createOneTimeInvoiceForBooking,
// } = require("../../../../utils/oneTimeInvoices");
// const {
//   createCancelTokenPair,
//   buildCancelUrl,
// } = require("../lib/subscriptionCancelToken");

// function weeklyEmailSent(booking) {
//   const meta = booking?.meta;
//   const v =
//     meta && typeof meta === "object"
//       ? String(meta.weeklyParticipationEmailSentAt || "").trim()
//       : "";
//   return !!v;
// }

// // function bookingRecipientEmail(booking, customer) {
// //   return (
// //     safeStr(booking?.invoiceTo?.parent?.email) ||
// //     safeStr(booking?.email) ||
// //     safeStr(customer?.parent?.email) ||
// //     safeStr(customer?.email)
// //   );
// // }

// // function bookingParentSnapshot(booking, customer) {
// //   const bookingParent = booking?.invoiceTo?.parent || {};
// //   const customerParent = customer?.parent || {};

// //   return {
// //     salutation:
// //       safeStr(bookingParent?.salutation) ||
// //       safeStr(customerParent?.salutation),
// //     firstName:
// //       safeStr(bookingParent?.firstName) || safeStr(customerParent?.firstName),
// //     lastName:
// //       safeStr(bookingParent?.lastName) || safeStr(customerParent?.lastName),
// //     email: bookingRecipientEmail(booking, customer),
// //     phone: safeStr(bookingParent?.phone) || safeStr(customerParent?.phone),
// //     phone2: safeStr(bookingParent?.phone2) || safeStr(customerParent?.phone2),
// //   };
// // }

// async function markEvent(booking, event) {
//   ensureStripeShape(booking);
//   booking.stripe.lastEventId = String(event?.id || "");
//   booking.stripe.lastEventType = String(event?.type || "");
//   await booking.save();
// }

// function handled(booking, event) {
//   return safeStr(booking?.stripe?.lastEventId) === String(event?.id || "");
// }

// async function ensureWeeklyInvoiceNo(booking, offer) {
//   const hasNo = safeStr(booking?.invoiceNumber) || safeStr(booking?.invoiceNo);
//   if (hasNo) return;

//   const providerId = String(booking?.owner || "1").trim() || "1";
//   await assignInvoiceData({ booking, offer, providerId });
//   await booking.save();
// }

// async function ensureSubscriptionCancelLink(booking) {
//   const hasHash = safeStr(booking?.subscriptionCancelTokenHash);
//   const hasExp = booking?.subscriptionCancelTokenExpires;

//   if (hasHash && hasExp) {
//     return { created: false, cancelUrl: "" };
//   }

//   const { rawToken, tokenHash } = createCancelTokenPair();

//   booking.subscriptionCancelTokenHash = tokenHash;
//   booking.subscriptionCancelTokenExpires = new Date(
//     Date.now() + 1000 * 60 * 60 * 24 * 30,
//   );

//   await booking.save();

//   return {
//     created: true,
//     cancelUrl: buildCancelUrl(rawToken),
//   };
// }

// function isAdminPowertrainingBooking(booking, offer) {
//   const source = safeStr(booking?.source);
//   const text = [
//     safeStr(offer?.category),
//     safeStr(offer?.sub_type),
//     safeStr(offer?.type),
//     safeStr(offer?.title),
//     safeStr(booking?.offerType),
//     safeStr(booking?.offerTitle),
//     safeStr(booking?.message),
//     safeStr(booking?.meta?.holidayType),
//   ]
//     .join(" ")
//     .toLowerCase();

//   return (
//     source === "admin_booking" &&
//     (text.includes("powertraining") || text.includes("power training"))
//   );
// }

// async function confirmAfterPayment(booking, offer, isNonTrial, skipEmail) {
//   const wasAlreadyConfirmed =
//     booking.status === "confirmed" || !!booking.confirmedAt;

//   if (!booking.confirmationCode) {
//     booking.confirmationCode =
//       "KS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
//   }

//   if (booking.status === "pending" || booking.status === "processing") {
//     booking.status = "confirmed";
//     booking.confirmedAt = booking.confirmedAt || new Date();
//   }

//   await booking.save();

//   if (skipEmail || wasAlreadyConfirmed) return;

//   await sendBookingConfirmedEmail({
//     to: booking.email,
//     booking,
//     offer,
//     isNonTrial,
//   }).catch(() => {});
// }

// async function handleWeeklyMail(booking, offer, event, cancelUrl = "") {
//   if (weeklyEmailSent(booking)) return void (await markEvent(booking, event));

//   if (offer) await ensureWeeklyInvoiceNo(booking, offer);

//   const offerFallback = offer || {
//     category: "Weekly",
//     type: safeStr(booking?.offerType) || "Foerdertraining",
//     sub_type: safeStr(booking?.offerType) || "Foerdertraining",
//     title: safeStr(booking?.offerTitle) || safeStr(booking?.offerType),
//     location: safeStr(booking?.venue) || "",
//     price:
//       typeof booking?.priceMonthly === "number"
//         ? booking.priceMonthly
//         : undefined,
//   };

//   const customerDoc = await ensureCustomerForPaidBooking(
//     booking,
//     offerFallback,
//   );

//   const customer = customerDoc
//     ? customerDoc.toObject
//       ? customerDoc.toObject()
//       : customerDoc
//     : null;

//   const to =
//     safeStr(customer?.parent?.email) ||
//     safeStr(customer?.email) ||
//     safeStr(booking?.invoiceTo?.parent?.email) ||
//     safeStr(booking?.email);

//   if (!to) return void (await markEvent(booking, event));

//   await sendParticipationEmail({
//     to,
//     customer,
//     booking,
//     offer: offerFallback,
//   });

//   if (cancelUrl) {
//     await sendWeeklySubscriptionActiveEmail({
//       to,
//       booking,
//       offer: offerFallback,
//       cancelUrl,
//     }).catch(() => {});
//   }

//   ensureMeta(booking).weeklyParticipationEmailSentAt = new Date().toISOString();
//   await booking.save();
//   await markEvent(booking, event);
// }

// async function onCheckoutCompleted(event, session) {
//   const booking = await findBookingByMetadata(session);
//   if (!booking) return;

//   ensureStripeShape(booking);

//   if (handled(booking, event) && weeklyEmailSent(booking)) return;

//   booking.stripe.checkoutSessionId ||= safeStr(session.id);
//   booking.stripe.paymentIntentId =
//     safeStr(session.payment_intent) || booking.stripe.paymentIntentId;

//   const offer = await loadOffer(booking);
//   const ps = String(session.payment_status || "");
//   const mode = String(session.mode || "");

//   if (mode === "subscription") {
//     return await onCheckoutSubPaid(booking, offer, ps, session, event);
//   }

//   return await onCheckoutOneTimePaid(booking, offer, ps, event);
// }

// async function onCheckoutSubPaid(booking, offer, ps, session, event) {
//   booking.stripe.mode = "subscription";
//   booking.stripe.subscriptionId = safeStr(session.subscription);

//   if (ps === "paid") {
//     booking.paymentStatus = "paid";
//     booking.paidAt ||= new Date();
//     booking.returnedAt = null;
//     await booking.save();

//     await ensureCustomerForPaidBooking(booking, offer);

//     const tokenData = await ensureSubscriptionCancelLink(booking);
//     await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
//     return;
//   }

//   await markEvent(booking, event);
// }

// async function onCheckoutOneTimePaid(booking, offer, ps, event) {
//   booking.stripe.mode = "payment";

//   if (ps !== "paid") {
//     return void (await markEvent(booking, event));
//   }

//   booking.paymentStatus = "paid";
//   booking.paidAt ||= new Date();
//   booking.returnedAt = null;
//   await booking.save();

//   await ensureCustomerForPaidBooking(booking, offer);

//   const isHoliday = offer ? isHolidayOffer(offer) : false;
//   const isPower = offer ? isPowertrainingOffer(offer) : false;

//   const isAdminBooking = safeStr(booking?.source) === "admin_booking";
//   const confirmCat = safeStr(offer?.category);
//   const confirmSub = safeStr(offer?.sub_type);

//   const isClubProgram =
//     confirmCat === "ClubPrograms" ||
//     confirmCat === "RentACoach" ||
//     /^RentACoach/i.test(confirmSub) ||
//     /CoachEducation/i.test(confirmSub) ||
//     /Trainings?Camp/i.test(confirmSub);

//   const skipConfirmEmail =
//     isAdminPowertrainingBooking(booking, offer) ||
//     (isAdminBooking &&
//       !isClubProgram &&
//       !!safeStr(booking?.meta?.paymentApprovedAt));

//   await confirmAfterPayment(booking, offer, false, skipConfirmEmail);

//   if (isHoliday || isPower) {
//     const meta = ensureMeta(booking);
//     const alreadyInvoiced =
//       !!safeStr(booking.invoiceNumber) || !!safeStr(booking.invoiceNo);

//     const done =
//       alreadyInvoiced ||
//       !!safeStr(meta.holidayInvoiceCreatedAt) ||
//       !!safeStr(meta.holidayParticipationEmailSentAt);

//     if (!done) {
//       await createHolidayInvoiceForBooking({
//         ownerId: String(booking.owner || "").trim(),
//         offer,
//         booking,
//         payload: {},
//       }).catch(() => {});

//       meta.holidayInvoiceCreatedAt = new Date().toISOString();
//       await booking.save();
//     }
//   }

//   const cat = safeStr(offer?.category);
//   const sub = safeStr(offer?.sub_type);

//   const isClub =
//     cat === "ClubPrograms" ||
//     cat === "RentACoach" ||
//     /^RentACoach/i.test(sub) ||
//     /CoachEducation/i.test(sub) ||
//     /Trainings?Camp/i.test(sub);

//   const isIndividualCat = cat === "Individual";

//   if (isClub || isIndividualCat) {
//     const meta = ensureMeta(booking);
//     const alreadyInvoiced =
//       !!safeStr(booking.invoiceNumber) || !!safeStr(booking.invoiceNo);

//     const alreadySent = !!safeStr(meta.oneTimeParticipationEmailSentAt);

//     if (!alreadyInvoiced || !alreadySent) {
//       await createOneTimeInvoiceForBooking({
//         ownerId: String(booking.owner || "").trim(),
//         offer,
//         booking,
//       }).catch((e) => {
//         console.error(
//           "[stripe:webhook] createOneTimeInvoiceForBooking failed:",
//           e?.message || e,
//         );
//       });

//       if (!meta.oneTimeInvoiceCreatedAt) {
//         meta.oneTimeInvoiceCreatedAt = new Date().toISOString();
//       }

//       await booking.save();
//     }
//   }

//   await markEvent(booking, event);
// }

// async function onInvoicePaid(event, invoice) {
//   const booking = await findBookingForInvoice(invoice);
//   if (!booking) return;

//   ensureStripeShape(booking);

//   const offer = await loadOffer(booking);
//   const subId = safeStr(invoice?.subscription);

//   if (subId && !safeStr(booking.stripe.subscriptionId)) {
//     booking.stripe.subscriptionId = subId;
//   }

//   const pi = safeStr(invoice?.payment_intent);

//   if (pi && !safeStr(booking.stripe.paymentIntentId)) {
//     booking.stripe.paymentIntentId = pi;
//   }

//   booking.stripe.subStatus = "active";

//   const p0 = invoice?.lines?.data?.[0]?.period;
//   const cps = Number(p0?.start);
//   const cpe = Number(p0?.end);

//   if (Number.isFinite(cps)) {
//     booking.stripe.currentPeriodStart = new Date(cps * 1000);
//   }

//   if (Number.isFinite(cpe)) {
//     booking.stripe.currentPeriodEnd = new Date(cpe * 1000);
//   }

//   booking.paymentStatus = "paid";
//   booking.paidAt ||= new Date();
//   booking.returnedAt = null;

//   await booking.save();
//   await ensureCustomerForPaidBooking(booking, offer);

//   if (subId) {
//     const tokenData = await ensureSubscriptionCancelLink(booking);
//     await handleWeeklyMail(booking, offer, event, tokenData.cancelUrl || "");
//     return;
//   }

//   await markEvent(booking, event);
// }

// async function onInvoicePaymentFailed(event, invoice) {
//   const subId = safeStr(invoice?.subscription);
//   if (!subId) return;

//   const booking = await Booking.findOne({ "stripe.subscriptionId": subId });
//   if (!booking) return;

//   ensureStripeShape(booking);

//   if (handled(booking, event)) return;

//   booking.stripe.subStatus = "past_due";
//   booking.paymentStatus = "open";
//   await markEvent(booking, event);
// }

// async function onSubscriptionUpdated(event, sub) {
//   const subId = safeStr(sub?.id);
//   if (!subId) return;

//   const booking = await Booking.findOne({ "stripe.subscriptionId": subId });
//   if (!booking) return;

//   ensureStripeShape(booking);

//   if (handled(booking, event)) return;

//   booking.stripe.subStatus = safeStr(sub?.status);

//   const cps = Number(sub?.current_period_start);
//   const cpe = Number(sub?.current_period_end);

//   if (Number.isFinite(cps)) {
//     booking.stripe.currentPeriodStart = new Date(cps * 1000);
//   }

//   if (Number.isFinite(cpe)) {
//     booking.stripe.currentPeriodEnd = new Date(cpe * 1000);
//   }

//   const cancelAt = Number(sub?.cancel_at);

//   if (Number.isFinite(cancelAt) && cancelAt > 0) {
//     booking.stripe.cancelEffectiveAt = new Date(cancelAt * 1000);
//   }

//   await markEvent(booking, event);
// }

// async function onChargeFailed(event, charge) {
//   const pi = safeStr(charge?.payment_intent);
//   if (!pi) return;

//   const booking = await Booking.findOne({ "stripe.paymentIntentId": pi });
//   if (!booking) return;

//   ensureStripeShape(booking);

//   if (handled(booking, event)) return;

//   booking.paymentStatus = "returned";
//   booking.returnedAt ||= new Date();
//   booking.returnNote =
//     safeStr(charge?.failure_message) ||
//     safeStr(charge?.failure_code) ||
//     booking.returnNote;

//   await markEvent(booking, event);
// }

// module.exports = {
//   onCheckoutCompleted,
//   onInvoicePaid,
//   onInvoicePaymentFailed,
//   onSubscriptionUpdated,
//   onChargeFailed,
// };
