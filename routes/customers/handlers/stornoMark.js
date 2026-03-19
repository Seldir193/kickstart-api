// routes/customers/handlers/stornoMark.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../models/Customer");
const Booking = require("../../../models/Booking");

function safeText(value) {
  return String(value ?? "").trim();
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isCastError(err) {
  return (
    !!err &&
    (err.name === "CastError" || safeText(err?.message).includes("CastError"))
  );
}

function findCustomerBookingRef(customer, bid) {
  const bySubId = customer.bookings?.id ? customer.bookings.id(bid) : null;
  if (bySubId) return bySubId;
  const id = safeText(bid);
  return customer.bookings?.find((b) => safeText(b?.bookingId) === id) || null;
}

function applyInvoiceFallback(ref, bookingDoc) {
  if (!ref || !bookingDoc) return;
  if (safeText(ref.invoiceNumber) || safeText(ref.invoiceNo)) return;

  const docNo = safeText(bookingDoc.invoiceNumber || bookingDoc.invoiceNo);
  if (docNo) ref.invoiceNumber = docNo;
  if (!ref.invoiceDate && bookingDoc.invoiceDate)
    ref.invoiceDate = bookingDoc.invoiceDate;
}

function buildBookingSetPayload(ref) {
  const set = {
    status: "storno",
    stornoNo: safeText(ref.stornoNo),
    stornoDate: ref.stornoDate || new Date(),
  };

  if (typeof ref.stornoAmount === "number") {
    set.stornoAmount = ref.stornoAmount;
  }

  return set;
}

function buildErrorPayload(err) {
  if (!err) return { ok: false, code: "SERVER_ERROR" };

  if (err.name === "ValidationError") {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: safeText(err.message),
      errors: err.errors || {},
    };
  }

  return {
    ok: false,
    code: "SERVER_ERROR",
    name: safeText(err.name),
    message: safeText(err.message),
  };
}

async function stornoMark(req, res, requireOwner, requireId, formatStornoNo) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const bid = safeText(req.params.bid);
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ ok: false, code: "INVALID_BOOKING_ID" });
    }

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) {
      return res.status(404).json({ ok: false, code: "CUSTOMER_NOT_FOUND" });
    }

    const ref = findCustomerBookingRef(customer, bid);
    if (!ref) {
      return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });
    }

    const lookupId = safeText(ref.bookingId || ref._id);
    if (!mongoose.isValidObjectId(lookupId)) {
      return res.status(400).json({
        ok: false,
        code: "INVALID_BOOKING_LOOKUP_ID",
        lookupId,
      });
    }

    const bookingDoc = await Booking.findOne({ _id: lookupId, owner }).lean();
    applyInvoiceFallback(ref, bookingDoc);

    if (safeText(ref.stornoNo)) {
      return res.status(409).json({ ok: false, code: "ALREADY_STORNO" });
    }

    let stornoNo = "";
    try {
      stornoNo = safeText(
        typeof formatStornoNo === "function" ? formatStornoNo() : "",
      );
    } catch (e) {
      return res.status(500).json({ ok: false, code: "STORNO_NO_FAILED" });
    }

    if (!stornoNo) {
      return res.status(500).json({ ok: false, code: "MISSING_STORNO_NO" });
    }

    ref.status = "cancelled";
    ref.stornoNo = stornoNo;
    ref.stornoDate = new Date();

    if (req.body?.note != null) {
      ref.stornoReason = safeText(req.body.note);
    }

    const amount = toFiniteNumber(req.body?.amount);
    if (amount != null) ref.stornoAmount = amount;

    await customer.save();

    const set = buildBookingSetPayload(ref);
    await Booking.findOneAndUpdate(
      { _id: lookupId, owner },
      { $set: set },
      { new: true },
    );

    return res.json({ ok: true, booking: ref });
  } catch (err) {
    console.error("stornoMark error:", err);

    if (isCastError(err)) {
      return res.status(400).json({ ok: false, code: "CAST_ERROR" });
    }

    const payload = buildErrorPayload(err);
    const status = payload.code === "VALIDATION_ERROR" ? 400 : 500;
    return res.status(status).json(payload);
  }
}

module.exports = { stornoMark };
