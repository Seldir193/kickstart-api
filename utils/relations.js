// utils/relations.js
"use strict";

const mongoose = require("mongoose");
const { Types } = mongoose;

const Customer = require("../models/Customer");
const Booking = require("../models/Booking");
const Offer = require("../models/Offer");

/* ===================== Helpers ===================== */

function normalizeString(v) {
  return String(v || "").trim();
}

function normalizeEmail(v) {
  const s = normalizeString(v);
  return s ? s.toLowerCase() : "";
}

/**
 * Normalisiert ein Datum auf "YYYY-MM-DD" (nur Datumsteil).
 * Ungültige Datumswerte → null.
 */
function normalizeDateOnly(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Prüft, ob zwei Child-Objekte dasselbe Kind meinen.
 * Verglichen wird:
 *  - firstName + lastName (case-insensitive, getrimmt)
 *  - optional birthDate (als YYYY-MM-DD)
 *
 * Hinweis:
 * Gut für Auswertungen/Infos.
 * Für Online-Buchungen soll die Entscheidung "welcher Kunde?"
 * aber über die Eltern-E-Mail laufen, nicht über das Kind.
 */
function hasSameChild(childA, childB) {
  if (!childA || !childB) return false;

  const aFirst = normalizeString(childA.firstName).toLowerCase();
  const aLast = normalizeString(childA.lastName).toLowerCase();
  const bFirst = normalizeString(childB.firstName).toLowerCase();
  const bLast = normalizeString(childB.lastName).toLowerCase();

  if (!aFirst || !aLast || !bFirst || !bLast) return false;
  if (aFirst !== bFirst || aLast !== bLast) return false;

  const aBirth = normalizeDateOnly(childA.birthDate);
  const bBirth = normalizeDateOnly(childB.birthDate);

  // Wenn ein Geburtsdatum fehlt → wir matchen nur auf Name
  if (!aBirth || !bBirth) return true;

  return aBirth === bBirth;
}

/**
 * Holt ein "repräsentatives" Kind aus einem Customer:
 * - bevorzugt customer.child (Legacy-Feld)
 * - sonst erstes customer.children-Element
 */
function getPrimaryChildFromCustomer(customer) {
  if (!customer) return null;

  if (customer.child && (customer.child.firstName || customer.child.lastName)) {
    return customer.child;
  }

  if (Array.isArray(customer.children) && customer.children.length > 0) {
    return customer.children[0];
  }

  return null;
}

function bookingBirthDate(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  return normalizeDateOnly(
    meta?.childBirthDate ||
      meta?.child?.birthDate ||
      booking?.childBirthDate ||
      booking?.birthDate ||
      null,
  );
}

function bookingMatchesChild(booking, probe) {
  if (!booking || !probe) return false;

  const bFirst = normalizeString(booking.firstName).toLowerCase();
  const bLast = normalizeString(booking.lastName).toLowerCase();
  const pFirst = normalizeString(probe.firstName).toLowerCase();
  const pLast = normalizeString(probe.lastName).toLowerCase();

  if (!bFirst || !bLast || !pFirst || !pLast) return false;
  if (bFirst !== pFirst || bLast !== pLast) return false;

  const bBirth = bookingBirthDate(booking);
  const pBirth = normalizeDateOnly(probe.birthDate);

  if (!bBirth || !pBirth) return true;
  return bBirth === pBirth;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isFutureDate(value) {
  if (!value) return false;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d > startOfToday();
}

/* ===================== Export-Funktionen ===================== */

/**
 * Sucht einen "Base-Customer" für ein Kind anhand von:
 *  - ownerId
 *  - childFirstName / childLastName
 *  - optional childBirthDate
 */
async function findBaseCustomerForChild({
  ownerId,
  childFirstName,
  childLastName,
  childBirthDate,
}) {
  const first = normalizeString(childFirstName);
  const last = normalizeString(childLastName);

  if (!first || !last) return null;

  const birth = normalizeDateOnly(childBirthDate);

  const owner =
    ownerId instanceof Types.ObjectId
      ? ownerId
      : Types.ObjectId.isValid(ownerId)
        ? new Types.ObjectId(ownerId)
        : null;

  if (!owner) return null;

  // Grobfilter in Mongo (nach Namen), exakte Prüfung dann in JS
  const firstRegex = new RegExp(
    `^${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i",
  );
  const lastRegex = new RegExp(
    `^${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i",
  );

  const candidates = await Customer.find({
    owner,
    $or: [
      { "child.firstName": firstRegex, "child.lastName": lastRegex },
      { "children.firstName": firstRegex, "children.lastName": lastRegex },
    ],
  }).exec();

  if (!candidates.length) return null;

  const childProbe = {
    firstName: first,
    lastName: last,
    birthDate: birth ? new Date(birth) : null,
  };

  const matching = candidates.filter((c) => {
    if (hasSameChild(c.child, childProbe)) return true;
    if (
      Array.isArray(c.children) &&
      c.children.some((ch) => hasSameChild(ch, childProbe))
    ) {
      return true;
    }
    return false;
  });

  if (!matching.length) return null;
  if (matching.length === 1) return matching[0];

  // Mehrere Treffer → den ältesten (createdAt) wählen
  matching.sort((a, b) => {
    const ta = a.createdAt ? a.createdAt.getTime() : 0;
    const tb = b.createdAt ? b.createdAt.getTime() : 0;
    return ta - tb;
  });

  return matching[0];
}

/**
 * Legt einen neuen Customer für einen "alternativen" Elternteil an
 * und verknüpft ihn über relatedCustomerIds mit dem bestehenden baseCustomer.
 */

async function createCustomerForNewParent({
  ownerId,
  baseCustomer,
  parentData = {},
  childDataOverride = {},
}) {
  if (!baseCustomer || !baseCustomer._id) {
    throw new Error("createCustomerForNewParent: baseCustomer is required");
  }

  const owner =
    ownerId instanceof Types.ObjectId
      ? ownerId
      : Types.ObjectId.isValid(ownerId)
        ? new Types.ObjectId(ownerId)
        : null;

  if (!owner) {
    throw new Error("createCustomerForNewParent: invalid ownerId");
  }

  const emailLower = normalizeEmail(parentData.email);

  const baseChild = getPrimaryChildFromCustomer(baseCustomer) || {};

  const child = {
    firstName: normalizeString(
      childDataOverride.firstName || baseChild.firstName,
    ),
    lastName: normalizeString(childDataOverride.lastName || baseChild.lastName),
    birthDate: childDataOverride.birthDate || baseChild.birthDate || null,
    gender: normalizeString(childDataOverride.gender || baseChild.gender || ""),
    club: normalizeString(childDataOverride.club || baseChild.club || ""),
  };

  // userId-Sequence pro Owner hochziehen
  await Customer.syncCounterWithExisting(owner);
  const nextUserId = await Customer.nextUserIdForOwner(owner);

  // neuen Customer anlegen
  const newCustomer = await Customer.create({
    owner,
    userId: nextUserId,

    email: emailLower || undefined,
    emailLower: emailLower || undefined,

    parent: {
      salutation: normalizeString(parentData.salutation),
      firstName: normalizeString(parentData.firstName),
      lastName: normalizeString(parentData.lastName),
      email: emailLower || undefined,
      phone: normalizeString(parentData.phone),
      phone2: normalizeString(parentData.phone2),
    },

    child,
    children: child.firstName || child.lastName ? [child] : [],

    notes: "",
    bookings: [],

    relatedCustomerIds: [baseCustomer._id],
  });

  // Base-Customer bidirektional verknüpfen
  if (!Array.isArray(baseCustomer.relatedCustomerIds)) {
    baseCustomer.relatedCustomerIds = [];
  }

  const alreadyLinked = baseCustomer.relatedCustomerIds.some(
    (id) => String(id) === String(newCustomer._id),
  );

  if (!alreadyLinked) {
    baseCustomer.relatedCustomerIds.push(newCustomer._id);
    await baseCustomer.save();
  }

  return newCustomer;
}

/* ======================================================= */
/*  Prüft, ob ein Kind einen aktiven Weekly-Kurs hat       */
/* ======================================================= */

// function isWeeklyOfferForGate(offer) {
//   if (!offer) return false;
//   const cat = String(offer.category || "");
//   const type = String(offer.type || "");
//   if (cat === "Weekly") return true;
//   if (type === "Foerdertraining" || type === "Kindergarten") return true;
//   return false;
// }

function isWeeklyOfferForGate(offer) {
  if (!offer) return false;
  return normalizeString(offer.category) === "Weekly";
}

// function isActiveSubscriptionBookingForGate(b) {
//   const mode = String(b?.stripe?.mode || "");
//   const subId = String(b?.stripe?.subscriptionId || "");
//   const st = String(b?.stripe?.subStatus || "");
//   if (mode !== "subscription") return false;
//   if (!subId.trim()) return false;
//   return st === "active" || st === "trialing";
// }

// function isActiveSubscriptionBookingForGate(b) {
//   if (!b) return false;

//   if (normalizeString(b.paymentStatus) !== "paid") return false;

//   const status = normalizeString(b.status);
//   if (["deleted", "storno", "cancelled"].includes(status)) return false;

//   if (b.endDate) {
//     return isFutureDate(b.endDate);
//   }

//   const mode = normalizeString(b?.stripe?.mode);
//   const subId = normalizeString(b?.stripe?.subscriptionId);
//   const subStatus = normalizeString(b?.stripe?.subStatus);

//   if (mode === "subscription") {
//     if (!subId) return false;
//     return subStatus === "active" || subStatus === "trialing";
//   }

//   return true;
// }

function isImmediateReleaseWeeklyGate(b) {
  const status = normalizeString(b?.status);
  const paymentStatus = normalizeString(b?.paymentStatus);
  const meta = b?.meta && typeof b.meta === "object" ? b.meta : {};

  return (
    paymentStatus === "returned" ||
    status === "storno" ||
    normalizeString(meta.revocationProcessedAt) !== "" ||
    normalizeString(meta.stripeRefundId) !== ""
  );
}

function isActiveSubscriptionBookingForGate(b) {
  if (!b) return false;
  if (normalizeString(b.paymentStatus) !== "paid") return false;
  if (normalizeString(b.status) === "deleted") return false;
  if (isImmediateReleaseWeeklyGate(b)) return false;

  if (b.endDate) {
    return isFutureDate(b.endDate);
  }

  const mode = normalizeString(b?.stripe?.mode);
  const subId = normalizeString(b?.stripe?.subscriptionId);
  const subStatus = normalizeString(b?.stripe?.subStatus);

  if (mode === "subscription") {
    if (!subId) return false;
    return subStatus === "active" || subStatus === "trialing";
  }

  return true;
}

async function childHasActiveWeeklyBooking({
  ownerId,
  firstName,
  lastName,
  birthDate,
  parentEmail,
}) {
  const owner =
    ownerId instanceof Types.ObjectId
      ? ownerId
      : Types.ObjectId.isValid(ownerId)
        ? new Types.ObjectId(ownerId)
        : null;

  if (!owner) return false;

  const first = normalizeString(firstName);
  const last = normalizeString(lastName);
  if (!first || !last) return false;

  const childProbe = {
    firstName: first,
    lastName: last,
    birthDate: birthDate || null,
  };

  const baseCustomer = await findBaseCustomerForChild({
    ownerId: owner,
    childFirstName: first,
    childLastName: last,
    childBirthDate: birthDate || null,
  });

  if (!baseCustomer) return false;

  const familyIds = [
    baseCustomer._id,
    ...(Array.isArray(baseCustomer.relatedCustomerIds)
      ? baseCustomer.relatedCustomerIds
      : []),
  ];

  const familyCustomers = await Customer.find({
    _id: { $in: familyIds },
    owner,
  }).lean();

  // const emailLower = normalizeEmail(parentEmail);

  // const scopedCustomers = emailLower
  //   ? familyCustomers.filter((c) => {
  //       const e1 = normalizeEmail(c.emailLower || c.email || "");
  //       const e2 = normalizeEmail(c.parent?.email || "");
  //       return e1 === emailLower || e2 === emailLower;
  //     })
  //   : familyCustomers;

  // if (!scopedCustomers.length) return false;

  if (!familyCustomers.length) return false;

  const bookingIds = [];
  // for (const c of scopedCustomers) {
  for (const c of familyCustomers) {
    if (!Array.isArray(c.bookings)) continue;
    for (const b of c.bookings) {
      if (b && b.bookingId) bookingIds.push(b.bookingId);
    }
  }

  if (!bookingIds.length) return false;

  const bookings = await Booking.find({
    _id: { $in: bookingIds },
    owner,
  })
    .populate("offerId", "category type sub_type")
    .lean();

  if (!bookings.length) return false;

  return bookings.some((b) => {
    return (
      isWeeklyOfferForGate(b.offerId) &&
      bookingMatchesChild(b, childProbe) &&
      isActiveSubscriptionBookingForGate(b)
    );
  });
}

// async function childHasActiveWeeklyBooking({
//   ownerId,
//   firstName,
//   lastName,
//   birthDate,
//   parentEmail,
// }) {
//   const owner =
//     ownerId instanceof Types.ObjectId
//       ? ownerId
//       : Types.ObjectId.isValid(ownerId)
//         ? new Types.ObjectId(ownerId)
//         : null;

//   if (!owner) return false;

//   const first = normalizeString(firstName);
//   const last = normalizeString(lastName);
//   if (!first || !last) return false;

//   const baseCustomer = await findBaseCustomerForChild({
//     ownerId: owner,
//     childFirstName: first,
//     childLastName: last,
//     childBirthDate: birthDate || null,
//   });

//   if (!baseCustomer) return false;

//   const familyIds = [
//     baseCustomer._id,
//     ...(Array.isArray(baseCustomer.relatedCustomerIds)
//       ? baseCustomer.relatedCustomerIds
//       : []),
//   ];

//   const familyCustomers = await Customer.find({
//     _id: { $in: familyIds },
//     owner,
//   }).lean();

//   const emailLower = normalizeEmail(parentEmail);

//   const scopedCustomers = emailLower
//     ? familyCustomers.filter((c) => {
//         const e1 = normalizeEmail(c.emailLower || c.email || "");
//         const e2 = normalizeEmail(c.parent?.email || "");
//         return e1 === emailLower || e2 === emailLower;
//       })
//     : familyCustomers;

//   if (!scopedCustomers.length) return false;

//   const bookingIds = [];
//   for (const c of scopedCustomers) {
//     if (!Array.isArray(c.bookings)) continue;
//     for (const b of c.bookings) {
//       if (b && b.bookingId) bookingIds.push(b.bookingId);
//     }
//   }

//   if (!bookingIds.length) return false;

//   const bookings = await Booking.find({
//     _id: { $in: bookingIds },
//     owner,
//     status: { $nin: ["deleted", "storno", "cancelled"] },
//     paymentStatus: "paid",
//   })
//     .populate("offerId", "category type sub_type")
//     .lean();

//   if (!bookings.length) return false;

//   return bookings.some((b) => isWeeklyOfferForGate(b.offerId));
// }

async function childHasActiveWeeklySubscriptionByChildId({ ownerId, childId }) {
  const owner =
    ownerId instanceof Types.ObjectId
      ? ownerId
      : Types.ObjectId.isValid(ownerId)
        ? new Types.ObjectId(ownerId)
        : null;

  const cid =
    childId instanceof Types.ObjectId
      ? childId
      : Types.ObjectId.isValid(childId)
        ? new Types.ObjectId(childId)
        : null;

  if (!owner || !cid) return false;

  const doc = await Booking.findOne({
    owner,
    childId: cid,
    status: { $in: ["pending", "processing", "confirmed"] },
    "stripe.mode": "subscription",
    "stripe.subscriptionId": { $ne: "" },
    "stripe.subStatus": { $in: ["active", "trialing"] },
  })
    .select("_id")
    .lean();

  return !!doc?._id;
}

function normalizeParentData(parentData = {}) {
  return {
    salutation: normalizeString(parentData.salutation),
    firstName: normalizeString(parentData.firstName),
    lastName: normalizeString(parentData.lastName),
    email: normalizeEmail(parentData.email),
    phone: normalizeString(parentData.phone),
    phone2: normalizeString(parentData.phone2),
  };
}

function parentHasData(parent) {
  if (!parent) return false;
  return [
    parent.salutation,
    parent.firstName,
    parent.lastName,
    parent.email,
    parent.phone,
    parent.phone2,
  ].some((v) => normalizeString(v) !== "");
}

function sameParent(a, b) {
  const pa = normalizeParentData(a);
  const pb = normalizeParentData(b);

  if (pa.email && pb.email) return pa.email === pb.email;

  const sameName =
    pa.firstName.toLowerCase() === pb.firstName.toLowerCase() &&
    pa.lastName.toLowerCase() === pb.lastName.toLowerCase();

  if (!sameName) return false;
  if (pa.phone && pb.phone) return pa.phone === pb.phone;
  if (pa.phone2 && pb.phone2) return pa.phone2 === pb.phone2;
  return sameName;
}

function copyMissingParentFields(target, source) {
  let changed = false;

  for (const key of [
    "salutation",
    "firstName",
    "lastName",
    "email",
    "phone",
    "phone2",
  ]) {
    const cur = normalizeString(target?.[key]);
    const next = normalizeString(source?.[key]);
    if (!cur && next) {
      target[key] = next;
      changed = true;
    }
  }

  return changed;
}

async function ensureParentOnCustomer({ customer, parentData = {} }) {
  if (!customer) return false;

  const incoming = normalizeParentData(parentData);
  if (!parentHasData(incoming)) return false;

  if (!Array.isArray(customer.parents)) {
    customer.parents = [];
  }

  const legacyParent = customer.parent || {};
  if (parentHasData(legacyParent)) {
    const hasLegacyInParents = customer.parents.some((p) =>
      sameParent(p, legacyParent),
    );

    if (!hasLegacyInParents) {
      customer.parents.push(normalizeParentData(legacyParent));
    }
  }

  const existing = customer.parents.find((p) => sameParent(p, incoming));

  if (existing) {
    return copyMissingParentFields(existing, incoming);
  }

  customer.parents.push(incoming);

  if (!parentHasData(customer.parent)) {
    customer.parent = { ...incoming };
  }

  return true;
}

module.exports = {
  normalizeString,
  normalizeEmail,
  normalizeDateOnly,
  hasSameChild,
  findBaseCustomerForChild,
  createCustomerForNewParent,
  childHasActiveWeeklyBooking,
  ensureParentOnCustomer,
  childHasActiveWeeklySubscriptionByChildId,
};
