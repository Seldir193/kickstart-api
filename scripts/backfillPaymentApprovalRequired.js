"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Offer = require("../models/Offer");

function s(v) {
  return String(v ?? "").trim();
}

function isTruthy(v) {
  const t = s(v).toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

function ownerFromEnv() {
  const id = s(process.env.DEFAULT_OWNER_ID);
  return mongoose.isValidObjectId(id) ? id : "";
}

function clubOfferFilter() {
  return {
    $or: [
      { category: "ClubPrograms" },
      { category: "RentACoach" },
      { sub_type: { $regex: /^RentACoach/i } },
      { sub_type: { $regex: /Trainings?Camp/i } },
      { sub_type: { $regex: /CoachEducation/i } },
    ],
  };
}

function individualOfferFilter() {
  return {
    $or: [{ category: "Individual" }, { type: "PersonalTraining" }],
  };
}

async function connect() {
  const uri = s(process.env.MONGO_URI);
  if (!uri) throw new Error("MONGO_URI missing");
  await mongoose.connect(uri);
}

async function offerIdsFor(owner) {
  const offers = await Offer.find({
    owner,
    $or: [clubOfferFilter(), individualOfferFilter()],
  })
    .select("_id")
    .lean();

  return offers.map((o) => o._id);
}

function bookingBackfillFilter(owner, offerIds) {
  return {
    owner,
    offerId: { $in: offerIds },
    status: { $ne: "deleted" },
    paymentStatus: { $ne: "paid" },
    $or: [
      { "meta.paymentApprovalRequired": { $exists: false } },
      { "meta.paymentApprovalRequired": false },
    ],
  };
}

async function backfill(owner, dryRun) {
  const offerIds = await offerIdsFor(owner);
  if (!offerIds.length) return { matched: 0, modified: 0, offerIds: 0 };

  const filter = bookingBackfillFilter(owner, offerIds);
  const update = {
    $set: {
      "meta.paymentApprovalRequired": true,
      "meta.paymentApprovalReason": "team_training",
    },
  };

  if (dryRun) {
    const matched = await Booking.countDocuments(filter);
    return { matched, modified: 0, offerIds: offerIds.length };
  }

  const res = await Booking.updateMany(filter, update);
  return {
    matched: res.matchedCount ?? res.n ?? 0,
    modified: res.modifiedCount ?? res.nModified ?? 0,
    offerIds: offerIds.length,
  };
}

async function main() {
  const owner = ownerFromEnv() || s(process.argv[2]);
  if (!mongoose.isValidObjectId(owner)) {
    throw new Error(
      "OwnerId missing/invalid (set DEFAULT_OWNER_ID or pass as arg)",
    );
  }

  const dryRun = isTruthy(process.env.DRY_RUN) || isTruthy(process.argv[3]);
  await connect();
  const out = await backfill(owner, dryRun);
  console.log("Backfill result:", out);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
