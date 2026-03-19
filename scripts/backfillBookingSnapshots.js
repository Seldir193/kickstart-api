"use strict";

const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Booking = require("../models/Booking");
const Offer = require("../models/Offer");

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI missing");

  await mongoose.connect(uri);

  const cursor = Customer.find({}).cursor();
  let touched = 0;
  let scanned = 0;

  for await (const customer of cursor) {
    scanned += 1;
    let dirty = false;

    for (const ref of customer.bookings || []) {
      const hasMonthly = ref.priceMonthly != null;
      const hasAt = ref.priceAtBooking != null;
      const hasCur = Boolean(String(ref.currency || "").trim());

      if (hasMonthly && hasAt && hasCur) continue;

      let b = null;
      if (ref.bookingId) {
        b = await Booking.findById(ref.bookingId).lean();
      }

      if (b) {
        if (!hasCur) ref.currency = String(b.currency || "EUR");
        if (!hasAt) ref.priceAtBooking = num(b.priceAtBooking);
        if (!hasMonthly)
          ref.priceMonthly = num(b.priceMonthly ?? b.priceAtBooking);
        if (ref.priceFirstMonth == null && b.priceFirstMonth != null) {
          ref.priceFirstMonth = num(b.priceFirstMonth);
        }
        dirty = true;
        continue;
      }

      const offerId = ref.offerId;
      if (!offerId) continue;

      const offer = await Offer.findById(offerId).select("price").lean();
      if (!offer) continue;

      if (!hasCur) ref.currency = "EUR";
      if (!hasAt) ref.priceAtBooking = num(offer.price);
      if (!hasMonthly) ref.priceMonthly = num(offer.price);
      dirty = true;
    }

    if (dirty) {
      await customer.save();
      touched += 1;
    }
  }

  await mongoose.disconnect();
  console.log(JSON.stringify({ ok: true, scanned, touched }));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
