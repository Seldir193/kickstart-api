"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");

const { resolveOwner } = require("../helpers/owner");

async function restoreBooking(req, res) {
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

    const booking = await Booking.findOne({
      _id: id,
      owner: ownerId,
      status: "deleted",
    });

    if (!booking) {
      return res.status(404).json({
        ok: false,
        code: "NOT_FOUND",
        error: "Deleted booking not found",
      });
    }

    // 1) Basis: vorheriger Status, falls vorhanden
    let nextStatus = booking.previousStatus;

    // 2) Falls kein previousStatus gesetzt ist (alte Daten vorher),
    //    sinnvollen Fallback wählen:
    if (!nextStatus || nextStatus === "deleted") {
      if (booking.source === "online_request") {
        // Online-Buchungen: niemals 'pending' – dann Standard = 'confirmed'
        nextStatus = "confirmed";
      } else {
        // Normale Bookings: Default 'pending'
        nextStatus = "pending";
      }
    }

    booking.status = nextStatus;
    booking.previousStatus = null; // optional aufräumen
    await booking.save();

    return res.json({ ok: true, booking });
  } catch (err) {
    console.error("[bookings:restore] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { restoreBooking };
