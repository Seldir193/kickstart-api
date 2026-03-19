"use strict";

const ALLOWED_STATUS = [
  "pending",
  "processing",
  "confirmed",
  "cancelled",
  "deleted",
];

function normalizeStatus(s) {
  return s === "canceled" ? "cancelled" : s;
}

module.exports = {
  ALLOWED_STATUS,
  normalizeStatus,
};
