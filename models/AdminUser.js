// models/AdminUser.js
// models/AdminUser.js
"use strict";

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema, model } = mongoose;

const AdminUserSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      match: /.+@.+\..+/,
    },

    passwordHash: { type: String, required: true },
    avatarUrl: { type: String, default: null },

    role: {
      type: String,
      enum: ["provider", "super"],
      default: "provider",
      index: true,
    },

    isOwner: { type: Boolean, default: false, index: true },
    // isActive: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true, index: true },

    resetToken: { type: String, index: true },
    resetTokenExp: { type: Date },
  },
  { timestamps: true },
);

AdminUserSchema.methods.comparePassword = function (pw) {
  return bcrypt.compare(pw, this.passwordHash);
};

module.exports = model("AdminUser", AdminUserSchema);

// "use strict";
// const mongoose = require("mongoose");
// const bcrypt = require("bcryptjs");

// const { Schema, model } = mongoose;

// const AdminUserSchema = new Schema(
//   {
//     // ✅ Signup bleibt nur fullName (kann Nickname sein)
//     fullName: { type: String, required: true, trim: true },

//     email: {
//       type: String,
//       required: true,
//       trim: true,
//       lowercase: true,
//       unique: true,
//       match: /.+@.+\..+/,
//     },

//     passwordHash: { type: String, required: true },
//     avatarUrl: { type: String, default: null },

//     role: {
//       type: String,
//       enum: ["provider", "super"],
//       default: "provider",
//       index: true,
//     },

//     resetToken: { type: String, index: true },
//     resetTokenExp: { type: Date },
//   },
//   { timestamps: true }
// );

// AdminUserSchema.methods.comparePassword = function (pw) {
//   return bcrypt.compare(pw, this.passwordHash);
// };

// module.exports = model("AdminUser", AdminUserSchema);
