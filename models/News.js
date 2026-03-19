// models/News.js
"use strict";
const mongoose = require("mongoose");

const MediaSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["image", "video"], required: true },
    url: { type: String, required: true },
    alt: { type: String, default: "" },
    title: { type: String, default: "" },
  },
  { _id: false },
);

const DraftSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true },
    slug: { type: String, lowercase: true, trim: true },
    category: {
      type: String,
      enum: ["Allgemein", "News", "Partnerverein", "Projekte"],
    },
    tags: { type: [String], default: [] },
    excerpt: { type: String, default: "" },
    content: { type: String, default: "" },
    coverImage: { type: String, default: "" },
    media: { type: [MediaSchema], default: [] },
  },
  { _id: false },
);

const NewsSchema = new mongoose.Schema(
  {
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      index: true,
    },

    date: { type: Date, required: true, index: true },
    title: { type: String, required: true, trim: true },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    category: {
      type: String,
      enum: ["Allgemein", "News", "Partnerverein", "Projekte"],
      default: "News",
      index: true,
    },

    tags: { type: [String], default: [], index: true },

    excerpt: { type: String, default: "" },
    content: { type: String, default: "" },
    coverImage: { type: String, default: "" },
    media: { type: [MediaSchema], default: [] },

    // Coaches-Pattern: status als Hauptzustand
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    // Switch: published nur relevant wenn status==="approved" (Regel enforced in API)
    published: { type: Boolean, default: true, index: true },

    // Legacy / UI-Flags: erstmal behalten (werden ggf. später abgelöst)
    everPublished: { type: Boolean, default: false, index: true },

    approvedAt: { type: Date, default: null, index: true },
    liveUpdatedAt: { type: Date, default: null, index: true },
    submittedAt: { type: Date, default: null, index: true },

    correctionRequired: { type: Boolean, default: false, index: true },
    correctionRequestedAt: { type: Date, default: null },
    correctionFixedAt: { type: Date, default: null },

    rejectionReason: { type: String, default: "", index: true },
    rejectedAt: { type: Date, default: null },

    lastProviderEditAt: { type: Date, default: null, index: true },
    lastSuperEditAt: { type: Date, default: null, index: true },

    hasDraft: { type: Boolean, default: false, index: true },
    draftUpdatedAt: { type: Date, default: null, index: true },
    draft: { type: DraftSchema, default: {} },
  },
  { timestamps: true },
);

NewsSchema.index({ title: "text", excerpt: "text", content: "text" });
NewsSchema.index({ providerId: 1, published: 1, date: -1 });
NewsSchema.index({ providerId: 1, rejectionReason: 1, published: 1, date: -1 });
NewsSchema.index({ submittedAt: 1, published: 1 });

module.exports = mongoose.model("News", NewsSchema);

// // models/News.js
// "use strict";
// const mongoose = require("mongoose");

// const MediaSchema = new mongoose.Schema(
//   {
//     type: { type: String, enum: ["image", "video"], required: true },
//     url: { type: String, required: true },
//     alt: { type: String, default: "" },
//     title: { type: String, default: "" },
//   },
//   { _id: false },
// );

// const DraftSchema = new mongoose.Schema(
//   {
//     title: { type: String, trim: true },
//     slug: { type: String, lowercase: true, trim: true },
//     category: {
//       type: String,
//       enum: ["Allgemein", "News", "Partnerverein", "Projekte"],
//     },
//     tags: { type: [String], default: [] },
//     excerpt: { type: String, default: "" },
//     content: { type: String, default: "" },
//     coverImage: { type: String, default: "" },
//     media: { type: [MediaSchema], default: [] },
//   },
//   { _id: false },
// );

// const NewsSchema = new mongoose.Schema(
//   {
//     providerId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "AdminUser",
//       index: true,
//     },

//     date: { type: Date, required: true, index: true },
//     title: { type: String, required: true, trim: true },

//     slug: {
//       type: String,
//       required: true,
//       unique: true,
//       lowercase: true,
//       trim: true,
//     },

//     category: {
//       type: String,
//       enum: ["Allgemein", "News", "Partnerverein", "Projekte"],
//       default: "News",
//       index: true,
//     },

//     tags: { type: [String], default: [], index: true },

//     excerpt: { type: String, default: "" },
//     content: { type: String, default: "" },
//     coverImage: { type: String, default: "" },
//     media: { type: [MediaSchema], default: [] },

//     published: { type: Boolean, default: true, index: true },

//     everPublished: { type: Boolean, default: false, index: true },

//     approvedAt: { type: Date, default: null, index: true },
//     liveUpdatedAt: { type: Date, default: null, index: true },
//     submittedAt: { type: Date, default: null, index: true },

//     correctionRequired: { type: Boolean, default: false, index: true },
//     correctionRequestedAt: { type: Date, default: null },
//     correctionFixedAt: { type: Date, default: null },

//     rejectionReason: { type: String, default: "", index: true },
//     rejectedAt: { type: Date, default: null },

//     lastProviderEditAt: { type: Date, default: null, index: true },
//     lastSuperEditAt: { type: Date, default: null, index: true },

//     hasDraft: { type: Boolean, default: false, index: true },
//     draftUpdatedAt: { type: Date, default: null, index: true },
//     draft: { type: DraftSchema, default: {} },
//   },
//   { timestamps: true },
// );

// NewsSchema.index({ title: "text", excerpt: "text", content: "text" });
// NewsSchema.index({ providerId: 1, published: 1, date: -1 });
// NewsSchema.index({ providerId: 1, rejectionReason: 1, published: 1, date: -1 });
// NewsSchema.index({ submittedAt: 1, published: 1 });

// module.exports = mongoose.model("News", NewsSchema);
