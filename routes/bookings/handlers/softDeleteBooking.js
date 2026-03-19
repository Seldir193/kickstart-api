"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");

const { resolveOwner } = require("../helpers/owner");

async function softDeleteBooking(req, res) {
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
      return res.status(404).json({ ok: false, code: "NOT_FOUND" });
    }

    // Nur wenn noch nicht gelöscht: ursprünglichen Status merken
    if (booking.status !== "deleted") {
      booking.previousStatus = booking.status || "pending";
    }

    booking.status = "deleted";
    await booking.save();

    return res.json({ ok: true, booking });
  } catch (err) {
    console.error("[bookings:soft-delete] error:", err);
    return res
      .status(500)
      .json({ ok: false, code: "SERVER", error: "Server error" });
  }
}

module.exports = { softDeleteBooking };
