// models/FranchiseLocation.js
"use strict";

const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

function cleanStr(v) {
  return String(v || "").trim();
}

function normalizeStr(v) {
  return cleanStr(v)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildCanonicalKey(doc) {
  const country = normalizeStr(doc.country);
  const city = normalizeStr(doc.city);
  const state = normalizeStr(doc.state);
  if (!country || !city) return "";
  return `${country}|${city}|${state || ""}`;
}

const franchiseLocationSchema = new Schema(
  {
    owner: {
      type: Types.ObjectId,
      ref: "AdminUser",
      required: true,
      index: true,
    },

    licenseeFirstName: { type: String, default: "", trim: true },
    licenseeLastName: { type: String, default: "", trim: true },

    country: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, default: "", trim: true },

    address: { type: String, default: "", trim: true },
    zip: { type: String, default: "", trim: true },

    website: { type: String, default: "", trim: true },
    emailPublic: { type: String, default: "", trim: true },
    phonePublic: { type: String, default: "", trim: true },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    published: { type: Boolean, default: false, index: true },

    rejectionReason: { type: String, default: "", trim: true },

    moderatedAt: { type: Date, default: null },

    approvedAt: { type: Date, default: null, index: true },
    liveUpdatedAt: { type: Date, default: null, index: true },
    draftUpdatedAt: { type: Date, default: null, index: true },
    rejectedAt: { type: Date, default: null, index: true },
    submittedAt: { type: Date, default: null, index: true },

    lastProviderEditAt: { type: Date, default: null },
    lastSuperEditAt: { type: Date, default: null },

    hasDraft: { type: Boolean, default: false, index: true },
    draft: { type: Object, default: {} },

    canonicalKey: { type: String, default: "", index: true },
  },
  { timestamps: true },
);

franchiseLocationSchema.pre("validate", function (next) {
  this.canonicalKey = buildCanonicalKey(this);
  next();
});

franchiseLocationSchema.index(
  { owner: 1, canonicalKey: 1 },
  {
    unique: true,
    partialFilterExpression: { canonicalKey: { $type: "string", $ne: "" } },
  },
);

module.exports =
  mongoose.models.FranchiseLocation ||
  mongoose.model("FranchiseLocation", franchiseLocationSchema);

// // models/FranchiseLocation.js
// "use strict";
// const mongoose = require("mongoose");
// const { Schema, Types } = mongoose;

// function normalizeStr(s) {
//   return String(s || "")
//     .normalize("NFD")
//     .replace(/\p{Diacritic}/gu, "")
//     .toLowerCase()
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function buildCanonicalKey(doc) {
//   const country = normalizeStr(doc.country);
//   const city = normalizeStr(doc.city);
//   const state = normalizeStr(doc.state);
//   if (!country || !city) return "";
//   return `${country}|${city}|${state || ""}`;
// }

// const FranchiseLocationSchema = new Schema(
//   {
//     owner: {
//       type: Types.ObjectId,
//       ref: "AdminUser",
//       required: true,
//       index: true,
//     },

//     licenseeFirstName: { type: String, default: "", trim: true },
//     licenseeLastName: { type: String, default: "", trim: true },

//     country: { type: String, required: true, trim: true },
//     city: { type: String, required: true, trim: true },
//     state: { type: String, default: "", trim: true },

//     address: { type: String, default: "", trim: true },
//     zip: { type: String, default: "", trim: true },

//     website: { type: String, default: "", trim: true },
//     emailPublic: { type: String, default: "", trim: true },
//     phonePublic: { type: String, default: "", trim: true },

//     status: {
//       type: String,
//       enum: ["pending", "approved", "rejected"],
//       default: "pending",
//       index: true,
//     },
//     rejectionReason: { type: String, default: "", trim: true },

//     moderatedAt: { type: Date, default: null },

//     approvedAt: { type: Date, default: null, index: true },
//     liveUpdatedAt: { type: Date, default: null, index: true },
//     draftUpdatedAt: { type: Date, default: null, index: true },
//     rejectedAt: { type: Date, default: null, index: true },

//     submittedAt: { type: Date, default: null, index: true },

//     lastProviderEditAt: { type: Date, default: null },
//     lastSuperEditAt: { type: Date, default: null },

//     hasDraft: { type: Boolean, default: false, index: true },
//     draft: { type: Object, default: {} },

//     canonicalKey: { type: String, default: "", index: true },
//   },
//   { timestamps: true },
// );

// FranchiseLocationSchema.pre("validate", function (next) {
//   this.canonicalKey = buildCanonicalKey(this);
//   next();
// });

// FranchiseLocationSchema.index(
//   { owner: 1, canonicalKey: 1 },
//   {
//     unique: true,
//     partialFilterExpression: { canonicalKey: { $type: "string", $ne: "" } },
//   },
// );

// module.exports =
//   mongoose.models.FranchiseLocation ||
//   mongoose.model("FranchiseLocation", FranchiseLocationSchema);

// // models/FranchiseLocation.js
// "use strict";
// const mongoose = require("mongoose");
// const { Schema, Types } = mongoose;

// function normalizeStr(s) {
//   return String(s || "")
//     .normalize("NFD")
//     .replace(/\p{Diacritic}/gu, "")
//     .toLowerCase()
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function buildCanonicalKey(doc) {
//   const country = normalizeStr(doc.country);
//   const city = normalizeStr(doc.city);
//   const state = normalizeStr(doc.state);
//   if (!country || !city) return "";
//   return `${country}|${city}|${state || ""}`;
// }

// const FranchiseLocationSchema = new Schema(
//   {
//     owner: {
//       type: Types.ObjectId,
//       ref: "AdminUser",
//       required: true,
//       index: true,
//     },

//     /** ✅ NEW: real name per location (NOT from AdminUser) */
//     licenseeFirstName: { type: String, default: "", trim: true },
//     licenseeLastName: { type: String, default: "", trim: true },

//     country: { type: String, required: true, trim: true },
//     city: { type: String, required: true, trim: true },
//     state: { type: String, default: "", trim: true }, // Bundesland/Region

//     address: { type: String, default: "", trim: true },
//     zip: { type: String, default: "", trim: true },

//     website: { type: String, default: "", trim: true },
//     emailPublic: { type: String, default: "", trim: true },
//     phonePublic: { type: String, default: "", trim: true },

//     status: {
//       type: String,
//       enum: ["pending", "approved", "rejected"],
//       default: "pending",
//       index: true,
//     },
//     rejectionReason: { type: String, default: "", trim: true },

//     moderatedAt: { type: Date, default: null },

//     canonicalKey: { type: String, default: "", index: true },
//   },
//   { timestamps: true }
// );

// FranchiseLocationSchema.pre("validate", function (next) {
//   this.canonicalKey = buildCanonicalKey(this);
//   next();
// });

// // pro Owner keine Duplikate für country+city+state
// FranchiseLocationSchema.index(
//   { owner: 1, canonicalKey: 1 },
//   {
//     unique: true,
//     partialFilterExpression: { canonicalKey: { $type: "string", $ne: "" } },
//   }
// );

// module.exports =
//   mongoose.models.FranchiseLocation ||
//   mongoose.model("FranchiseLocation", FranchiseLocationSchema);
