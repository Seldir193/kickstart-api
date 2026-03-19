// scripts/backfillCustomerBookingChildUids.js
"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const Customer = require("../models/Customer");

function safeText(v) {
  return String(v ?? "").trim();
}

function isoDay(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function low(v) {
  return safeText(v).toLowerCase();
}

function childKey(firstName, lastName, birthDate) {
  return `${low(firstName)}::${low(lastName)}::${isoDay(birthDate)}`;
}

function pickChildUid(customer, ref) {
  const children = Array.isArray(customer?.children) ? customer.children : [];
  const legacy = customer?.child || null;

  const rf = safeText(ref?.childFirstName || ref?.childFirst || ref?.firstName);
  const rl = safeText(ref?.childLastName || ref?.childLast || ref?.lastName);
  const rb = ref?.childBirthDate || ref?.birthDate || null;

  const hasNames = !!(rf || rl);

  if (hasNames) {
    const want = childKey(rf, rl, rb);
    const hit = children.find(
      (ch) => childKey(ch?.firstName, ch?.lastName, ch?.birthDate) === want,
    );
    if (safeText(hit?.uid)) {
      return {
        uid: safeText(hit.uid),
        firstName: safeText(hit.firstName),
        lastName: safeText(hit.lastName),
      };
    }

    const loose = children.find(
      (ch) => low(ch?.firstName) === low(rf) && low(ch?.lastName) === low(rl),
    );
    if (safeText(loose?.uid)) {
      return {
        uid: safeText(loose.uid),
        firstName: safeText(loose.firstName),
        lastName: safeText(loose.lastName),
      };
    }
  }

  if (safeText(legacy?.uid)) {
    return {
      uid: safeText(legacy.uid),
      firstName: safeText(legacy.firstName),
      lastName: safeText(legacy.lastName),
    };
  }

  if (children.length === 1 && safeText(children[0]?.uid)) {
    return {
      uid: safeText(children[0].uid),
      firstName: safeText(children[0].firstName),
      lastName: safeText(children[0].lastName),
    };
  }

  return { uid: "", firstName: "", lastName: "" };
}

async function run() {
  const mongoUrl =
    process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!mongoUrl) throw new Error("Missing MONGO_URL / MONGODB_URI / MONGO_URI");

  await mongoose.connect(mongoUrl);

  let touchedCustomers = 0;
  let touchedBookingRefs = 0;

  const cursor = Customer.find({}).lean().cursor();

  for await (const c of cursor) {
    const refs = Array.isArray(c?.bookings) ? c.bookings : [];
    if (!refs.length) continue;

    let changed = false;
    const next = refs.map((r) => {
      const curUid = safeText(r?.childUid);
      if (curUid) return r;

      const picked = pickChildUid(c, r);
      if (!picked.uid) return r;

      touchedBookingRefs += 1;
      changed = true;

      return {
        ...r,
        childUid: picked.uid,
        childFirstName: safeText(r?.childFirstName) || picked.firstName,
        childLastName: safeText(r?.childLastName) || picked.lastName,
      };
    });

    if (!changed) continue;

    await Customer.collection.updateOne(
      { _id: c._id },
      { $set: { bookings: next } },
    );
    touchedCustomers += 1;
  }

  console.log(
    JSON.stringify({ ok: true, touchedCustomers, touchedBookingRefs }),
  );
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
