//models\Booking.js
"use strict";

const { Schema, model, Types, models } = require("mongoose");
const { normalizeInvoiceNo } = require("../utils/pdfData");

function invoiceSetter(v) {
  const s =
    typeof normalizeInvoiceNo === "function" ? normalizeInvoiceNo(v) : v;

  if (s == null) return undefined;
  const t = String(s).trim();
  return t || undefined;
}

const DunningFeeSnapshotSchema = new Schema(
  {
    returnBankFee: { type: Number, default: 0 },
    dunningFee: { type: Number, default: 0 },
    processingFee: { type: Number, default: 0 },
    totalExtraFees: { type: Number, default: 0 },
    currency: { type: String, default: "EUR" },
  },
  { _id: false },
);

const DunningEventSchema = new Schema(
  {
    stage: {
      type: String,
      enum: ["reminder", "dunning1", "dunning2", "final"],
      required: true,
    },
    sentAt: { type: Date, required: true, default: Date.now },
    dueAt: { type: Date, default: null },
    feesSnapshot: { type: DunningFeeSnapshotSchema, default: () => ({}) },
    toEmail: { type: String, default: "" },
    subject: { type: String, default: "" },
    templateVersion: { type: String, default: "default-v1" },
    note: { type: String, default: "" },
    sentBy: { type: Types.ObjectId, ref: "AdminUser", default: null },
  },
  { _id: true, minimize: false },
);

const BookingSchema = new Schema(
  {
    source: {
      type: String,
      enum: ["online_request", "admin_booking"],
      required: true,
      default: "online_request",
      index: true,
    },

    paymentStatus: {
      type: String,
      enum: ["open", "paid", "returned"],
      default: "open",
      index: true,
    },
    paidAt: { type: Date, default: null },
    returnedAt: { type: Date, default: null },

    returnBankFee: { type: Number, default: 0 },
    returnNote: { type: String, default: "" },

    dunningEvents: { type: [DunningEventSchema], default: [] },

    collectionStatus: {
      type: String,
      enum: ["none", "handed_over", "closed"],
      default: "none",
      index: true,
    },
    handedOverAt: { type: Date, default: null },
    handedOverNote: { type: String, default: "" },

    owner: {
      type: Types.ObjectId,
      ref: "AdminUser",
      required: true,
      index: true,
    },

    customerId: { type: Types.ObjectId, ref: "Customer", index: true },
    childId: { type: Types.ObjectId, ref: "Child", index: true },
    offerId: { type: Types.ObjectId, ref: "Offer", index: true },

    offerTitle: { type: String, default: "", trim: true },
    offerType: { type: String, default: "", trim: true },
    venue: { type: String, default: "", trim: true },
    childUid: { type: String, default: "", trim: true, index: true },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /.+@.+\..+/,
    },

    age: { type: Number, required: false, min: 5, max: 19, default: null },

    date: { type: String, required: true },

    level: {
      type: String,
      enum: ["", "U8", "U10", "U12", "U14", "U16", "U18"],
      required: false,
      default: "",
    },
    message: { type: String, default: "" },

    status: {
      type: String,
      enum: [
        "pending",
        "confirmed",
        "cancelled",
        "processing",
        "deleted",
        "storno",
      ],
      default: "pending",
      index: true,
    },

    previousStatus: {
      type: String,
      enum: ["pending", "processing", "confirmed", "cancelled", "deleted"],
      default: null,
    },

    confirmationCode: { type: String, unique: true, sparse: true },
    confirmedAt: { type: Date },
    cancelledAt: { type: Date, default: null },
    cancelDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    cancelReason: { type: String, default: "" },
    adminNote: { type: String, default: "" },

    priceAtBooking: { type: Number },
    currency: { type: String, default: "EUR" },
    priceMonthly: { type: Number, default: null },
    priceFirstMonth: { type: Number, default: null },

    meta: {
      type: Schema.Types.Mixed,
      default: {},
    },

    invoiceTo: {
      parent: {
        salutation: { type: String, default: "" },
        firstName: { type: String, default: "" },
        lastName: { type: String, default: "" },
        email: { type: String, default: "" },
        phone: { type: String, default: "" },
        phone2: { type: String, default: "" },
      },
      address: {
        street: { type: String, default: "" },
        houseNo: { type: String, default: "" },
        zip: { type: String, default: "" },
        city: { type: String, default: "" },
      },
    },

    stripe: {
      mode: {
        type: String,
        enum: ["", "payment", "subscription"],
        default: "",
      },
      checkoutSessionId: { type: String, default: "", index: true },
      paymentIntentId: { type: String, default: "", index: true },
      subscriptionId: { type: String, default: "", index: true },

      subStatus: { type: String, default: "" },
      currentPeriodStart: { type: Date, default: null },
      currentPeriodEnd: { type: Date, default: null },
      cancelRequestedAt: { type: Date, default: null },
      cancelEffectiveAt: { type: Date, default: null },

      lastEventId: { type: String, default: "" },
      lastEventType: { type: String, default: "" },
    },

    invoiceNumber: { type: String, set: invoiceSetter, trim: true },
    invoiceNo: { type: String, set: invoiceSetter, trim: true },
    invoiceDate: { type: Date },

    cancellationNo: { type: String, set: invoiceSetter, trim: true },
    cancellationDate: { type: Date },
    cancellationReason: { type: String, default: "" },

    stornoNumber: { type: String, set: invoiceSetter, trim: true },
    stornoNo: { type: String, set: invoiceSetter, trim: true },
    stornoDate: { type: Date },
    stornoAmount: { type: Number },

    subscriptionCancelTokenHash: { type: String, default: "" },
    subscriptionCancelTokenExpires: { type: Date, default: null },

    revocationToken: { type: String, default: "" },
    revocationTokenHash: { type: String, default: "" },
    revocationTokenExpires: { type: Date, default: null },

    newsletterToken: { type: String, default: null },
    newsletterTokenExpires: { type: Date, default: null },
    newsletterUnsubToken: { type: String, default: null },
  },
  { timestamps: true },
);

BookingSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

BookingSchema.virtual("program").get(function () {
  return this.level;
});

BookingSchema.index({ owner: 1, paymentStatus: 1, createdAt: -1 });
BookingSchema.index({ status: 1, createdAt: -1 });
BookingSchema.index({ revocationTokenHash: 1 });

BookingSchema.index(
  { owner: 1, invoiceNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      invoiceNumber: { $exists: true, $gt: "" },
    },
  },
);

module.exports = models.Booking || model("Booking", BookingSchema);
