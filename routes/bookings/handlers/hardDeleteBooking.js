//routes\bookings\handlers\hardDeleteBooking.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");

const { resolveOwner } = require("../helpers/owner");

async function hardDeleteBooking(req, res) {
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

    const result = await Booking.deleteOne({ _id: id, owner: ownerId });

    if (!result.deletedCount) {
      return res
        .status(404)
        .json({ ok: false, code: "NOT_FOUND", error: "Booking not found" });
    }

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("[bookings:hard-delete] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { hardDeleteBooking };
