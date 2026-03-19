// routes/datev/helpers/ownerHelpers.js
"use strict";

const mongoose = require("mongoose");

function getProviderIdRaw(req) {
  const value = req.get("x-provider-id");
  return value ? String(value).trim() : null;
}

function isValidProviderId(rawId) {
  return Boolean(rawId && mongoose.isValidObjectId(rawId));
}

function getProviderObjectId(req) {
  const rawId = getProviderIdRaw(req);
  if (!isValidProviderId(rawId)) return null;
  return new mongoose.Types.ObjectId(rawId);
}

function buildUnauthorizedError() {
  return {
    ok: false,
    error: "Unauthorized: invalid provider id",
  };
}

function requireOwner(req, res) {
  const owner = getProviderObjectId(req);
  if (owner) return owner;
  res.status(401).json(buildUnauthorizedError());
  return null;
}

module.exports = {
  getProviderIdRaw,
  getProviderObjectId,
  requireOwner,
};
