"use strict";

const mongoose = require("mongoose");

const LocalizedTextSchema = new mongoose.Schema(
  {
    de: { type: String, trim: true, default: "" },
    en: { type: String, trim: true, default: "" },
    tr: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const FeedbackSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: ["parents", "players", "coaches", "partners"],
      required: true,
      index: true,
    },
    imageUrl: { type: String, trim: true, default: "" },
    quote: { type: LocalizedTextSchema, required: true },
    author: { type: String, trim: true, required: true },
    meta: { type: LocalizedTextSchema, default: {} },
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

FeedbackSchema.index({ isActive: 1, sortOrder: 1, createdAt: -1 });
FeedbackSchema.index({ category: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("Feedback", FeedbackSchema);
