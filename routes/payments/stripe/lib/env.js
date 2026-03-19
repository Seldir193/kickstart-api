//routes\payments\stripe\lib\env.js
"use strict";

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function publicBase() {
  return String(process.env.FRONTEND_ORIGIN || "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
}

function successUrl() {
  return `${publicBase()}/book/success?session_id={CHECKOUT_SESSION_ID}`;
}

function cancelUrl() {
  return `${publicBase()}/book/cancel`;
}

module.exports = { requireEnv, publicBase, successUrl, cancelUrl };
