//routes\payments\stripe\lib\findBooking.js
"use strict";

const Booking = require("../../../../models/Booking");
const { safeStr } = require("./strings");
const { bookingIdFromInvoice } = require("./meta");

async function findBookingByMetadata(obj) {
  const bookingId = safeStr(obj?.metadata?.bookingId);
  if (!bookingId) return null;
  return Booking.findById(bookingId);
}

async function findBookingForInvoice(invoice) {
  const subId = safeStr(invoice?.subscription);
  if (subId) {
    const bySub = await Booking.findOne({ "stripe.subscriptionId": subId });
    if (bySub) return bySub;
  }
  const bid = bookingIdFromInvoice(invoice);
  if (!bid) return null;
  const byId = await Booking.findById(bid);
  return byId || null;
}

module.exports = { findBookingByMetadata, findBookingForInvoice };
