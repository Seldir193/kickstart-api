// routes/payments/stripe/lib/offer.js
"use strict";

const Offer = require("../../../../models/Offer");
const { safeStr } = require("./strings");

// function isSubscriptionOffer(offer) {
//   return String(offer?.type || "") === "Foerdertraining";
// }

// function isSubscriptionOffer(offer) {
//   const cat = String(offer?.category || "");
//   const type = String(offer?.type || "");
//   if (cat === "Weekly") return true;
//   return type === "Foerdertraining";
// }

function isSubscriptionOffer(offer) {
  const cat = String(offer?.category || "").trim();
  const type = String(offer?.type || "").trim();
  const sub = String(offer?.sub_type || "").trim();

  const nonWeeklyCats = new Set([
    "Holiday",
    "HolidayPrograms",
    "Powertraining",
    "Individual",
    "ClubPrograms",
    "RentACoach",
  ]);

  if (nonWeeklyCats.has(cat)) return false;
  if (/^RentACoach/i.test(sub)) return false;
  if (/CoachEducation/i.test(sub)) return false;
  if (/Trainings?Camp/i.test(sub)) return false;

  if (cat === "Weekly") return true;

  if (!cat && (type === "Foerdertraining" || type === "Kindergarten"))
    return true;

  return false;
}

function isHolidayOffer(offer) {
  const cat = String(offer?.category || "");
  return cat === "Holiday" || cat === "HolidayPrograms";
}

function isCampOffer(offer, booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
  if (meta.isCampBooking === true) return true;
  return String(offer?.type || "") === "Camp";
}

function isPowertrainingOffer(offer) {
  const type = String(offer?.type || "");
  const cat = String(offer?.category || "");
  const st = String(offer?.sub_type || "");
  if (type !== "AthleticTraining") return false;
  return cat === "Powertraining" || st === "Powertraining";
}

// function isIndividualOffer(offer) {
//   return String(offer?.type || "") === "PersonalTraining";
// }

function isIndividualOffer(offer) {
  return String(offer?.category || "").trim() === "Individual";
}

function requiresWeeklyMembership(offer) {
  return isIndividualOffer(offer) || isPowertrainingOffer(offer);
}

async function loadOffer(booking) {
  if (!booking?.offerId) return null;
  try {
    return await Offer.findById(booking.offerId).lean();
  } catch {
    return null;
  }
}

function displayName(booking, offer) {
  return (
    safeStr(offer?.title) ||
    `${safeStr(booking?.firstName)} ${safeStr(booking?.lastName)}`.trim() ||
    "Booking"
  );
}

module.exports = {
  isSubscriptionOffer,
  isHolidayOffer,
  isCampOffer,
  requiresWeeklyMembership,
  loadOffer,
  displayName,
  isPowertrainingOffer,
};

// // //routes\payments\stripe\lib\offer.js
// // routes/payments/stripe/lib/offer.js
// "use strict";

// const Offer = require("../../../../models/Offer");
// const { safeStr } = require("./strings");

// function isSubscriptionOffer(offer) {
//   return String(offer?.type || "") === "Foerdertraining";
// }

// function isHolidayOffer(offer) {
//   const cat = String(offer?.category || "");
//   return cat === "Holiday" || cat === "HolidayPrograms";
// }

// function norm(v) {
//   return safeStr(v).toLowerCase();
// }

// function isCampOffer(offer, booking) {
//   const meta =
//     booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
//   if (meta.isCampBooking === true) return true;
//   const t = norm(offer?.type);
//   const st = norm(offer?.sub_type);
//   const c = norm(offer?.category);
//   const title = norm(offer?.title);
//   return (
//     t.includes("camp") ||
//     st.includes("camp") ||
//     c.includes("camp") ||
//     title.includes("camp")
//   );
// }

// function requiresWeeklyMembership(offer) {
//   const t = norm(offer?.type);
//   const st = norm(offer?.sub_type);
//   const c = norm(offer?.category);
//   const title = norm(offer?.title);
//   if (
//     t.includes("powertraining") ||
//     st.includes("powertraining") ||
//     title.includes("powertraining")
//   )
//     return true;
//   if (
//     t.includes("individual") ||
//     st.includes("individual") ||
//     title.includes("individual")
//   )
//     return true;
//   if (
//     t.includes("personaltraining") ||
//     st.includes("personaltraining") ||
//     title.includes("personaltraining")
//   )
//     return true;
//   if (c.includes("powertraining") || c.includes("individual")) return true;
//   return false;
// }

// async function loadOffer(booking) {
//   if (!booking?.offerId) return null;
//   try {
//     return await Offer.findById(booking.offerId).lean();
//   } catch {
//     return null;
//   }
// }

// function displayName(booking, offer) {
//   return (
//     safeStr(offer?.title) ||
//     `${safeStr(booking?.firstName)} ${safeStr(booking?.lastName)}`.trim() ||
//     "Booking"
//   );
// }

// module.exports = {
//   isSubscriptionOffer,
//   isHolidayOffer,
//   isCampOffer,
//   requiresWeeklyMembership,
//   loadOffer,
//   displayName,
// };
