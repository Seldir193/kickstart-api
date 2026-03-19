//routes\payments\stripe\routes\checkoutSession.js
"use strict";

const Booking = require("../../../../models/Booking");
const { childHasActiveWeeklyBooking } = require("../../../../utils/relations");
const { safeStr } = require("../lib/strings");
const {
  loadOffer,
  isSubscriptionOffer,
  isCampOffer,
  requiresWeeklyMembership,
} = require("../lib/offer");
const { createPaymentCheckout } = require("../lib/createPaymentCheckout");
const {
  createSubscriptionCheckout,
} = require("../lib/createSubscriptionCheckout");

function isApproved(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
  if (meta.paymentApprovalRequired !== true) return true;
  return !!safeStr(meta.paymentApprovedAt);
}

async function checkoutSession(req, res) {
  try {
    const bookingId = safeStr(req.body?.bookingId);
    if (!bookingId) {
      return res.status(400).json({ ok: false, code: "MISSING_BOOKING_ID" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });
    }

    const offer = await loadOffer(booking);
    if (!offer) {
      return res.status(400).json({ ok: false, code: "OFFER_NOT_FOUND" });
    }

    if (!isApproved(booking)) {
      return res.status(403).json({ ok: false, code: "PAYMENT_NOT_APPROVED" });
    }

    const needsWeekly =
      !isCampOffer(offer, booking) && requiresWeeklyMembership(offer);

    if (needsWeekly) {
      const okWeekly = await childHasActiveWeeklyBooking({
        ownerId: booking.owner,
        firstName: booking.firstName,
        lastName: booking.lastName,
        birthDate: null,
        parentEmail: booking.email,
      });

      if (!okWeekly) {
        return res.status(403).json({ ok: false, code: "WEEKLY_REQUIRED" });
      }
    }

    if (isSubscriptionOffer(offer)) {
      const out = await createSubscriptionCheckout({ booking });
      if (!out?.ok) return res.status(400).json(out);

      return res.status(200).json({
        ok: true,
        url: out.url,
        sessionId: out.sessionId,
      });
    }

    const out = await createPaymentCheckout({ booking });
    if (!out?.ok) return res.status(400).json(out);

    if (out.alreadyPaid) {
      return res.status(200).json({ ok: true, alreadyPaid: true });
    }

    return res.status(200).json({
      ok: true,
      url: out.url,
      sessionId: out.sessionId,
    });
  } catch (e) {
    console.error("[stripe] checkout-session error:", e?.message || e);
    return res.status(500).json({ ok: false, code: "SERVER" });
  }
}

module.exports = { checkoutSession };

// //routes\payments\stripe\routes\checkoutSession.js
// "use strict";

// const Booking = require("../../../../models/Booking");
// const { childHasActiveWeeklyBooking } = require("../../../../utils/relations");
// const { safeStr } = require("../lib/strings");
// const {
//   loadOffer,
//   isSubscriptionOffer,
//   isCampOffer,
//   requiresWeeklyMembership,
// } = require("../lib/offer");
// const { createPaymentCheckout } = require("../lib/createPaymentCheckout");

// function isApproved(booking) {
//   const meta =
//     booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
//   if (meta.paymentApprovalRequired !== true) return true;
//   return !!safeStr(meta.paymentApprovedAt);
// }

// function bookingEmail(booking) {
//   return safeStr(booking?.email).toLowerCase();
// }

// async function hasActiveWeeklyForBooking(booking) {
//   return childHasActiveWeeklyBooking({
//     ownerId: booking.owner,
//     firstName: booking.firstName,
//     lastName: booking.lastName,
//     birthDate: null,
//   });
// }

// async function checkoutSession(req, res) {
//   try {
//     const bookingId = safeStr(req.body?.bookingId);
//     if (!bookingId)
//       return res.status(400).json({ ok: false, code: "MISSING_BOOKING_ID" });

//     const booking = await Booking.findById(bookingId);
//     if (!booking)
//       return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });

//     const offer = await loadOffer(booking);
//     if (!offer)
//       return res.status(400).json({ ok: false, code: "OFFER_NOT_FOUND" });
//     if (isSubscriptionOffer(offer)) {
//       return res
//         .status(400)
//         .json({ ok: false, code: "USE_SUBSCRIPTION_ENDPOINT" });
//     }

//     if (!isApproved(booking)) {
//       return res.status(403).json({ ok: false, code: "PAYMENT_NOT_APPROVED" });
//     }

//     const needsWeekly =
//       !isCampOffer(offer, booking) && requiresWeeklyMembership(offer);
//     if (needsWeekly) {
//       const okWeekly = await childHasActiveWeeklyBooking({
//         ownerId: booking.owner,
//         firstName: booking.firstName,
//         lastName: booking.lastName,
//         birthDate: null,
//         parentEmail: booking.email,
//       });
//       if (!okWeekly)
//         return res.status(403).json({ ok: false, code: "WEEKLY_REQUIRED" });
//     }

//     const out = await createPaymentCheckout({ booking });
//     if (!out?.ok) return res.status(400).json(out);
//     if (out.alreadyPaid)
//       return res.status(200).json({ ok: true, alreadyPaid: true });

//     return res
//       .status(200)
//       .json({ ok: true, url: out.url, sessionId: out.sessionId });
//   } catch (e) {
//     console.error("[stripe] checkout-session error:", e?.message || e);
//     return res.status(500).json({ ok: false, code: "SERVER" });
//   }
// }

// module.exports = { checkoutSession };
