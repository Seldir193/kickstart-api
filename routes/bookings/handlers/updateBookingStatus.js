"use strict";

const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");

const { resolveOwner } = require("../helpers/owner");
const { ALLOWED_STATUS, normalizeStatus } = require("../helpers/status");
const { isNonTrialProgram } = require("../helpers/offerTypes");

const {
  sendBookingProcessingEmail,
  sendBookingCancelledEmail,
} = require("../../../utils/mailer");

async function updateBookingStatus(req, res) {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId)
      return res
        .status(500)
        .json({ ok: false, error: "DEFAULT_OWNER_ID missing/invalid" });

    const rawStatus = String(req.body?.status || "").trim();
    const status = normalizeStatus(rawStatus);
    const forceMail = String(req.query.force || "") === "1";

    if (!ALLOWED_STATUS.includes(status)) {
      return res
        .status(400)
        .json({ ok: false, code: "VALIDATION", error: "Invalid status" });
    }

    const prev = await Booking.findOne({ _id: req.params.id, owner: ownerId });
    if (!prev) return res.status(404).json({ ok: false, code: "NOT_FOUND" });

    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: ownerId },
      { status },
      { new: true },
    );
    if (!updated) return res.status(404).json({ ok: false, code: "NOT_FOUND" });

    let mailSentProcessing = false;
    let mailSentCancelled = false;

    if (
      status === "processing" &&
      (prev.status !== "processing" || forceMail)
    ) {
      try {
        // Offer laden, um Programmnamen zu kennen
        const offer = updated.offerId
          ? await Offer.findOne({ _id: updated.offerId, owner: ownerId }).lean()
          : null;

        const isNonTrial = isNonTrialProgram(offer);

        await sendBookingProcessingEmail({
          to: updated.email,
          booking: updated,
          offer,
          isNonTrial,
        });

        mailSentProcessing = true;
      } catch (e) {
        console.error("[BOOKINGS] processing-mail FAILED:", e?.message || e);
      }
    }

    if (status === "cancelled" && (prev.status !== "cancelled" || forceMail)) {
      try {
        if (updated.email) {
          await sendBookingCancelledEmail({
            to: updated.email,
            booking: updated,
          });
          mailSentCancelled = true;
        } else {
          console.error("[BOOKINGS] cancelled: missing recipient email");
        }
      } catch (e) {
        console.error("[BOOKINGS] cancellation-mail FAILED:", e?.message || e);
      }
    }

    return res.json({
      ok: true,
      booking: updated,
      mailSentProcessing,
      mailSentCancelled,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ ok: false, code: "SERVER", error: "Server error" });
  }
}

module.exports = { updateBookingStatus };
