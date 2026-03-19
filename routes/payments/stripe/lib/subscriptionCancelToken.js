"use strict";

const crypto = require("crypto");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createRawToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createCancelTokenPair() {
  const rawToken = createRawToken();
  const tokenHash = hashToken(rawToken);
  return { rawToken, tokenHash };
}

function buildCancelUrl(rawToken) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.BRAND_WEBSITE_URL ||
    "http://localhost:3000";

  return `${String(base).replace(/\/+$/, "")}/weekly/cancel?token=${encodeURIComponent(rawToken)}`;
}

module.exports = {
  hashToken,
  createCancelTokenPair,
  buildCancelUrl,
};
