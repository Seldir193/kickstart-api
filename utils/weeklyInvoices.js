//utils\weeklyInvoices.js
"use strict";

const Booking = require("../models/Booking");

function yy(d) {
  return String(d.getFullYear()).slice(-2);
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function safeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function parseSeq(invoiceNo) {
  const m = safeStr(invoiceNo).match(/-(\d{4})$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

async function nextSeq(ownerId, prefix) {
  const last = await Booking.findOne({
    owner: ownerId,
    invoiceNo: {
      $regex: `^${prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`,
    },
  })
    .select("invoiceNo invoiceDate createdAt")
    .sort({ invoiceDate: -1, createdAt: -1 })
    .lean();

  const lastSeq = last?.invoiceNo ? parseSeq(last.invoiceNo) : 0;
  return lastSeq + 1;
}

async function ensureWeeklyInvoiceForBooking({ booking }) {
  if (!booking) return;
  if (safeStr(booking.invoiceNo) || safeStr(booking.invoiceNumber)) return;

  const now = new Date();
  const prefix = `WK-${yy(now)}-`;
  const seq = await nextSeq(booking.owner, prefix);

  const no = `${prefix}${pad4(seq)}`;

  booking.invoiceNo = no;
  booking.invoiceNumber = no;
  booking.invoiceDate = now;

  await booking.save();
}

module.exports = { ensureWeeklyInvoiceForBooking };
