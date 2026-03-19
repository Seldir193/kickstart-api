const Stripe = require("stripe");
require("dotenv").config();

async function main() {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const subId = process.argv[2];
  if (!subId) {
    console.error(
      "Usage: node scripts/debugStripeSubscriptionRefundAnchor.js <subscriptionId>",
    );
    process.exit(1);
  }

  const sub = await stripe.subscriptions.retrieve(subId);
  console.log("SUB:", {
    id: sub.id,
    status: sub.status,
    latest_invoice: sub.latest_invoice,
  });

  if (!sub.latest_invoice) {
    console.log("No latest_invoice found.");
    return;
  }

  const invoice = await stripe.invoices.retrieve(sub.latest_invoice);
  console.log("INVOICE:", {
    id: invoice.id,
    payment_intent: invoice.payment_intent,
    charge: invoice.charge,
  });

  const pays = await stripe.invoicePayments.list({
    invoice: invoice.id,
    limit: 5,
  });

  console.log("INVOICE PAYMENTS:");
  console.log(JSON.stringify(pays.data, null, 2));
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
