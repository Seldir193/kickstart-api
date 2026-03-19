"use strict";

const { Schema, model, models, Types } = require("mongoose");

const VoucherSchema = new Schema(
  {
    owner: {
      type: Types.ObjectId,
      ref: "AdminUser",
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

VoucherSchema.index({ owner: 1, code: 1 }, { unique: true });

module.exports = models.Voucher || model("Voucher", VoucherSchema);
