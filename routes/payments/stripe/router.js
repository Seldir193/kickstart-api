//routes\payments\stripe\router.js
"use strict";

const express = require("express");
const { checkoutSession } = require("./routes/checkoutSession");
const {
  subscriptionCheckoutSession,
} = require("./routes/subscriptionCheckoutSession");
const { cancelSubscription } = require("./routes/cancelSubscription");
const { webhook } = require("./routes/webhook");

const {
  cancelSubscriptionRequest,
} = require("./routes/cancelSubscriptionRequest");
const { revokeRequest } = require("./routes/revokeRequest");

const { revokeByToken } = require("./routes/revokeByToken");

const router = express.Router();

router.get("/debug-route", (_req, res) => {
  res.json({ ok: true, route: "stripe router active" });
});

router.post(
  "/cancel-subscription-request",
  express.json(),
  cancelSubscriptionRequest,
);

router.post("/revoke-request", express.json(), revokeRequest);

router.post("/revoke-by-token", express.json(), revokeByToken);

router.post("/checkout-session", express.json(), checkoutSession);
router.post(
  "/subscription-checkout-session",
  express.json(),
  subscriptionCheckoutSession,
);
router.post("/cancel-subscription", express.json(), cancelSubscription);
router.post("/webhook", express.raw({ type: "application/json" }), webhook);

module.exports = router;
