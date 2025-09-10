











// models/Customer.js
'use strict';

const mongoose = require('mongoose');
const { Schema, Types } = mongoose;
const { normalizeInvoiceNo } = require('../utils/pdfData'); // für kanonische Rechnungsnummern

/* ================= Sub-Schemas ================= */

const AddressSchema = new Schema({
  street:  { type: String, default: '' },
  houseNo: { type: String, default: '' },
  zip:     { type: String, default: '' },
  city:    { type: String, default: '' },
}, { _id: false });

const ChildSchema = new Schema({
  firstName: { type: String, default: '' },
  lastName:  { type: String, default: '' },
  gender:    { type: String, enum: ['weiblich','männlich',''], default: '' },
  birthDate: { type: Date, default: null },
  club:      { type: String, default: '' },
}, { _id: false });

const ParentSchema = new Schema({
  salutation: { type: String, enum: ['Frau','Herr',''], default: '' },
  firstName:  { type: String, default: '' },
  lastName:   { type: String, default: '' },
  email:      { type: String, default: '' },
  phone:      { type: String, default: '' },
  phone2:     { type: String, default: '' },
}, { _id: false });

/**
 * Eingebettete Booking-Referenz im Customer-Dokument.
 * Felder sind kompatibel zu deinen Routen/PDF-Templates.
 */
const BookingRefSchema = new Schema({
  /* Offer-Snapshot */
  offerId:      { type: Schema.Types.ObjectId, ref: 'Offer', required: true },
  offerTitle:   { type: String, default: '' },
  offerType:    { type: String, default: '' },            // z. B. Kindergarten, Foerdertraining
  venue:        { type: String, default: '' },            // Ort/Snapshot
  date:         { type: Date,   default: null },          // Start-/Wunschdatum
  status:       { type: String, enum: ['active','cancelled','completed','pending'], default: 'active' },

  /* Kündigung */
  cancelDate:     { type: Date,   default: null },
  cancelReason:   { type: String, default: '' },
  cancellationNo: { type: String, default: '' },          // für cancellation-PDF

  /* Preise/Snapshots */
  currency:         { type: String, default: 'EUR' },
  priceMonthly:     { type: Number, default: null },      // Standardpreis zum Buchungszeitpunkt
  priceFirstMonth:  { type: Number, default: null },      // Pro-rata 1. Monat
  priceAtBooking:   { type: Number, default: null },      // fixer Preis (falls separat gesetzt)

  // Für participation.hbs (optional)
  monthlyAmount:    { type: Number, default: null },
  firstMonthAmount: { type: Number, default: null },

  /* Rechnung bei Bestätigung */
  invoiceNumber: { type: String, default: '', set: normalizeInvoiceNo, trim: true }, // kanonisch (z. B. KIGA-25-0044)
  invoiceNo:     { type: String, default: '' },                                     // Alias/Legacy
  invoiceDate:   { type: Date,   default: null },

  /* Storno */
  stornoNo:     { type: String, default: '' },
  stornoDate:   { type: Date,   default: null },
  stornoAmount: { type: Number, default: null },

  /* optionale Mehrfach-Referenzen (falls mehrere Rechnungen/Teilleistungen) */
  invoiceRefs: [{
    _id: false,
    number: { type: String, default: '' },
    date:   { type: Date,   default: null },
    amount: { type: Number, default: null },
    note:   { type: String, default: '' },
  }],
}, { _id: true, timestamps: true, minimize: false });

/* Zähler für laufende userId pro Provider (Tenant) */
const CounterSchema = new Schema({
  _id: { type: String, required: true }, // key: "customer:<ownerId>"
  seq: { type: Number, default: 0 },
}, { versionKey: false });

const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

/* ================= Hauptschema ================= */

const CustomerSchema = new Schema({
  owner:   { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },
  userId:  { type: Number, index: true }, // inkrementell pro owner

  newsletter: { type: Boolean, default: false },

  address:  { type: AddressSchema, default: () => ({}) },
  child:    { type: ChildSchema,   default: () => ({}) },
  parent:   { type: ParentSchema,  default: () => ({}) },

  notes:    { type: String, default: '' },
  bookings: { type: [BookingRefSchema], default: [] },

  /* Customer-weite Kündigung (optional, separat von einzelnen Buchungen) */
  canceledAt:         { type: Date, default: null },
  cancellationDate:   { type: Date, default: null },
  cancellationReason: { type: String, default: '' },
  cancellationNo:     { type: String, default: '' },
}, { timestamps: true });

/* Indexe */
CustomerSchema.index({ owner: 1, createdAt: -1 });
CustomerSchema.index({ userId: 1, owner: 1 });

/* Helper: nächste userId pro owner */
CustomerSchema.statics.nextUserIdForOwner = async function(ownerId) {
  const key = `customer:${ownerId.toString()}`;
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

module.exports = mongoose.models.Customer || mongoose.model('Customer', CustomerSchema);
