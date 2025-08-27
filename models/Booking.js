// models/Booking.js
const { Schema, model, Types } = require('mongoose');

const BookingSchema = new Schema(
  {
    // MANDANT: Anbieter/Owner (AdminUser._id)
    owner: { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true }, // <— NEU

    // Bezug zum Angebot
    offerId: { type: Types.ObjectId, ref: 'Offer', index: true },

    // Kundendaten
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    email:     { type: String, required: true, trim: true, lowercase: true, match: /.+@.+\..+/ },
    age:       { type: Number, required: true, min: 5, max: 19 },
    date:      { type: String, required: true }, // yyyy-mm-dd (String beibehalten)
    level:     { type: String, enum: ['U8','U10','U12','U14','U16','U18'], required: true },
    message:   { type: String, default: '' },

    // Admin-Felder
    status:    { type: String, enum: ['pending','confirmed','cancelled','processing','deleted'], default: 'pending', index: true },
    confirmationCode: { type: String, unique: true, sparse: true },
    confirmedAt: { type: Date },
    adminNote: { type: String, default: '' },
  },
  { timestamps: true }
);

// Virtuals
BookingSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});
BookingSchema.virtual('program').get(function () {
  return this.level;
});

// Indizes
BookingSchema.index({ owner: 1, createdAt: -1 });     // <— NEU: typischer Owner-Scope
BookingSchema.index({ status: 1, createdAt: -1 });

module.exports = model('Booking', BookingSchema);





