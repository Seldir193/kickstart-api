"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Offer = require("../models/Offer");
const {
  ensureCustomerForPaidBooking,
} = require("../routes/payments/stripe/lib/customerSync");

function envFirst(...keys) {
  for (const k of keys) {
    const v = String(process.env[k] || "").trim();
    if (v) return v;
  }
  return "";
}

function safeStr(v) {
  return String(v ?? "").trim();
}

async function connectDb() {
  const uri = envFirst("MONGO_URI", "MONGODB_URI", "DATABASE_URL");
  if (!uri) throw new Error("Missing MONGO_URI/MONGODB_URI/DATABASE_URL");
  await mongoose.connect(uri);
}

async function loadOfferForBooking(booking) {
  const id = booking?.offerId;
  const owner = booking?.owner;
  if (!id || !owner) return null;

  const offer = await Offer.findOne({ _id: id, owner })
    .select("_id owner title type sub_type category location price")
    .lean();

  return offer || null;
}

function offerFallbackFromBooking(booking) {
  return {
    category: "Weekly",
    type: safeStr(booking?.offerType) || "Foerdertraining",
    sub_type: safeStr(booking?.offerType) || "Foerdertraining",
    title: safeStr(booking?.offerTitle) || safeStr(booking?.offerType),
    location: safeStr(booking?.venue) || "",
    price:
      typeof booking?.priceMonthly === "number"
        ? booking.priceMonthly
        : undefined,
  };
}

async function processOne(booking) {
  const offer =
    (await loadOfferForBooking(booking)) || offerFallbackFromBooking(booking);
  await ensureCustomerForPaidBooking(booking, offer);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dry = args.has("--dry");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 0) : 0;

  await connectDb();

  const filter = {
    paymentStatus: "paid",
    $or: [{ customerId: { $exists: false } }, { customerId: null }],
  };

  const total = await Booking.countDocuments(filter);
  const target = limit > 0 ? Math.min(total, limit) : total;

  let scanned = 0;
  let fixed = 0;
  let failed = 0;

  const cursor = Booking.find(filter).sort({ createdAt: 1 }).cursor();

  for await (const booking of cursor) {
    scanned += 1;
    if (limit > 0 && scanned > limit) break;

    const id = safeStr(booking?._id);
    const owner = safeStr(booking?.owner);

    try {
      if (!dry) await processOne(booking);
      fixed += 1;
      console.log(`[ok] booking=${id} owner=${owner}`);
    } catch (e) {
      failed += 1;
      console.error(
        `[fail] booking=${id} owner=${owner} msg=${safeStr(e?.message || e)}`,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        total,
        target,
        scanned: Math.min(scanned, target),
        fixed,
        failed,
        dry,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(`[fatal] ${safeStr(e?.message || e)}`);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
