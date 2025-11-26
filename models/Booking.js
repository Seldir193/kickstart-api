// models/Booking.js
'use strict';

const { Schema, model, Types, models } = require('mongoose');
const { normalizeInvoiceNo } = require('../utils/pdfData');

/**
 * Normalisiert Rechnungs-/Dokumentnummern.
 * - null/undefined/""  -> undefined (Feld wird nicht gespeichert)
 * - sonst: normalizeInvoiceNo (falls vorhanden) + trim
 */
function invoiceSetter(v) {
  const s = (typeof normalizeInvoiceNo === 'function') ? normalizeInvoiceNo(v) : v;
  if (s == null) return undefined;
  const t = String(s).trim();
  return t || undefined;
}

const BookingSchema = new Schema({
  /* Herkunft/Quelle der Buchung/Anfrage */
  source: {
    type: String,
    enum: ['online_request', 'admin_booking'],
    required: true,
    default: 'online_request',
    index: true,
  },

  /* Tenant / Provider */
  owner: { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },

  /* Referenzen */
  customerId: { type: Types.ObjectId, ref: 'Customer', index: true },   // NEU: zugeordnetes Elternprofil
  childId:    { type: Types.ObjectId, ref: 'Child',    index: true },   // NEU: konkretes Kind (Child-Model)

  /* Offer-Ref */
  offerId: { type: Types.ObjectId, ref: 'Offer', index: true },

  /* Customer-Daten (flach gespeichert) */
  firstName: { type: String, required: true, trim: true },
  lastName:  { type: String, required: true, trim: true },
  email:     { type: String, required: true, trim: true, lowercase: true, match: /.+@.+\..+/ },
  age:       { type: Number, required: true, min: 5, max: 19 },

  date:    { type: String, required: true }, // 'yyyy-mm-dd'
  level:   { type: String, enum: ['U8','U10','U12','U14','U16','U18'], required: true },
  message: { type: String, default: '' },

  /* Admin */
  status: {
    type: String,
    enum: ['pending','confirmed','cancelled','processing','deleted','storno'],
    default: 'pending',
    index: true,
  },

  previousStatus: {
    type: String,
    enum: ['pending', 'processing', 'confirmed', 'cancelled', 'deleted'],
    default: null,
  },

  confirmationCode: { type: String, unique: true, sparse: true },
  confirmedAt:      { type: Date },
  adminNote:        { type: String, default: '' },

  /* Accounting / Preise */
  priceAtBooking: { type: Number },

  /* Rechnung */
  invoiceNumber: { type: String, set: invoiceSetter, trim: true },
  invoiceNo:     { type: String, set: invoiceSetter, trim: true },
  invoiceDate:   { type: Date },

  /* Kündigung */
  // cancellationNumber: { type: String, set: invoiceSetter, trim: true },
  cancellationNo:     { type: String, set: invoiceSetter, trim: true },
  cancellationDate:   { type: Date },
  cancellationReason: { type: String, default: '' },

  /* Storno */
  stornoNumber: { type: String, set: invoiceSetter, trim: true },
  stornoNo:     { type: String, set: invoiceSetter, trim: true },
  stornoDate:   { type: Date },
  stornoAmount: { type: Number },

  newsletterToken:        { type: String, default: null },
  newsletterTokenExpires: { type: Date,   default: null },
  newsletterUnsubToken:   { type: String, default: null },

}, { timestamps: true });

/* Virtuelle Felder */
BookingSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});
BookingSchema.virtual('program').get(function () {
  return this.level;
});

/* Indexe */
BookingSchema.index({ owner: 1, createdAt: -1 });
BookingSchema.index({ status: 1, createdAt: -1 });

/**
 * Partial-Unique-Index, damit mehrere Dokumente ohne invoiceNumber erlaubt sind.
 * Greift nur, wenn invoiceNumber existiert und NICHT leer ist.
 */
BookingSchema.index(
  { owner: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { invoiceNumber: { $exists: true, $gt: '' } } }
);

// export
module.exports = models.Booking || model('Booking', BookingSchema);


