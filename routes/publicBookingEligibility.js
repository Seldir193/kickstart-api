"use strict";

const express = require("express");
const { Types } = require("mongoose");
const router = express.Router();

const Booking = require("../models/Booking");
const Offer = require("../models/Offer");

function safeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function esc(v) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isSameOrAfterToday(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return d >= startOfToday();
}

function isAfterToday(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return d > startOfToday();
}

function isDeletedStatus(status) {
  return safeStr(status) === "deleted";
}

function isImmediateReleaseWeekly(doc) {
  const paymentStatus = safeStr(doc?.paymentStatus);
  const status = safeStr(doc?.status);
  const meta = doc?.meta && typeof doc.meta === "object" ? doc.meta : {};

  return (
    paymentStatus === "returned" ||
    status === "storno" ||
    safeStr(meta.revocationProcessedAt) !== "" ||
    safeStr(meta.stripeRefundId) !== ""
  );
}

function isActiveWeekly(doc) {
  if (doc?.meta?.subscriptionEligible !== true) return false;
  if (isDeletedStatus(doc?.status)) return false;
  if (isImmediateReleaseWeekly(doc)) return false;

  if (!doc?.endDate) return true;
  return isAfterToday(doc.endDate);
}

function isReturnedOneTime(doc) {
  const isReturned = safeStr(doc?.paymentStatus) === "returned";
  const isWeekly = doc?.meta?.subscriptionEligible === true;
  return isReturned && !isWeekly;
}

function isBlockingOneTime(doc) {
  const status = safeStr(doc?.status);
  if (doc?.meta?.subscriptionEligible === true) return false;
  if (["deleted", "cancelled", "storno"].includes(status)) return false;
  if (isReturnedOneTime(doc)) return false;
  return true;
}

function isBlockingBooking(doc) {
  return isActiveWeekly(doc) || isBlockingOneTime(doc);
}

function normalizeKey(v) {
  return safeStr(v).toLowerCase();
}

function joinedOfferText(offer, doc) {
  const category = normalizeKey(offer?.category);
  const type = normalizeKey(offer?.type);
  const subType = normalizeKey(offer?.sub_type);
  const offerType = normalizeKey(doc?.offerType);
  const offerTitle = normalizeKey(doc?.offerTitle);

  return [category, type, subType, offerType, offerTitle]
    .filter(Boolean)
    .join(" ");
}

function isRentACoachKey(text) {
  return /rent[\s_-]*a[\s_-]*coach/.test(text);
}

function isCoachEducationKey(text) {
  return /coach[\s_-]*education/.test(text);
}

function isTrainingCampKey(text) {
  return /training[\s_-]*camp/.test(text);
}

function clubProgramCourseKey(offer, doc) {
  const text = joinedOfferText(offer, doc);

  if (isRentACoachKey(text)) return "clubprogram:rentacoach";
  if (isCoachEducationKey(text)) return "clubprogram:coacheducation";
  if (isTrainingCampKey(text)) return "clubprogram:trainingcamp";

  return "";
}

function offerFamilyKey(offer) {
  const category = normalizeKey(offer?.category);
  const type = normalizeKey(offer?.type);
  const subType = normalizeKey(offer?.sub_type);

  if (category === "weekly") {
    if (subType === "torwarttraining") return "weekly:torwarttraining";
    if (subType === "foerdertraining_athletik") {
      return "weekly:foerdertraining_athletik";
    }
    if (type === "kindergarten") return "weekly:kindergarten";
    if (type === "foerdertraining") return "weekly:foerdertraining";
    return `weekly:${subType || type || safeStr(offer?._id)}`;
  }

  const clubKey = clubProgramCourseKey(offer, null);
  if (clubKey) return clubKey;

  return `offer:${safeStr(offer?._id)}`;
}

async function loadOfferMap(ids) {
  const validIds = ids.filter((id) => Types.ObjectId.isValid(id));
  if (!validIds.length) return new Map();

  const offers = await Offer.find({ _id: { $in: validIds } })
    .select("_id category type sub_type title")
    .lean();

  return new Map(offers.map((offer) => [String(offer._id), offer]));
}

function bookingFamilyKey(doc, offer) {
  const offerType = normalizeKey(doc?.offerType);
  const offerTitle = normalizeKey(doc?.offerTitle);
  const category = normalizeKey(offer?.category);
  const type = normalizeKey(offer?.type);
  const subType = normalizeKey(offer?.sub_type);

  const joined = [subType, type, category, offerType, offerTitle]
    .filter(Boolean)
    .join(" ");

  if (/torwarttraining/.test(joined)) return "weekly:torwarttraining";
  if (/foerdertraining_athletik/.test(joined)) {
    return "weekly:foerdertraining_athletik";
  }
  if (type === "kindergarten" || offerType === "kindergarten") {
    return "weekly:kindergarten";
  }
  if (
    type === "foerdertraining" ||
    offerType === "foerdertraining" ||
    /^foerdertraining\s*•/.test(offerTitle)
  ) {
    return "weekly:foerdertraining";
  }

  const clubKey = clubProgramCourseKey(offer, doc);
  if (clubKey) return clubKey;

  if (category === "weekly") {
    return `weekly:${subType || type || offerType || offerTitle}`;
  }

  return `offer:${safeStr(doc?.offerId || offer?._id)}`;
}

