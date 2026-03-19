"use strict";

function detectSiblingFlag(body = {}) {
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  const merged = { ...meta, ...body };

  for (const [key, value] of Object.entries(merged)) {
    const k = String(key).toLowerCase();
    if (!k.includes("sibling")) continue;

    if (value === true) return true;
    if (typeof value === "number") return value > 0;

    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (["1", "true", "yes", "ja", "on"].includes(v)) return true;
      if (["0", "false", "no", "nein", "off"].includes(v)) return false;
    }
  }

  return false;
}

const CLUB_PROGRAM_SUBTYPES = ["RentACoach", "TrainingsCamp", "CoachEducation"];

function norm(v) {
  return String(v || "").trim();
}

function isNonTrialProgram(offer) {
  if (!offer) return false;
  const cat = norm(offer.category);
  const sub = norm(offer.sub_type);
  if (cat !== "ClubPrograms") return false;
  if (!sub) return true;
  return CLUB_PROGRAM_SUBTYPES.includes(sub);
}

const HOLIDAY_KEYWORDS = ["feriencamp", "holiday", "holidayprogram"];

function isClubProgramOffer(offer) {
  if (!offer) return false;

  const cat = norm(offer.category);
  if (cat === "ClubPrograms") return true;
  if (cat === "RentACoach") return true;

  const sub = norm(offer.sub_type);
  if (/^RentACoach/i.test(sub)) return true;
  if (/Trainings?Camp/i.test(sub)) return true;
  if (/CoachEducation/i.test(sub)) return true;
  if (/^ClubProgram/i.test(sub)) return true;

  return false;
}

function isHolidayProgram(offer) {
  if (!offer) return false;

  if (isClubProgramOffer(offer)) return false;

  const cat = norm(offer.category).toLowerCase().replace(/\s+/g, "");
  if (cat === "holiday" || cat === "holidayprograms") return true;

  const type = norm(offer.type).toLowerCase();
  const sub = norm(offer.sub_type).toLowerCase();
  const text = `${type} ${sub}`.trim();

  return HOLIDAY_KEYWORDS.some((kw) => text.includes(kw));
}

function isCampOffer(offer) {
  if (!offer) return false;
  return norm(offer.type) === "Camp";
}

function isPowertrainingOffer(offer) {
  if (!offer) return false;
  const cat = norm(offer.category);
  const sub = norm(offer.sub_type);
  return cat === "Powertraining" || sub === "Powertraining";
}

function isWeeklyOffer(offer) {
  if (!offer) return false;

  const cat = norm(offer.category);
  if (cat === "Weekly") return true;

  if (cat === "RentACoach") return false;

  const sub = norm(offer.sub_type).toLowerCase();
  if (sub.startsWith("rentacoach")) return false;
  if (sub.includes("coacheducation")) return false;
  if (sub.includes("trainingscamp") || sub.includes("trainingcamp"))
    return false;

  const type = norm(offer.type);
  return type === "Foerdertraining" || type === "Kindergarten";
}

function isIndividualOffer(offer) {
  if (!offer) return false;
  return norm(offer.category) === "Individual";
}

module.exports = {
  detectSiblingFlag,
  CLUB_PROGRAM_SUBTYPES,
  isNonTrialProgram,
  HOLIDAY_KEYWORDS,
  isHolidayProgram,
  isCampOffer,
  isPowertrainingOffer,
  isWeeklyOffer,
  isIndividualOffer,
  isClubProgramOffer,
};

// // //routes\bookings\helpers\offerTypes.js
// "use strict";

// function detectSiblingFlag(body = {}) {
//   const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
//   const merged = { ...meta, ...body };

//   for (const [key, value] of Object.entries(merged)) {
//     const k = String(key).toLowerCase();
//     if (!k.includes("sibling")) continue;

//     if (value === true) return true;
//     if (typeof value === "number") return value > 0;

//     if (typeof value === "string") {
//       const v = value.trim().toLowerCase();
//       if (["1", "true", "yes", "ja", "on"].includes(v)) return true;
//       if (["0", "false", "no", "nein", "off"].includes(v)) return false;
//     }
//   }

//   return false;
// }

// const CLUB_PROGRAM_SUBTYPES = ["RentACoach", "TrainingsCamp", "CoachEducation"];

// function norm(v) {
//   return String(v || "").trim();
// }

// function isNonTrialProgram(offer) {
//   if (!offer) return false;
//   const cat = norm(offer.category);
//   const sub = norm(offer.sub_type);
//   if (cat !== "ClubPrograms") return false;
//   if (!sub) return true;
//   return CLUB_PROGRAM_SUBTYPES.includes(sub);
// }

// const HOLIDAY_KEYWORDS = ["camp", "feriencamp", "holiday"];

// function isHolidayProgram(offer) {
//   if (!offer) return false;
//   const cat = norm(offer.category).toLowerCase().replace(/\s+/g, "");
//   if (cat === "holiday" || cat === "holidayprograms") return true;

//   const type = norm(offer.type).toLowerCase();
//   const sub = norm(offer.sub_type).toLowerCase();
//   const text = `${type} ${sub}`.trim();

//   return HOLIDAY_KEYWORDS.some((kw) => text.includes(kw));
// }

// function isCampOffer(offer) {
//   if (!offer) return false;
//   return norm(offer.type) === "Camp";
// }

// function isPowertrainingOffer(offer) {
//   if (!offer) return false;
//   const cat = norm(offer.category);
//   const sub = norm(offer.sub_type);
//   return cat === "Powertraining" || sub === "Powertraining";
// }

// // function isWeeklyOffer(offer) {
// //   if (!offer) return false;
// //   const cat = norm(offer.category);
// //   const type = norm(offer.type);
// //   return (
// //     cat === "Weekly" || type === "Foerdertraining" || type === "Kindergarten"
// //   );
// // }

// function isWeeklyOffer(offer) {
//   if (!offer) return false;

//   const cat = norm(offer.category);
//   if (cat === "Weekly") return true;

//   if (cat === "RentACoach") return false;

//   const sub = norm(offer.sub_type).toLowerCase();
//   if (sub.startsWith("rentacoach")) return false;
//   if (sub.includes("coacheducation")) return false;
//   if (sub.includes("trainingscamp") || sub.includes("trainingcamp"))
//     return false;

//   const type = norm(offer.type);
//   return type === "Foerdertraining" || type === "Kindergarten";
// }

// // function isIndividualOffer(offer) {
// //   if (!offer) return false;
// //   return norm(offer.type) === "PersonalTraining";
// // }

// function isIndividualOffer(offer) {
//   if (!offer) return false;
//   return norm(offer.category) === "Individual";
// }

// // function isClubProgramOffer(offer) {
// //   if (!offer) return false;
// //   return norm(offer.category) === "ClubPrograms";
// // }

// function isClubProgramOffer(offer) {
//   if (!offer) return false;

//   const cat = norm(offer.category);
//   if (cat === "ClubPrograms") return true;

//   if (cat === "RentACoach") return true;

//   const sub = norm(offer.sub_type);
//   if (/^RentACoach/i.test(sub)) return true;
//   if (/Trainings?Camp/i.test(sub)) return true;
//   if (/CoachEducation/i.test(sub)) return true;

//   return false;
// }

// module.exports = {
//   detectSiblingFlag,
//   CLUB_PROGRAM_SUBTYPES,
//   isNonTrialProgram,
//   HOLIDAY_KEYWORDS,
//   isHolidayProgram,
//   isCampOffer,
//   isPowertrainingOffer,
//   isWeeklyOffer,
//   isIndividualOffer,
//   isClubProgramOffer,
// };
