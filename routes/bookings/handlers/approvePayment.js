//routes\bookings\handlers\approvePayment.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");
const { resolveOwner } = require("../helpers/owner");
const { sendOneTimePaymentLinkEmail } = require("../../../utils/mailer");

function safeText(v) {
  return String(v ?? "").trim();
}

function ensureMeta(booking) {
  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
  return booking.meta;
}

async function approvePayment(req, res) {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
    }

    const id = safeText(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    const offer = booking?.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;

    const meta = ensureMeta(booking);

    meta.paymentApprovalRequired = false;
    meta.paymentApprovedAt = meta.paymentApprovedAt || new Date().toISOString();

    const resend = String(req.query?.resend || "").trim() === "1";
    const alreadySent =
      String(meta.paymentApprovedEmailSentAt || "").trim() !== "";

    if (resend || !alreadySent) {
      const to =
        safeText(booking?.invoiceTo?.parent?.email) || safeText(booking?.email);

      if (to) {
        try {
          await sendOneTimePaymentLinkEmail({
            to,
            booking,
            offer,
            bookingId: booking._id,
          });
          meta.paymentApprovedEmailSentAt = new Date().toISOString();
        } catch (e) {
          console.error(
            "[approve-payment] sendOneTimePaymentLinkEmail failed:",
            e?.message || e,
          );
        }
      }
    }

    booking.markModified("meta");
    await booking.save();

    return res.json({
      ok: true,
      paymentApprovedAt: meta.paymentApprovedAt,
      paymentApprovedEmailSentAt: meta.paymentApprovedEmailSentAt || null,
    });
  } catch (err) {
    console.error("[bookings:approve-payment] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { approvePayment };

// //routes\bookings\handlers\approvePayment.js
// "use strict";

// const mongoose = require("mongoose");
// const Booking = require("../../../models/Booking");
// const { resolveOwner } = require("../helpers/owner");
// //const Offer = require("../../../models/Offer");
// const { sendOneTimePaymentLinkEmail } = require("../../../utils/mailer");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function ensureMeta(booking) {
//   if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
//   return booking.meta;
// }

// async function approvePayment(req, res) {
//   try {
//     const ownerId = resolveOwner(req);
//     if (!ownerId) {
//       return res
//         .status(500)
//         .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
//     }

//     const id = safeText(req.params.id);
//     if (!mongoose.isValidObjectId(id)) {
//       return res.status(400).json({ ok: false, error: "Invalid booking id" });
//     }

//     const booking = await Booking.findOne({ _id: id, owner: ownerId });
//     if (!booking) {
//       return res.status(404).json({ ok: false, error: "Not found" });
//     }

//     const meta = ensureMeta(booking);

//     meta.paymentApprovalRequired = false;
//     meta.paymentApprovedAt = meta.paymentApprovedAt || new Date().toISOString();

//     const resend = String(req.query?.resend || "").trim() === "1";
//     const alreadySent =
//       String(meta.paymentApprovedEmailSentAt || "").trim() !== "";

//     // const offer = booking?.offerId
//     //   ? await Offer.findById(String(booking.offerId)).lean()
//     //   : null;

//     if (resend || !alreadySent) {
//       const to =
//         safeText(booking?.invoiceTo?.parent?.email) || safeText(booking?.email);

//       if (to) {
//         try {
//           await sendOneTimePaymentLinkEmail({
//             to,
//             booking,
//             //offer,
//             offer: null,
//             bookingId: booking._id,
//           });
//           meta.paymentApprovedEmailSentAt = new Date().toISOString();
//         } catch (e) {
//           console.error(
//             "[approve-payment] sendOneTimePaymentLinkEmail failed:",
//             e?.message || e,
//           );
//         }
//       }
//     }

//     booking.markModified("meta");
//     await booking.save();

//     return res.json({
//       ok: true,
//       paymentApprovedAt: meta.paymentApprovedAt,
//       paymentApprovedEmailSentAt: meta.paymentApprovedEmailSentAt || null,
//     });
//   } catch (err) {
//     console.error("[bookings:approve-payment] error:", err);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// }

// module.exports = { approvePayment };
