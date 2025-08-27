// models/Offer.js
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const OfferSchema = new Schema({
  owner: { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true }, // <- NEU
  type: { type: String, enum: ['Camp','Foerdertraining','Kindergarten','PersonalTraining','AthleticTraining'], required: true },
  location: { type: String, required: true },
  price: { type: Number, min: 0, required: true },
  days: { type: [String], default: [] }, // 'mon'...'sun'
  timeFrom: { type: String, required: true }, // 'HH:MM'
  timeTo: { type: String, required: true },   // 'HH:MM'
  ageFrom: { type: Number, min: 0 },
  ageTo: { type: Number, min: 0 },
  info: { type: String, default: '' },
  onlineActive: { type: Boolean, default: true },
  title: { type: String, default: '' },
}, { timestamps: true });

OfferSchema.pre('save', function(next) {
  if (!this.title) {
    const parts = [this.type, this.location].filter(Boolean);
    this.title = parts.join(' • ');
  }
  next();
});

// sinnvolle Indizes
OfferSchema.index({ owner: 1, createdAt: -1 });
// Beispiel für tenant-spezifische Eindeutigkeit (optional):
// OfferSchema.index({ owner: 1, title: 1 }, { unique: true });

module.exports = mongoose.model('Offer', OfferSchema);
