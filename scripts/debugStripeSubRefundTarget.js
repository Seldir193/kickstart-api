"use strict";

require("dotenv").config();

const Stripe = require("stripe");

function safe(v) {
  return String(v ?? "").trim();
}

async function run() {
  const key = safe(process.env.STRIPE_SECRET_KEY);
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY in .env");

  const subId = safe(process.argv[2]);
  if (!subId)
    throw new Error(
      "Usage: node scripts/debugStripeSubRefundTarget.js sub_...",
    );

  const stripe = new Stripe(key);

  const sub = await stripe.subscriptions.retrieve(subId, {
    expand: ["latest_invoice"],
  });
  console.log("\nSUB:", {
    id: sub.id,
    status: sub.status,
    latest_invoice:
      typeof sub.latest_invoice === "object"
        ? sub.latest_invoice.id
        : sub.latest_invoice,
  });

  const invList = await stripe.invoices.list({
    subscription: subId,
    limit: 10,
  });
  console.log("\nINVOICES (latest 10):");
  for (const inv of invList.data) {
    console.log({
      id: inv.id,
      status: inv.status,
      paid: inv.paid,
      payment_intent:
        typeof inv.payment_intent === "object"
          ? inv.payment_intent.id
          : inv.payment_intent,
      charge: inv.charge,
      hosted_invoice_url: inv.hosted_invoice_url,
      amount_paid: inv.amount_paid,
      amount_due: inv.amount_due,
    });
  }

  const payList = await stripe.invoicePayments
    .list({ invoice: invList.data?.[0]?.id })
    .catch(() => null);
  if (payList?.data?.length) {
    console.log("\nINVOICE PAYMENTS (first invoice):");
    console.log(
      payList.data.map((p) => ({
        id: p.id,
        payment: p.payment,
        status: p.status,
      })),
    );
  }

  console.log("\nDONE");
}

run().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
