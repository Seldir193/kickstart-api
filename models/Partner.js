"use strict";

const mongoose = require("mongoose");

const PartnerSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    normalizedName: { type: String, trim: true, required: true, index: true },
    logoUrl: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 100, index: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
  },
  { timestamps: true },
);

PartnerSchema.index({ normalizedName: 1 }, { unique: true });
PartnerSchema.index({ isActive: 1, sortOrder: 1, createdAt: -1 });

module.exports = mongoose.model("Partner", PartnerSchema);
