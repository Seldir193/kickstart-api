// scripts/backfill-place-publicId.js
const path = require('path');
const mongoose = require('mongoose');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) {}

const uri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DB_URL ||
  'mongodb://127.0.0.1:27017/kickstart';

// register models (Counter vor Place laden ist ok, Place lädt Counter im Hook ggf. selbst)
require('../models/Counter');
const Place = require('../models/Place');

(async () => {
  console.log('Connecting to MongoDB:', uri);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  // Alle Places ohne publicId (oder null)
  const cursor = Place.find({
    $or: [{ publicId: { $exists: false } }, { publicId: null }]
  })
    .select({ _id: 1 })
    .cursor();

  let n = 0, errs = 0;
  for await (const p of cursor) {
    try {
      const doc = await Place.findById(p._id);
      if (!doc) continue;
      if (!doc.publicId) {
        await doc.validate(); // triggert pre('validate') -> publicId zuweisen
        await doc.save();     // schreibt die neue publicId
        n++;
      }
    } catch (e) {
      errs++;
      console.warn('Failed to assign publicId for', String(p._id), e.message);
    }
  }

  console.log(`Assigned publicId for ${n} place(s). Errors: ${errs}.`);
  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
})();











