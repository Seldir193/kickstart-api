"use strict";

const mongoose = require("mongoose");
const { Types } = mongoose;

function getProviderIdRaw(req) {
  const v = req.get("x-provider-id");
  return v ? String(v).trim() : null;
}

function getProviderObjectId(req) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) return null;
  return new Types.ObjectId(raw);
}

module.exports = { getProviderIdRaw, getProviderObjectId };
