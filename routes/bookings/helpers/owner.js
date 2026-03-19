"use strict";

const mongoose = require("mongoose");

function resolveOwner(req) {
  const fromHeader = req.get("x-provider-id");
  const fallback = process.env.DEFAULT_OWNER_ID;
  const id = (fromHeader || fallback || "").trim();
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

module.exports = { resolveOwner };
