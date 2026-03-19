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

function requireOwner(req, res) {
  const owner = getProviderObjectId(req);
  if (!owner) {
    res
      .status(401)
      .json({ ok: false, error: "Unauthorized: invalid provider id" });
    return null;
  }
  return owner;
}

module.exports = {
  getProviderIdRaw,
  getProviderObjectId,
  requireOwner,
};