router.get("/booking-eligibility", async (req, res) => {
  const offerIdRaw = safeStr(req.query.offerId);
  const email = safeStr(req.query.email).toLowerCase();
  const firstName = safeStr(req.query.firstName);
  const lastName = safeStr(req.query.lastName);

  if (!offerIdRaw || !email || !firstName || !lastName) {
    return res.status(400).json({ ok: false, code: "VALIDATION" });
  }

  if (!Types.ObjectId.isValid(offerIdRaw)) {
    return res.status(400).json({ ok: false, code: "INVALID_OFFER_ID" });
  }

  const currentOffer = await Offer.findById(offerIdRaw)
    .select("_id category type sub_type title")
    .lean();

  if (!currentOffer) {
    return res.status(404).json({ ok: false, code: "OFFER_NOT_FOUND" });
  }

  const currentFamilyKey = bookingFamilyKey(
    {
      offerId: offerIdRaw,
      offerType: currentOffer?.type,
      offerTitle: currentOffer?.title,
    },
    currentOffer,
  );

  const docs = await Booking.find({
    email,
    firstName: { $regex: `^${esc(firstName)}$`, $options: "i" },
    lastName: { $regex: `^${esc(lastName)}$`, $options: "i" },
    status: { $ne: "deleted" },
  })
    .sort({ createdAt: -1 })
    .select(
      "_id offerId offerType offerTitle status paymentStatus endDate meta.subscriptionEligible meta.subscriptionEligibleAt meta.revocationProcessedAt meta.stripeRefundId",
    )
    .lean();

  const offerIds = docs.map((doc) => safeStr(doc.offerId)).filter(Boolean);
  const offerMap = await loadOfferMap(offerIds);

  const blocking =
    docs.find((doc) => {
      const offer = offerMap.get(safeStr(doc.offerId));
      if (!offer) return false;
      if (bookingFamilyKey(doc, offer) !== currentFamilyKey) return false;
      return isBlockingBooking(doc);
    }) || null;

  return res.status(200).json({
    ok: true,
    eligible: !!blocking,
    eligibleAt: blocking?.meta?.subscriptionEligibleAt || null,
    bookingId: blocking?._id ? String(blocking._id) : "",
  });
});

module.exports = router;

// //routes\publicBookingEligibility.js
// "use strict";

// const express = require("express");
// const { Types } = require("mongoose");
// const router = express.Router();

// const Booking = require("../models/Booking");
// const Offer = require("../models/Offer");

// function safeStr(v) {
//   return typeof v === "string" ? v.trim() : "";
// }

// function esc(v) {
//   return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// }

// function startOfToday() {
//   const now = new Date();
//   return new Date(now.getFullYear(), now.getMonth(), now.getDate());
// }

// function isSameOrAfterToday(dateValue) {
//   if (!dateValue) return false;
//   const d = new Date(dateValue);
//   if (Number.isNaN(d.getTime())) return false;
//   return d >= startOfToday();
// }

// function isAfterToday(dateValue) {
//   if (!dateValue) return false;
//   const d = new Date(dateValue);
//   if (Number.isNaN(d.getTime())) return false;
//   return d > startOfToday();
// }

// function isDeletedStatus(status) {
//   return safeStr(status) === "deleted";
// }

// function isImmediateReleaseWeekly(doc) {
//   const paymentStatus = safeStr(doc?.paymentStatus);
//   const status = safeStr(doc?.status);
//   const meta = doc?.meta && typeof doc.meta === "object" ? doc.meta : {};

//   return (
//     paymentStatus === "returned" ||
//     status === "storno" ||
//     safeStr(meta.revocationProcessedAt) !== "" ||
//     safeStr(meta.stripeRefundId) !== ""
//   );
// }

// function isActiveWeekly(doc) {
//   if (doc?.meta?.subscriptionEligible !== true) return false;
//   if (isDeletedStatus(doc?.status)) return false;
//   if (isImmediateReleaseWeekly(doc)) return false;

//   if (!doc?.endDate) return true;
//   return isAfterToday(doc.endDate);
// }

// function isReturnedOneTime(doc) {
//   const isReturned = safeStr(doc?.paymentStatus) === "returned";
//   const isWeekly = doc?.meta?.subscriptionEligible === true;
//   return isReturned && !isWeekly;
// }

// function isBlockingOneTime(doc) {
//   const status = safeStr(doc?.status);
//   if (doc?.meta?.subscriptionEligible === true) return false;
//   if (["deleted", "cancelled", "storno"].includes(status)) return false;
//   if (isReturnedOneTime(doc)) return false;
//   return true;
// }

