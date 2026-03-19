// routes/bookings/handlers/weeklyApprove.js
"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");
const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");
const { resolveOwner } = require("../helpers/owner");
const { sendWeeklyContractStartEmail } = require("../../../utils/mailer");

function safeText(v) {
  return String(v ?? "").trim();
}

function ensureMeta(booking) {
  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
  return booking.meta;
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function loadOffer(booking) {
  if (!booking?.offerId) return null;
  try {
    return await Offer.findById(String(booking.offerId)).lean();
  } catch {
    return null;
  }
}

async function weeklyApprove(req, res) {
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

    const meta = ensureMeta(booking);

    // meta.subscriptionEligible = true;
    // meta.weeklyApprovedAt =
    //   safeText(meta.weeklyApprovedAt) || new Date().toISOString();

    meta.subscriptionEligible = true;

    const approvedAt =
      safeText(meta.subscriptionEligibleAt) ||
      safeText(meta.weeklyApprovedAt) ||
      new Date().toISOString();

    meta.subscriptionEligibleAt = approvedAt;
    meta.weeklyApprovedAt = approvedAt;

    if (!safeText(meta.contractToken)) {
      meta.contractToken = randomToken();
      meta.contractTokenExpiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
    }

    booking.markModified("meta");
    await booking.save();

    const offer = await loadOffer(booking);
    const to =
      safeText(booking?.invoiceTo?.parent?.email) || safeText(booking?.email);

    if (to) {
      await sendWeeklyContractStartEmail({
        to,
        booking,
        offer,
        token: safeText(meta.contractToken),
      }).catch(() => {});
    }

    // return res.json({
    //   ok: true,
    //   weeklyApprovedAt: meta.weeklyApprovedAt,
    //   contractTokenCreated: !!safeText(meta.contractToken),
    // });

    return res.json({
      ok: true,
      subscriptionEligibleAt: meta.subscriptionEligibleAt,
      weeklyApprovedAt: meta.weeklyApprovedAt,
      contractTokenCreated: !!safeText(meta.contractToken),
    });
  } catch (err) {
    console.error("[bookings:weekly-approve] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { weeklyApprove };

// // routes/bookings/handlers/weeklyApprove.js
// "use strict";

// const mongoose = require("mongoose");
// const Booking = require("../../../models/Booking");
// const { resolveOwner } = require("../helpers/owner");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function ensureMeta(booking) {
//   if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
//   return booking.meta;
// }

// async function weeklyApprove(req, res) {
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

//     if (meta.subscriptionEligible === true && safeText(meta.weeklyApprovedAt)) {
//       return res.json({
//         ok: true,
//         alreadyApproved: true,
//         weeklyApprovedAt: meta.weeklyApprovedAt,
//       });
//     }

//     meta.subscriptionEligible = true;
//     meta.weeklyApprovedAt = new Date().toISOString();

//     booking.markModified("meta");
//     await booking.save();

//     return res.json({ ok: true, weeklyApprovedAt: meta.weeklyApprovedAt });
//   } catch (err) {
//     console.error("[bookings:weekly-approve] error:", err);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// }

// module.exports = { weeklyApprove };
