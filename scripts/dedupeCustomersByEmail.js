"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const Customer = require("../models/Customer");

function pickMongoUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    ""
  );
}

function safeText(v) {
  return String(v ?? "").trim();
}

function keyOf(doc) {
  const owner = safeText(doc?.owner);
  const emailLower = safeText(doc?.emailLower).toLowerCase();
  return owner && emailLower ? `${owner}::${emailLower}` : "";
}

function bookingKey(b) {
  const bookingId = safeText(b?.bookingId);
  if (bookingId) return `bid:${bookingId}`;
  const id = safeText(b?._id);
  return id ? `sid:${id}` : "";
}

function mergeBookings(into, from) {
  const list = Array.isArray(into.bookings) ? into.bookings : [];
  const seen = new Set(list.map(bookingKey).filter(Boolean));

  for (const b of from.bookings || []) {
    const k = bookingKey(b);
    if (!k || seen.has(k)) continue;
    list.push(b);
    seen.add(k);
  }

  into.bookings = list;
}

function scoreCustomer(c) {
  const bookings = Array.isArray(c?.bookings) ? c.bookings.length : 0;
  const hasUserId = c?.userId != null ? 1 : 0;
  const updated = c?.updatedAt ? new Date(c.updatedAt).getTime() : 0;
  return bookings * 100000 + hasUserId * 1000 + updated;
}

async function run() {
  const uri = pickMongoUri();
  if (!uri) {
    throw new Error(
      "Missing Mongo URI in env (MONGODB_URI / MONGO_URI / MONGO_URL)",
    );
  }

  await mongoose.connect(uri);

  const customers = await Customer.find({
    emailLower: { $type: "string", $ne: "" },
  }).exec();

  const groups = new Map();
  for (const c of customers) {
    const k = keyOf(c);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const dupGroups = [...groups.values()].filter((arr) => arr.length > 1);

  console.log(`Customers total: ${customers.length}`);
  console.log(`Duplicate groups: ${dupGroups.length}`);

  let merged = 0;
  let removed = 0;

  for (const group of dupGroups) {
    group.sort((a, b) => scoreCustomer(b) - scoreCustomer(a));
    const keep = group[0];
    const trash = group.slice(1);

    for (const t of trash) {
      mergeBookings(keep, t);
    }

    await keep.save();

    const ids = trash.map((t) => t._id);
    const del = await Customer.deleteMany({ _id: { $in: ids } }).exec();

    merged += 1;
    removed += del.deletedCount || 0;

    console.log(
      `Merged group owner=${keep.owner} emailLower=${keep.emailLower} keep=${keep._id} removed=${del.deletedCount}`,
    );
  }

  console.log(`Done. Merged groups: ${merged}, removed docs: ${removed}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
