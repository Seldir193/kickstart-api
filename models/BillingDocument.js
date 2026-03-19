// //models\BillingDocument.js
// models/BillingDocument.js
"use strict";

const mongoose = require("mongoose");

const BillingDocumentSchema = new mongoose.Schema(
  {
    owner: { type: String, index: true, default: "" },
    kind: {
      type: String,
      enum: ["invoice", "storno", "cancellation", "dunning"],
      index: true,
      required: true,
    },
    stage: {
      type: String,
      enum: ["", "reminder", "dunning1", "dunning2", "final"],
      default: "",
      index: true,
    },
    category: { type: String, default: "billing", index: true },
    mimeType: { type: String, default: "application/pdf" },
    fileName: { type: String, required: true },
    filePath: { type: String, required: true },
    fileSize: { type: Number, default: 0 },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
    },

    customerNo: { type: String, index: true, default: "" },
    invoiceNo: { type: String, index: true, default: "" },
    invoiceDate: { type: Date, default: null },

    offerTitle: { type: String, default: "" },
    subject: { type: String, default: "" },

    sentAt: { type: Date, default: null, index: true },
    dueAt: { type: Date, default: null, index: true },

    feesSnapshot: { type: Object, default: {} },

    searchText: { type: String, default: "", index: true },

    createdBy: { type: String, default: "" },

    voidedAt: { type: Date, default: null, index: true },
    voidedReason: { type: String, default: "" },
    voidedBy: { type: String, default: "" },

    datevExportedAt: { type: Date, default: null, index: true },
    datevBatchId: { type: String, default: "", index: true },

    datevVoidedExportedAt: { type: Date, default: null, index: true },
    datevVoidedBatchId: { type: String, default: "", index: true },
  },
  { timestamps: true },
);

BillingDocumentSchema.index({ owner: 1, kind: 1, stage: 1, sentAt: -1 });
BillingDocumentSchema.index({ owner: 1, invoiceNo: 1 });
BillingDocumentSchema.index({ owner: 1, customerNo: 1 });
BillingDocumentSchema.index({ owner: 1, bookingId: 1 });

// module.exports =
//   mongoose.models.BillingDocument ||
//   mongoose.model("BillingDocument", BillingDocumentSchema);

module.exports = mongoose.models.BillingDocument
  ? mongoose.model("BillingDocument")
  : mongoose.model("BillingDocument", BillingDocumentSchema);

// "use strict";

// const mongoose = require("mongoose");

// const BillingDocumentSchema = new mongoose.Schema(
//   {
//     owner: { type: String, index: true, default: "" },
//     kind: {
//       type: String,
//       enum: ["invoice", "storno", "cancellation", "dunning"],
//       index: true,
//       required: true,
//     },
//     stage: {
//       type: String,
//       enum: ["", "reminder", "dunning1", "dunning2", "final"],
//       default: "",
//       index: true,
//     },
//     category: { type: String, default: "billing", index: true },
//     mimeType: { type: String, default: "application/pdf" },
//     fileName: { type: String, required: true },
//     filePath: { type: String, required: true },
//     fileSize: { type: Number, default: 0 },

//     bookingId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "Booking",
//       index: true,
//     },
//     customerId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "Customer",
//       index: true,
//     },

//     customerNo: { type: String, index: true, default: "" },
//     invoiceNo: { type: String, index: true, default: "" },
//     invoiceDate: { type: Date, default: null },

//     offerTitle: { type: String, default: "" },
//     subject: { type: String, default: "" },

//     sentAt: { type: Date, default: null, index: true },
//     dueAt: { type: Date, default: null, index: true },

//     feesSnapshot: { type: Object, default: {} },

//     searchText: { type: String, default: "", index: true },

//     createdBy: { type: String, default: "" },
//   },
//   { timestamps: true },
// );

// BillingDocumentSchema.index({ owner: 1, kind: 1, stage: 1, sentAt: -1 });
// BillingDocumentSchema.index({ owner: 1, invoiceNo: 1 });
// BillingDocumentSchema.index({ owner: 1, customerNo: 1 });
// BillingDocumentSchema.index({ owner: 1, bookingId: 1 });

// module.exports =
//   mongoose.models.BillingDocument ||
//   mongoose.model("BillingDocument", BillingDocumentSchema);
