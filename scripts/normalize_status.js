// scripts/normalize_status.js
require('dotenv').config();
const mongoose = require('mongoose');
const Booking = require('../models/Booking');

(async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const res = await Booking.updateMany(
      { status: 'canceled' },
      { $set: { status: 'cancelled' } }
    );
    console.log(`Normalized: ${res.modifiedCount}`);
    await mongoose.disconnect();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
