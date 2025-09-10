// scripts/backfill_price_and_invoiceDate.js
require('dotenv').config();
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Offer = require('../models/Offer');

(async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const cursor = Booking.find({
      $or: [
        { priceAtBooking: { $exists: false } },
        { priceAtBooking: null }
      ]
    }).cursor();

    let updated = 0;
    for await (const b of cursor) {
      let changed = false;

      if (b.priceAtBooking == null && b.offerId) {
        const offer = await Offer.findById(b.offerId).lean();
        if (offer?.price != null) {
          b.priceAtBooking = offer.price;
          changed = true;
        }
      }

      if (b.invoiceNumber && !b.invoiceDate) {
        b.invoiceDate = b.createdAt;
        changed = true;
      }

      if (changed) {
        await b.save();
        updated++;
      }
    }

    console.log(`Done. Updated bookings: ${updated}`);
    await mongoose.disconnect();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();

