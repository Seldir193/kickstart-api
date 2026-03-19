//routes\payments\stripe\routes\webhook.js
"use strict";

const { stripeClient } = require("../lib/stripeClient");
const { requireEnv } = require("../lib/env");
const {
  onCheckoutCompleted,
  onInvoicePaid,
  onInvoicePaymentFailed,
  onSubscriptionUpdated,
  onChargeFailed,
} = require("../webhook/handlers");

async function webhook(req, res) {
  let event;

  try {
    const stripe = stripeClient();
    const sig = req.headers["stripe-signature"];
    const secret = requireEnv("STRIPE_WEBHOOK_SECRET");
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error("[stripe] webhook signature error:", e?.message || e);
    return res.status(400).send("Webhook signature error");
  }

  try {
    const obj = event.data.object;

    if (event.type === "checkout.session.completed") {
      await onCheckoutCompleted(event, obj);
    }

    if (event.type === "invoice.paid") {
      await onInvoicePaid(event, obj);
    }

    // if (event.type === "invoice.payment_succeeded") {
    //   await onInvoicePaid(event, obj);
    // }

    // if (event.type === "invoice_payment.paid") {
    //   await onInvoicePaid(event, obj);
    // }

    if (event.type === "invoice.payment_failed") {
      await onInvoicePaymentFailed(event, obj);
    }

    if (event.type === "customer.subscription.updated") {
      await onSubscriptionUpdated(event, obj);
    }

    if (event.type === "customer.subscription.deleted") {
      await onSubscriptionUpdated(event, obj);
    }

    if (event.type === "charge.failed") {
      await onChargeFailed(event, obj);
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("[stripe] webhook handler error:", e?.message || e);
    return res.status(500).json({ received: false });
  }
}

module.exports = { webhook };

// //routes\payments\stripe\routes\webhook.js
// "use strict";

// const { stripeClient } = require("../lib/stripeClient");
// const { requireEnv } = require("../lib/env");
// const {
//   onCheckoutCompleted,
//   onInvoicePaid,
//   onInvoicePaymentFailed,
//   onSubscriptionUpdated,
//   onChargeFailed,
// } = require("../webhook/handlers");

// async function webhook(req, res) {
//   let event;
//   console.log("[stripe webhook] hit");
//   try {
//     const stripe = stripeClient();
//     const sig = req.headers["stripe-signature"];
//     const secret = requireEnv("STRIPE_WEBHOOK_SECRET");
//     event = stripe.webhooks.constructEvent(req.body, sig, secret);
//     console.log("[stripe webhook] type:", event.type);
//   } catch (e) {
//     console.error("[stripe] webhook signature error:", e?.message || e);
//     return res.status(400).send("Webhook signature error");
//   }

//   try {
//     const obj = event.data.object;
//     if (event.type === "checkout.session.completed")
//       await onCheckoutCompleted(event, obj);
//     if (event.type === "invoice.paid") await onInvoicePaid(event, obj);
//     if (event.type === "invoice.payment_succeeded")
//       await onInvoicePaid(event, obj);
//     if (event.type === "invoice_payment.paid") await onInvoicePaid(event, obj);
//     if (event.type === "invoice.payment_failed")
//       await onInvoicePaymentFailed(event, obj);
//     if (event.type === "customer.subscription.updated")
//       await onSubscriptionUpdated(event, obj);
//     if (event.type === "customer.subscription.deleted")
//       await onSubscriptionUpdated(event, obj);
//     if (event.type === "charge.failed") await onChargeFailed(event, obj);
//     return res.json({ received: true });
//   } catch (e) {
//     console.error("[stripe] webhook handler error:", e?.message || e);
//     return res.status(500).json({ received: false });
//   }
// }

// module.exports = { webhook };
