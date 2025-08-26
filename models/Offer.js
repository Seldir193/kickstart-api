// models/Offer.js
const mongoose = require('mongoose');

const OfferSchema = new mongoose.Schema({
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

module.exports = mongoose.model('Offer', OfferSchema);
