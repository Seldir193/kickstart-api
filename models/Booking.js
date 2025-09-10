// models/Booking.js
'use strict';

const { Schema, model, Types, models } = require('mongoose');

const { normalizeInvoiceNo } = require('../utils/pdfData');
/**
 * Optionales, separates Booking-Model (falls außerhalb von Customer benötigt).
 * Enthält parallele Felder zu den PDF-/Billing-Workflows.
 */
const BookingSchema = new Schema({
  /* Tenant / Provider */
  owner:   { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },

  /* Offer-Ref */
  offerId: { type: Types.ObjectId, ref: 'Offer', index: true },

  /* Customer-Daten (flach gespeichert) */
  firstName: { type: String, required: true, trim: true },
  lastName:  { type: String, required: true, trim: true },
  email:     { type: String, required: true, trim: true, lowercase: true, match: /.+@.+\..+/ },
  age:       { type: Number, required: true, min: 5, max: 19 },

  // Hinweis: historisch als String 'yyyy-mm-dd' genutzt – belassen für Kompatibilität
  date:      { type: String, required: true }, // 'yyyy-mm-dd'
  level:     { type: String, enum: ['U8','U10','U12','U14','U16','U18'], required: true },
  message:   { type: String, default: '' },

  /* Admin */
  status: {
    type: String,
    enum: ['pending','confirmed','cancelled','processing','deleted','storno'],
    default: 'pending',
    index: true,
  },
  confirmationCode: { type: String, unique: true, sparse: true },
  confirmedAt: { type: Date },
  adminNote:   { type: String, default: '' },

  /* Accounting / Preise */
  priceAtBooking: { type: Number }, // z. B. 65.00

  /* Rechnung (bei Bestätigung) */
 // invoiceNumber: { type: String, unique: true, sparse: true, index: true },
  //invoiceNo:     { type: String, default: '' }, // Alias/Legacy (nicht unique)

  invoiceNumber: { type: String, set: normalizeInvoiceNo, trim: true }, // kanonisch
  invoiceNo:     { type: String, set: normalizeInvoiceNo, trim: true }, 
  invoiceDate:   { type: Date },

  /* Kündigung */
  //cancellationNumber: { type: String, unique: true, sparse: true, index: true },
//  cancellationNo:     { type: String, default: '' }, // Alias (nicht unique)

  cancellationNumber: { type: String, set: normalizeInvoiceNo, trim: true },
  cancellationNo:     { type: String, set: normalizeInvoiceNo, trim: true },
  cancellationDate:   { type: Date },
  cancellationReason: { type: String, default: '' },

  /* Storno */
  //stornoNumber: { type: String, unique: true, sparse: true, index: true },
  //stornoNo:     { type: String, default: '' }, // Alias (nicht unique)

  stornoNumber: { type: String, set: normalizeInvoiceNo, trim: true },
  stornoNo:     { type: String, set: normalizeInvoiceNo, trim: true },
  stornoDate:   { type: Date },
  stornoAmount: { type: Number }, // z. B. 50.00
}, { timestamps: true });

/* Virtuals (Kompatibilität) */
BookingSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});
BookingSchema.virtual('program').get(function () {
  return this.level;
});

/* Indexe */
//BookingSchema.index({ owner: 1, createdAt: -1 });
//BookingSchema.index({ status: 1, createdAt: -1 });








BookingSchema.index({ owner: 1, createdAt: -1 });
BookingSchema.index({ status: 1, createdAt: -1 });

BookingSchema.index({ owner: 1, invoiceNumber: 1 },     { unique: true, sparse: true });
BookingSchema.index({ owner: 1, cancellationNumber: 1 },{ unique: true, sparse: true });
BookingSchema.index({ owner: 1, stornoNumber: 1 },      { unique: true, sparse: true });




module.exports = models.Booking || model('Booking', BookingSchema);