// function isBlockingBooking(doc) {
//   return isActiveWeekly(doc) || isBlockingOneTime(doc);
// }

// function normalizeKey(v) {
//   return safeStr(v).toLowerCase();
// }

// function offerFamilyKey(offer) {
//   const category = normalizeKey(offer?.category);
//   const type = normalizeKey(offer?.type);
//   const subType = normalizeKey(offer?.sub_type);

//   if (category !== "weekly") {
//     return `offer:${safeStr(offer?._id)}`;
//   }

//   if (subType === "torwarttraining") return "weekly:torwarttraining";
//   if (subType === "foerdertraining_athletik") {
//     return "weekly:foerdertraining_athletik";
//   }

//   if (type === "kindergarten") return "weekly:kindergarten";
//   if (type === "foerdertraining") return "weekly:foerdertraining";

//   return `weekly:${subType || type || safeStr(offer?._id)}`;
// }

// async function loadOfferMap(ids) {
//   const validIds = ids.filter((id) => Types.ObjectId.isValid(id));
//   if (!validIds.length) return new Map();

//   const offers = await Offer.find({ _id: { $in: validIds } })
//     .select("_id category type sub_type")
//     .lean();

//   return new Map(offers.map((offer) => [String(offer._id), offer]));
// }

// router.get("/booking-eligibility", async (req, res) => {
//   const offerIdRaw = safeStr(req.query.offerId);
//   const email = safeStr(req.query.email).toLowerCase();
//   const firstName = safeStr(req.query.firstName);
//   const lastName = safeStr(req.query.lastName);

//   if (!offerIdRaw || !email || !firstName || !lastName) {
//     return res.status(400).json({ ok: false, code: "VALIDATION" });
//   }

//   if (!Types.ObjectId.isValid(offerIdRaw)) {
//     return res.status(400).json({ ok: false, code: "INVALID_OFFER_ID" });
//   }

//   const currentOffer = await Offer.findById(offerIdRaw)
//     .select("_id category type sub_type")
//     .lean();

//   if (!currentOffer) {
//     return res.status(404).json({ ok: false, code: "OFFER_NOT_FOUND" });
//   }

//   const currentFamilyKey = bookingFamilyKey(
//     {
//       offerId: offerIdRaw,
//       offerType: currentOffer?.type,
//       offerTitle: currentOffer?.title,
//     },
//     currentOffer,
//   );

//   const docs = await Booking.find({
//     email,
//     firstName: { $regex: `^${esc(firstName)}$`, $options: "i" },
//     lastName: { $regex: `^${esc(lastName)}$`, $options: "i" },
//     status: { $ne: "deleted" },
//   })
//     .sort({ createdAt: -1 })
//     .select(
//       "_id offerId status paymentStatus endDate meta.subscriptionEligible meta.subscriptionEligibleAt",
//     )
//     .lean();

//   const offerIds = docs.map((doc) => safeStr(doc.offerId)).filter(Boolean);

//   const offerMap = await loadOfferMap(offerIds);

//   const blocking =
//     docs.find((doc) => {
//       const offer = offerMap.get(safeStr(doc.offerId));
//       if (!offer) return false;

//       if (bookingFamilyKey(doc, offer) !== currentFamilyKey) return false;
//       return isBlockingBooking(doc);
//     }) || null;

//   return res.status(200).json({
//     ok: true,
//     eligible: !!blocking,
//     eligibleAt: blocking?.meta?.subscriptionEligibleAt || null,
//     bookingId: blocking?._id ? String(blocking._id) : "",
//   });
// });

// function bookingFamilyKey(doc, offer) {
//   const offerType = normalizeKey(doc?.offerType);
//   const offerTitle = normalizeKey(doc?.offerTitle);
//   const category = normalizeKey(offer?.category);
//   const type = normalizeKey(offer?.type);
//   const subType = normalizeKey(offer?.sub_type);

//   const joined = [subType, type, category, offerType, offerTitle]
//     .filter(Boolean)
//     .join(" ");

//   if (/torwarttraining/.test(joined)) return "weekly:torwarttraining";
//   if (/foerdertraining_athletik/.test(joined)) {
//     return "weekly:foerdertraining_athletik";
//   }
//   if (type === "kindergarten" || offerType === "kindergarten") {
//     return "weekly:kindergarten";
//   }
//   if (
//     type === "foerdertraining" ||
//     offerType === "foerdertraining" ||
//     /^foerdertraining\s*•/.test(offerTitle)
//   ) {
//     return "weekly:foerdertraining";
//   }

//   if (category === "weekly") {
//     return `weekly:${subType || type || offerType || offerTitle}`;
//   }

//   return `offer:${safeStr(doc?.offerId || offer?._id)}`;
// }

// module.exports = router;
