// models/Customer.js
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

/** Embedded booking reference inside Customer */
const BookingRefSchema = new Schema({
  offerId:      { type: Schema.Types.ObjectId, ref: 'Offer', required: true },
  offerTitle:   { type: String, default: '' },
  offerType:    { type: String, default: '' },   // e.g., Kindergarten, Foerdertraining
  date:         { type: Date,   default: null }, // start/wish date
  status:       { type: String, enum: ['active','cancelled','completed','pending'], default: 'active' },
  cancelDate:   { type: Date,   default: null },
  cancelReason: { type: String, default: '' },

  // --- NEW: pricing snapshot at booking time ---
  currency:        { type: String, default: 'EUR' },
  priceMonthly:    { type: Number, default: null }, // standard monthly price at booking time
  priceFirstMonth: { type: Number, default: null }, // pro-rata first month at start date

  // optional lightweight references (future use)
  invoiceRefs: [{
    _id: false,
    number: { type: String, default: '' },
    date:   { type: Date, default: null },
    amount: { type: Number, default: null },
    note:   { type: String, default: '' },
  }],
}, { _id: true, timestamps: true });


/** Counter per provider to assign incremental userId */
const CounterSchema = new Schema({
  _id: { type: String, required: true }, // key: "customer:<ownerId>"
  seq: { type: Number, default: 0 },
}, { versionKey: false });

const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

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

const CustomerSchema = new Schema({
  owner:   { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },
  userId:  { type: Number, index: true }, // incremental per owner

  newsletter: { type: Boolean, default: false },

  address:  { type: AddressSchema, default: () => ({}) },
  child:    { type: ChildSchema,   default: () => ({}) },
  parent:   { type: ParentSchema,  default: () => ({}) },

  notes:    { type: String, default: '' },
  bookings: { type: [BookingRefSchema], default: [] },

  canceledAt:          { type: Date, default: null },
  cancellationDate:    { type: Date, default: null },
  cancellationReason:  { type: String, default: '' },
}, { timestamps: true });

/** Helper: next incremental userId per owner */
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



