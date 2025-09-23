// models/Customer.js
'use strict';

const mongoose = require('mongoose');
const { Schema, Types } = mongoose;
const { normalizeInvoiceNo } = require('../utils/pdfData');

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

const BookingRefSchema = new Schema({
  bookingId:    { type: Schema.Types.ObjectId, ref: 'Booking' },

  offerId:      { type: Schema.Types.ObjectId, ref: 'Offer', required: true },
  offerTitle:   { type: String, default: '' },
  offerType:    { type: String, default: '' },
  venue:        { type: String, default: '' },
  date:         { type: Date,   default: null },
  status:       { type: String, enum: ['active','cancelled','completed','pending'], default: 'active' },

  cancelDate:     { type: Date,   default: null },
  cancelReason:   { type: String, default: '' },
  cancellationNo: { type: String, default: '' },

  currency:         { type: String, default: 'EUR' },
  priceMonthly:     { type: Number, default: null },
  priceFirstMonth:  { type: Number, default: null },
  priceAtBooking:   { type: Number, default: null },

  monthlyAmount:    { type: Number, default: null },
  firstMonthAmount: { type: Number, default: null },

  invoiceNumber: { type: String, default: '', set: normalizeInvoiceNo, trim: true },
  invoiceNo:     { type: String, default: '' },
  invoiceDate:   { type: Date,   default: null },

  stornoNo:     { type: String, default: '' },
  stornoDate:   { type: Date,   default: null },
  stornoAmount: { type: Number, default: null },

  invoiceRefs: [{
    _id: false,
    number: { type: String, default: '' },
    date:   { type: Date,   default: null },
    amount: { type: Number, default: null },
    note:   { type: String, default: '' },
  }],
}, { _id: true, timestamps: true, minimize: false });

const CounterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
}, { versionKey: false });

const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

const CustomerSchema = new Schema({
  owner:   { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },
  userId:  { type: Number, index: true },

  // wichtige Suchfelder
  email:      { type: String, default: '' },
  emailLower: { type: String, default: '' },

  newsletter: { type: Boolean, default: false },

  address:  { type: AddressSchema, default: () => ({}) },
  child:    { type: ChildSchema,   default: () => ({}) },
  parent:   { type: ParentSchema,  default: () => ({}) },

  notes:    { type: String, default: '' },
  bookings: { type: [BookingRefSchema], default: [] },

  canceledAt:         { type: Date, default: null },
  cancellationDate:   { type: Date, default: null },
  cancellationReason: { type: String, default: '' },
  cancellationNo:     { type: String, default: '' },

  // Marketing-/Newsletter
  marketingProvider:     { type: String, enum: ['mailchimp','brevo','sendgrid', null], default: null },
  marketingStatus:       { type: String, enum: ['subscribed','pending','unsubscribed','error', null], default: null },
  marketingContactId:    { type: String, default: null },
  marketingLastSyncedAt: { type: Date,   default: null },
  marketingLastError:    { type: String, default: null },
  marketingConsentAt:    { type: Date,   default: null },

}, { timestamps: true });

CustomerSchema.index({ owner: 1, createdAt: -1 });
CustomerSchema.index({ userId: 1, owner: 1 });
CustomerSchema.index({ owner: 1, emailLower: 1 }, { sparse: true });
CustomerSchema.index({ owner: 1, 'parent.email': 1 }, { sparse: true });

CustomerSchema.statics.nextUserIdForOwner = async function(ownerId) {
  const key = `customer:${ownerId.toString()}`;
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

// Counter mindestens auf aktuellen Max(userId) bringen
CustomerSchema.statics.syncCounterWithExisting = async function(ownerId) {
  const key = `customer:${ownerId.toString()}`;
  const maxRow = await this.findOne({ owner: ownerId, userId: { $ne: null } })
    .sort({ userId: -1 })
    .select('userId')
    .lean();
  const max = maxRow?.userId ?? 0;
  await Counter.findOneAndUpdate(
    { _id: key },
    { $max: { seq: max } },
    { new: true, upsert: true }
  );
};

// fehlende userId fortlaufend vergeben
CustomerSchema.statics.assignUserIdIfMissing = async function(customerDoc) {
  if (customerDoc.userId != null) return customerDoc.userId;
  await this.syncCounterWithExisting(customerDoc.owner);
  const next = await this.nextUserIdForOwner(customerDoc.owner);
  customerDoc.userId = next;
  await customerDoc.save();
  return next;
};

module.exports = mongoose.models.Customer || mongoose.model('Customer', CustomerSchema);









