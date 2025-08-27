// models/AdminUser.js
const { Schema, model } = require('mongoose');
const bcrypt = require('bcryptjs');

const AdminUserSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      match: /.+@.+\..+/
    },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

AdminUserSchema.methods.comparePassword = function (pw) {
  return bcrypt.compare(pw, this.passwordHash);
};

module.exports = model('AdminUser', AdminUserSchema);
