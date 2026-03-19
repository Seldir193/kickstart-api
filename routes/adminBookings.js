//routes\adminBookings.js
"use strict";

const express = require("express");
const router = express.Router();

const Booking = require("../models/Booking");

function safe_str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function require_provider_id(req) {
  const pid = safe_str(req.get("x-provider-id"));
  if (!pid) return "";
  return pid;
}

router.patch("/:id/subscription-eligible", express.json(), async (req, res) => {
  const providerId = require_provider_id(req);
  const id = safe_str(req.params.id);
  const eligible = !!req.body?.eligible;

  if (!providerId) {
    return res.status(401).json({ ok: false, code: "MISSING_PROVIDER_ID" });
  }

  const booking = await Booking.findById(id);
  if (!booking) return res.status(404).json({ ok: false, code: "NOT_FOUND" });

  if (String(booking.owner || "") !== providerId) {
    return res.status(403).json({ ok: false, code: "FORBIDDEN" });
  }

  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
  booking.meta.subscriptionEligible = eligible;
  booking.meta.subscriptionEligibleAt = eligible ? new Date() : null;
  booking.markModified("meta");

  await booking.save();

  return res.status(200).json({
    ok: true,
    id: String(booking._id),
    subscriptionEligible: !!booking.meta.subscriptionEligible,
    subscriptionEligibleAt: booking.meta.subscriptionEligibleAt || null,
  });
});

router.post("/:id/approve-payment", express.json(), async (req, res) => {
  const providerId = require_provider_id(req);
  const id = safe_str(req.params.id);

  if (!providerId) {
    return res.status(401).json({ ok: false, code: "MISSING_PROVIDER_ID" });
  }

  const booking = await Booking.findById(id);
  if (!booking) return res.status(404).json({ ok: false, code: "NOT_FOUND" });

  if (String(booking.owner || "") !== providerId) {
    return res.status(403).json({ ok: false, code: "FORBIDDEN" });
  }

  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};

  booking.meta.paymentApprovalRequired = false;
  booking.meta.paymentApprovedAt = new Date().toISOString();

  booking.markModified("meta");
  await booking.save();

  return res.status(200).json({
    ok: true,
    id: String(booking._id),
    paymentApprovedAt: booking.meta.paymentApprovedAt || null,
  });
});

module.exports = router;
