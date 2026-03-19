"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const crypto = require("crypto");
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

function newUid() {
  return crypto.randomBytes(10).toString("hex");
}

function needsUid(ch) {
  return ch && !safeText(ch.uid);
}

function setUidInMemory(ch) {
  if (!ch) return false;
  if (!needsUid(ch)) return false;
  ch.uid = newUid();
  return true;
}

async function run() {
  const uri = pickMongoUri();
  if (!uri) throw new Error("Missing Mongo URI (MONGO_URI / MONGODB_URI)");

  await mongoose.connect(uri);

  const cursor = Customer.find({
    owner: { $exists: true, $ne: null },
  })
    .select("_id owner child children")
    .cursor();

  let touchedCustomers = 0;
  let touchedChildren = 0;

  for await (const c of cursor) {
    const set = {};
    let changed = false;

    if (c.child && setUidInMemory(c.child)) {
      set["child.uid"] = c.child.uid;
      changed = true;
      touchedChildren += 1;
    }

    const children = Array.isArray(c.children) ? c.children : [];
    children.forEach((ch, idx) => {
      if (!ch) return;
      if (!needsUid(ch)) return;
      const uid = newUid();
      set[`children.${idx}.uid`] = uid;
      changed = true;
      touchedChildren += 1;
    });

    if (!changed) continue;

    await Customer.updateOne(
      { _id: c._id, owner: c.owner },
      { $set: set },
      { runValidators: false },
    ).exec();

    touchedCustomers += 1;
  }

  console.log("Backfill done:", { touchedCustomers, touchedChildren });
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
