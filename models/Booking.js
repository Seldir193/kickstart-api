const { Schema, model } = require('mongoose');

const BookingSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    email:     { type: String, required: true, trim: true, lowercase: true },
    age:       { type: Number, required: true, min: 5, max: 19 },
    date:      { type: String, required: true }, // yyyy-mm-dd
    level:     { type: String, enum: ['U8','U10','U12','U14','U16','U18'], required: true },
    message:   { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = model('Booking', BookingSchema);
