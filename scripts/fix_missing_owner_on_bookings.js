// scripts/fix_missing_owner_on_bookings.js
require('dotenv').config();
const mongoose = require('mongoose');

const Booking  = require('../models/Booking');
const Offer    = require('../models/Offer');
const Customer = require('../models/Customer'); // für Fallback über embedded bookings

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI fehlt');
  const DRY = !!process.env.DRY_RUN;

  await mongoose.connect(uri);
  console.log(`✅ MongoDB verbunden${DRY ? ' (DRY-RUN: keine Writes)' : ''}`);

  // Alle separaten Bookings ohne owner
  const cursor = Booking.find({
    $or: [{ owner: { $exists: false } }, { owner: null }]
  }).cursor();

  let scanned = 0, fixed = 0, skipped = 0;

  for await (const b of cursor) {
    scanned++;
    let owner = null;

    // 1) Versuch: owner aus Offer ziehen
    if (b.offerId) {
      try {
        const off = await Offer.findById(b.offerId).select('owner').lean();
        if (off?.owner) owner = off.owner;
      } catch {}
    }

    // 2) Fallback: über Customer, der diese booking._id eingebettet hat
    if (!owner) {
      try {
        const cust = await Customer.findOne({ 'bookings._id': b._id }).select('owner').lean();
        if (cust?.owner) owner = cust.owner;
      } catch {}
    }

    if (!owner) {
      skipped++;
      console.warn(`→ Skip ${b._id}: kein owner ermittelbar (offerId=${b.offerId || '-'})`);
      continue;
    }

    if (DRY) {
      fixed++;
      console.log(`(dry) Set owner für booking ${b._id} -> ${owner}`);
    } else {
      // Wichtig: updateOne statt save() => keine Required-Validation
      await Booking.updateOne({ _id: b._id }, { $set: { owner } });
      fixed++;
      console.log(`✔ Set owner für booking ${b._id} -> ${owner}`);
    }
  }

  console.log(`Fertig. scanned=${scanned}, fixed=${fixed}, skipped=${skipped}`);
  await mongoose.disconnect();
})().catch(e => { console.error('❌ Fehler:', e.message); process.exit(1); });
