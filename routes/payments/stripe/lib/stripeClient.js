//routes\payments\stripe\lib\stripeClient.js
"use strict";

const Stripe = require("stripe");
const { requireEnv } = require("./env");

function stripeClient() {
  return new Stripe(requireEnv("STRIPE_SECRET_KEY"));
}

module.exports = { stripeClient };
