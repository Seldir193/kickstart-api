// models/Place.js
'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;


const Counter = mongoose.models.Counter || require('./Counter');


function normalizeStr(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCanonicalKey(doc) {
  const name = normalizeStr(doc.name);
  const zip  = normalizeStr(doc.zip);
  const city = normalizeStr(doc.city);
  if (!name || !zip || !city) return '';
  return `${name}|${zip}|${city}`;
}

const PlaceSchema = new Schema({
  owner:   { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },
  name:    { type: String, required: true },
  address: { type: String, default: '' },
  zip:     { type: String, default: '' },
  city:    { type: String, default: '' },

  lat:     { type: Number },
  lng:     { type: Number },

  // display id you already use
  publicId: { type: Number, unique: true, sparse: true, index: true },

  // NEW: used only to enforce uniqueness
  canonicalKey: { type: String, default: '' },
}, { timestamps: true });

PlaceSchema.pre('validate', function(next) {
  this.canonicalKey = buildCanonicalKey(this);
  next();
});




// models/Place.js (nur der publicId-Hook)
PlaceSchema.pre('validate', async function(next) {
  try {
    if (this.publicId != null) return next();

    // Wichtig: nur $inc benutzen, KEIN $setOnInsert auf 'seq'
    const Counter = mongoose.models.Counter || require('./Counter');
    const c = await Counter.findOneAndUpdate(
      { _id: 'place_publicId' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    this.publicId = c.seq; // 1, 2, 3, ...
    next();
  } catch (err) {
    // seltener Race-Condition-Fall: nochmal versuchen
    if (err && err.code === 11000) {
      try {
        const Counter = mongoose.models.Counter || require('./Counter');
        const c = await Counter.findOneAndUpdate(
          { _id: 'place_publicId' },
          { $inc: { seq: 1 } },
          { new: true, upsert: true }
        );
        this.publicId = c.seq;
        return next();
      } catch (e2) { return next(e2); }
    }
    next(err);
  }
});






PlaceSchema.index(
  { owner: 1, canonicalKey: 1 },
  { unique: true, partialFilterExpression: { canonicalKey: { $type: 'string', $ne: '' } } }
);

PlaceSchema.index({ owner: 1, city: 1 });
PlaceSchema.index({ owner: 1, createdAt: -1 });



module.exports = mongoose.models.Place || mongoose.model('Place', PlaceSchema);










