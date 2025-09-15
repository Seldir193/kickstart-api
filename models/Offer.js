// models/Offer.js
'use strict';

const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const OfferSchema = new Schema(
  {
    // Tenant/owner scope (required)
    owner: { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },

    // Optional link to a saved Place (used for delete-protection & autofill)
    placeId: { type: Types.ObjectId, ref: 'Place', index: true },

    // Core offer data
    type: {
      type: String,
      enum: ['Camp', 'Foerdertraining', 'Kindergarten', 'PersonalTraining', 'AthleticTraining'],
      required: true,
    },
    location: { type: String, required: true }, // e.g., city; can be auto-filled from Place.city
    price: { type: Number, min: 0, required: true },

    days: { type: [String], default: [] }, // allowed values: 'mon'...'sun'
    timeFrom: { type: String, required: true }, // 'HH:MM'
    timeTo: { type: String, required: true },   // 'HH:MM'

    ageFrom: { type: Number, min: 0 },
    ageTo: { type: Number, min: 0 },

    info: { type: String, default: '' },
    onlineActive: { type: Boolean, default: true },

    title: { type: String, default: '' },

    // Coach info (optional)
    coachName: { type: String, default: '' },
    coachEmail: { type: String, default: '' },
    coachImage: { type: String, default: '' },

    // Extra categorization (optional)
    category: { type: String, default: '' },    // e.g. 'ClubPrograms' | 'Individual' | 'Weekly' | 'Holiday'
    sub_type: { type: String, default: '' },    // e.g. 'Torwarttraining', 'Foerdertraining_Athletik'
    legacy_type: { type: String, default: '' }, // mirrors type for backward compatibility
  },
  { timestamps: true }
);

/**
 * Pre-save: ensure title & legacy_type are set.
 */
OfferSchema.pre('save', function (next) {
  if (!this.title) {
    const parts = [this.type, this.location].filter(Boolean);
    this.title = parts.join(' • ');
  }
  if (!this.legacy_type && this.type) {
    this.legacy_type = this.type;
  }
  next();
});

/**
 * Pre-save: auto-fill location from Place.city if placeId is set and location is empty.
 * (Non-blocking: errors are ignored to avoid breaking the save.)
 */
OfferSchema.pre('save', async function (next) {
  try {
    if (this.placeId && (!this.location || !this.location.trim())) {
      const Place = mongoose.model('Place');
      const p = await Place.findById(this.placeId).lean();
      if (p?.city) this.location = p.city;
    }
  } catch (_) {
    // ignore
  }
  next();
});

/* ===================== Indexes ===================== */
OfferSchema.index({ owner: 1, createdAt: -1 });
OfferSchema.index({ owner: 1, category: 1, sub_type: 1, createdAt: -1 });
OfferSchema.index({ legacy_type: 1, onlineActive: 1, createdAt: -1 });
OfferSchema.index({ owner: 1, placeId: 1 });

// Example for tenant-specific uniqueness (optional):
// OfferSchema.index({ owner: 1, title: 1 }, { unique: true });

module.exports = mongoose.models.Offer || mongoose.model('Offer', OfferSchema);
