








// models/Booking.js
const { Schema, model } = require('mongoose');

const BookingSchema = new Schema(
  {
    // NEW: link to the selected offer (optional but recommended)
    offerId: { type: Schema.Types.ObjectId, ref: 'Offer', index: true },

    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    email:     { type: String, required: true, trim: true, lowercase: true, match: /.+@.+\..+/ },
    age:       { type: Number, required: true, min: 5, max: 19 },
    date:      { type: String, required: true }, // yyyy-mm-dd (keep string)
    level:     { type: String, enum: ['U8','U10','U12','U14','U16','U18'], required: true },
    message:   { type: String, default: '' },

    // existing fields
    status:    { type: String, enum: ['pending','confirmed','cancelled','processing','deleted'], default: 'pending', index: true },
    confirmationCode: { type: String, unique: true, sparse: true },
    confirmedAt: { type: Date },
    adminNote: { type: String, default: '' },
  },
  { timestamps: true }
);

// Virtuals (unchanged)
BookingSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});
BookingSchema.virtual('program').get(function () {
  return this.level; // alias, if you want to show "program" in emails/PDFs
});

// Indexes (unchanged)
BookingSchema.index({ createdAt: -1 });
BookingSchema.index({ status: 1, createdAt: -1 });

module.exports = model('Booking', BookingSchema);










