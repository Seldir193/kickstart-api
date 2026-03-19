//routes\bookings\handlers\cancelConfirmedBooking.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");
const Customer = require("../../../models/Customer");
const { sendBookingCancelledConfirmedEmail } = require("../../../utils/mailer");
const { resolveOwner } = require("../helpers/owner");
const { isNonTrialProgram } = require("../helpers/offerTypes");

function safeText(v) {
  return String(v ?? "").trim();
}

function metaObj(booking) {
  return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
}

function hasCustomerCancellation(booking) {
  const meta = metaObj(booking);

  return Boolean(
    booking?.status === "cancelled" ||
    booking?.cancelDate ||
    booking?.cancellationDate ||
    safeText(booking?.cancellationNo) ||
    booking?.stripe?.cancelRequestedAt ||
    booking?.stripe?.cancelEffectiveAt ||
    safeText(meta.subscriptionCancelStatus),
  );
}

async function cancelConfirmedBooking(req, res) {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res
        .status(500)
        .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
    }

    const id = String(req.params.id || "").trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    if (hasCustomerCancellation(booking)) {
      return res.status(409).json({
        ok: false,
        code: "CANCELLATION_ALREADY_EXISTS",
        error: "Kündigung wurde bereits angefordert oder durchgeführt",
      });
    }

    if (booking.status !== "confirmed") {
      return res.status(409).json({
        ok: false,
        code: "NOT_CONFIRMED",
        error: "Only confirmed bookings can be cancelled via this route",
      });
    }

    const cancelAt = new Date();
    booking.status = "cancelled";
    booking.cancelledAt = cancelAt;
    booking.cancelDate = booking.cancelDate || cancelAt;
    booking.cancelReason =
      req.body && req.body.note != null
        ? String(req.body.note || "")
        : booking.cancelReason || "";

    const offer = booking.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;

    const customer = await Customer.findOne({
      owner: ownerId,
      "bookings.bookingId": booking._id,
    });

    if (customer) {
      const ref = customer.bookings.find(
        (b) => String(b.bookingId) === String(booking._id),
      );

      if (ref) {
        ref.status = "cancelled";
        ref.cancelDate = ref.cancelDate || cancelAt;
        ref.cancelReason =
          req.body && req.body.note != null
            ? String(req.body.note || "")
            : ref.cancelReason || "";
        await customer.save();
      }
    }

    await booking.save();

    const isNonTrial = isNonTrialProgram(offer);
    let mailSent = false;

    try {
      await sendBookingCancelledConfirmedEmail({
        to: booking.email,
        booking,
        offer,
        isNonTrial,
      });
      mailSent = true;
    } catch (e) {
      console.error(
        "[bookings:cancel-confirmed] mail failed:",
        e?.message || e,
      );
    }

    return res.json({
      ok: true,
      booking,
      mailSent,
      stornoSent: false,
    });
  } catch (err) {
    console.error("[bookings:cancel-confirmed] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { cancelConfirmedBooking };

// //routes\bookings\handlers\cancelConfirmedBooking.js
// "use strict";

// const mongoose = require("mongoose");
// const Booking = require("../../../models/Booking");
// const Offer = require("../../../models/Offer");
// const Customer = require("../../../models/Customer");
// const { formatStornoNo } = require("../../../utils/sequences");
// const {
//   sendBookingCancelledConfirmedEmail,
//   sendStornoEmail,
// } = require("../../../utils/mailer");
// const { resolveOwner } = require("../helpers/owner");
// const { isNonTrialProgram } = require("../helpers/offerTypes");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function metaObj(booking) {
//   return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
// }

// function hasCustomerCancellation(booking) {
//   const meta = metaObj(booking);

//   return Boolean(
//     booking?.status === "cancelled" ||
//     booking?.cancelDate ||
//     booking?.cancellationDate ||
//     safeText(booking?.cancellationNo) ||
//     booking?.stripe?.cancelRequestedAt ||
//     booking?.stripe?.cancelEffectiveAt ||
//     safeText(meta.subscriptionCancelStatus),
//   );
// }

// async function cancelConfirmedBooking(req, res) {
//   try {
//     const ownerId = resolveOwner(req);
//     if (!ownerId) {
//       return res
//         .status(500)
//         .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });
//     }

//     const id = String(req.params.id || "").trim();
//     if (!mongoose.isValidObjectId(id)) {
//       return res.status(400).json({ ok: false, error: "Invalid booking id" });
//     }

//     const booking = await Booking.findOne({ _id: id, owner: ownerId });
//     if (!booking) {
//       return res.status(404).json({ ok: false, error: "Not found" });
//     }

//     if (hasCustomerCancellation(booking)) {
//       return res.status(409).json({
//         ok: false,
//         code: "CANCELLATION_ALREADY_EXISTS",
//         error: "Kündigung wurde bereits angefordert oder durchgeführt",
//       });
//     }

//     if (booking.status !== "confirmed") {
//       return res.status(409).json({
//         ok: false,
//         code: "NOT_CONFIRMED",
//         error: "Only confirmed bookings can be cancelled via this route",
//       });
//     }

//     const cancelAt = new Date();
//     booking.status = "cancelled";
//     booking.cancelledAt = cancelAt;
//     booking.cancelDate = booking.cancelDate || cancelAt;

//     const offer = booking.offerId
//       ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
//       : null;

//     const customer = await Customer.findOne({
//       owner: ownerId,
//       "bookings.bookingId": booking._id,
//     });

//     const amount =
//       typeof booking.priceAtBooking === "number"
//         ? booking.priceAtBooking
//         : typeof offer?.price === "number"
//           ? offer.price
//           : null;

//     if (!booking.stornoNo) {
//       booking.stornoNo = formatStornoNo();
//     }
//     if (amount != null) {
//       booking.stornoAmount = amount;
//     }

//     if (customer) {
//       const ref = customer.bookings.find(
//         (b) => String(b.bookingId) === String(booking._id),
//       );

//       if (ref) {
//         ref.status = "cancelled";
//         ref.cancelDate = ref.cancelDate || cancelAt;
//         ref.cancelReason =
//           req.body && req.body.note != null
//             ? String(req.body.note || "")
//             : ref.cancelReason || "";
//         ref.stornoNo = ref.stornoNo || booking.stornoNo;
//         if (amount != null) {
//           ref.stornoAmount = amount;
//         }
//         await customer.save();
//       }
//     }

//     await booking.save();

//     const isNonTrial = isNonTrialProgram(offer);
//     let mailSent = false;
//     let stornoSent = false;

//     try {
//       await sendBookingCancelledConfirmedEmail({
//         to: booking.email,
//         booking,
//         offer,
//         isNonTrial,
//       });
//       mailSent = true;
//     } catch (e) {
//       console.error(
//         "[bookings:cancel-confirmed] mail failed:",
//         e?.message || e,
//       );
//     }

//     if (customer && booking.invoiceNumber) {
//       try {
//         const stornoAmount =
//           typeof booking.priceAtBooking === "number"
//             ? booking.priceAtBooking
//             : typeof offer?.price === "number"
//               ? offer.price
//               : 0;

//         await sendStornoEmail({
//           to: booking.email,
//           customer,
//           booking,
//           offer,
//           amount: stornoAmount,
//           currency: booking.currency || "EUR",
//         });
//         stornoSent = true;
//       } catch (e) {
//         console.error(
//           "[bookings:cancel-confirmed] storno mail failed:",
//           e?.message || e,
//         );
//       }
//     } else {
//       console.warn(
//         "[bookings:cancel-confirmed] skip storno: no customer or no invoiceNumber for booking",
//         String(booking._id),
//       );
//     }

//     return res.json({
//       ok: true,
//       booking,
//       mailSent,
//       stornoSent,
//     });
//   } catch (err) {
//     console.error("[bookings:cancel-confirmed] error:", err);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// }

// module.exports = { cancelConfirmedBooking };
