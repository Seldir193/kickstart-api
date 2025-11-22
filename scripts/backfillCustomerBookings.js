// scripts/backfillCustomerBookings.js
'use strict';

require('dotenv').config();  // 🔑 lädt deine .env im Projektroot

const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Booking  = require('../models/Booking');
const Offer    = require('../models/Offer');

// WICHTIG: hier jetzt deine echte Verbindungs-URL aus .env nutzen
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error('MONGO_URI is missing. Bitte in .env setzen.');
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const cursor = Booking.find({
    source: 'online_request',                    // nur Online-Buchungen
    status: { $in: ['confirmed', 'pending'] },   // oder was du willst
  }).cursor();

  let touchedCustomers = 0;
  let createdRefs = 0;

  for (let booking = await cursor.next(); booking; booking = await cursor.next()) {
    const ownerId = booking.owner;
    const offer   = booking.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;

    const emailLower = String(booking.email || '').trim().toLowerCase();

    const customer = await Customer.findOne({
      owner: ownerId,
      $or: [
        { emailLower },
        { email: emailLower },
        { 'parent.email': emailLower },
      ],
    });

    if (!customer) {
      console.log('[skip] no customer for booking', String(booking._id));
      continue;
    }

    if (!Array.isArray(customer.bookings)) {
      customer.bookings = [];
    }

    const exists = customer.bookings.some(
      (b) => String(b.bookingId || b._id) === String(booking._id)
    );
    if (exists) continue;

    const bookingDate = booking.date
      ? new Date(booking.date)
      : booking.createdAt || new Date();

    const venue =
      typeof offer?.location === 'string'
        ? offer.location
        : offer?.location?.name || offer?.location?.title || '';

   // Mapping: Customer-Subdoc kennt nur 'active' oder 'cancelled'
const subStatus = booking.status === 'cancelled' ? 'cancelled' : 'active';

customer.bookings.push({
  bookingId: booking._id,
  offerId:   offer?._id || booking.offerId,
  offerTitle:
    offer?.title ||
    offer?.sub_type ||
    offer?.type ||
    booking.offerTitle ||
    '',
  offerType:
    offer?.sub_type ||
    offer?.type ||
    booking.offerType ||
    '',
  venue,
  date: bookingDate,
  status: subStatus,   // ✅ jetzt enum-konform
  priceAtBooking:
    typeof booking.priceAtBooking === 'number'
      ? booking.priceAtBooking
      : typeof offer?.price === 'number'
        ? offer.price
        : null,
  invoiceNumber: booking.invoiceNumber || booking.invoiceNo || undefined,
  invoiceNo:     booking.invoiceNo     || booking.invoiceNumber || undefined,
  invoiceDate:   booking.invoiceDate   || undefined,
});

    await customer.save();
    createdRefs++;
    touchedCustomers++;
  }

  console.log(`Done. Created ${createdRefs} booking refs on ${touchedCustomers} customers.`);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
