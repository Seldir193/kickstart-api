// utils/relations.js
'use strict';

const mongoose = require('mongoose');
const { Types } = mongoose;

const Customer = require('../models/Customer');
const Booking  = require('../models/Booking');
const Offer    = require('../models/Offer');

/* ===================== Helpers ===================== */

function normalizeString(v) {
  return String(v || '').trim();
}

function normalizeEmail(v) {
  const s = normalizeString(v);
  return s ? s.toLowerCase() : '';
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
  const aLast  = normalizeString(childA.lastName).toLowerCase();
  const bFirst = normalizeString(childB.firstName).toLowerCase();
  const bLast  = normalizeString(childB.lastName).toLowerCase();

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

  if (
    customer.child &&
    (customer.child.firstName || customer.child.lastName)
  ) {
    return customer.child;
  }

  if (Array.isArray(customer.children) && customer.children.length > 0) {
    return customer.children[0];
  }

  return null;
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
  const last  = normalizeString(childLastName);

  if (!first || !last) return null;

  const birth = normalizeDateOnly(childBirthDate);

  const owner =
    ownerId instanceof Types.ObjectId
      ? ownerId
      : (Types.ObjectId.isValid(ownerId) ? new Types.ObjectId(ownerId) : null);

  if (!owner) return null;

  // Grobfilter in Mongo (nach Namen), exakte Prüfung dann in JS
  const firstRegex = new RegExp(
    `^${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'i',
  );
  const lastRegex = new RegExp(
    `^${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'i',
  );

  const candidates = await Customer.find({
    owner,
    $or: [
      { 'child.firstName': firstRegex, 'child.lastName': lastRegex },
      { 'children.firstName': firstRegex, 'children.lastName': lastRegex },
    ],
  }).exec();

  if (!candidates.length) return null;

  const childProbe = {
    firstName: first,
    lastName:  last,
    birthDate: birth ? new Date(birth) : null,
  };

  const matching = candidates.filter(c => {
    if (hasSameChild(c.child, childProbe)) return true;
    if (
      Array.isArray(c.children) &&
      c.children.some(ch => hasSameChild(ch, childProbe))
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
    throw new Error('createCustomerForNewParent: baseCustomer is required');
  }

  const owner =
    ownerId instanceof Types.ObjectId
      ? ownerId
      : (Types.ObjectId.isValid(ownerId) ? new Types.ObjectId(ownerId) : null);

  if (!owner) {
    throw new Error('createCustomerForNewParent: invalid ownerId');
  }

  const emailLower = normalizeEmail(parentData.email);

  const baseChild = getPrimaryChildFromCustomer(baseCustomer) || {};

  const child = {
    firstName: normalizeString(
      childDataOverride.firstName || baseChild.firstName,
    ),
    lastName: normalizeString(
      childDataOverride.lastName || baseChild.lastName,
    ),
    birthDate: childDataOverride.birthDate || baseChild.birthDate || null,
    gender: normalizeString(
      childDataOverride.gender || baseChild.gender || '',
    ),
    club: normalizeString(childDataOverride.club || baseChild.club || ''),
  };

  // userId-Sequence pro Owner hochziehen
  await Customer.syncCounterWithExisting(owner);
  const nextUserId = await Customer.nextUserIdForOwner(owner);

  // neuen Customer anlegen
  const newCustomer = await Customer.create({
    owner,
    userId: nextUserId,

    email:      emailLower || undefined,
    emailLower: emailLower || undefined,

    parent: {
      salutation: normalizeString(parentData.salutation),
      firstName:  normalizeString(parentData.firstName),
      lastName:   normalizeString(parentData.lastName),
      email:      emailLower || undefined,
      phone:      normalizeString(parentData.phone),
      phone2:     normalizeString(parentData.phone2),
    },

    child,
    children: (child.firstName || child.lastName) ? [child] : [],

    notes: '',
    bookings: [],

    relatedCustomerIds: [baseCustomer._id],
  });

  // Base-Customer bidirektional verknüpfen
  if (!Array.isArray(baseCustomer.relatedCustomerIds)) {
    baseCustomer.relatedCustomerIds = [];
  }

  const alreadyLinked = baseCustomer.relatedCustomerIds.some(
    id => String(id) === String(newCustomer._id),
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

async function childHasActiveWeeklyBooking({
  ownerId,
  firstName,
  lastName,
  birthDate,
}) {
  const owner =
    ownerId instanceof Types.ObjectId
      ? ownerId
      : (Types.ObjectId.isValid(ownerId) ? new Types.ObjectId(ownerId) : null);

  if (!owner) return false;

  const first = normalizeString(firstName);
  const last  = normalizeString(lastName);
  if (!first || !last) return false;

  // 1) Basis-Kunde über Kind (Name + optional Geburtsdatum) finden
  const baseCustomer = await findBaseCustomerForChild({
    ownerId: owner,
    childFirstName: first,
    childLastName:  last,
    childBirthDate: birthDate || null,
  });


   console.log('[relations] childHasActiveWeeklyBooking – baseCustomer', {
    owner: String(owner),
    firstName: first,
    lastName: last,
    birthDate,
    baseCustomerId: baseCustomer ? String(baseCustomer._id) : null,
  });


  if (!baseCustomer) {
    // Kein bekannter Kunde mit diesem Kind → kein Weekly
    return false;
  }

  // 2) Familie: Base + relatedCustomerIds
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

  // 3) Booking-IDs aus den Customers einsammeln
  const bookingIds = [];
  for (const c of familyCustomers) {
    if (Array.isArray(c.bookings)) {
      for (const b of c.bookings) {
        if (b && b.bookingId) {
          bookingIds.push(b.bookingId);
        }
      }
    }
  }

  if (!bookingIds.length) return false;

  // 4) Echte Bookings + Offer laden
  const bookings = await Booking.find({
    _id:   { $in: bookingIds },
    owner: owner,
    status: { $in: ['pending', 'processing', 'confirmed'] },
  })
    .populate('offerId', 'category type sub_type')
    .lean();

      console.log('[relations] childHasActiveWeeklyBooking – bookings', {
    count: bookings.length,
    bookingIds: bookingIds.map(id => String(id)),
    offers: bookings.map(b => ({
      bookingId: String(b._id),
      offerId: b.offerId ? String(b.offerId._id || b.offerId) : null,
      category: b.offerId?.category,
      type:     b.offerId?.type,
      sub_type: b.offerId?.sub_type,
      status:   b.status,
    })),
  });


  if (!bookings.length) return false;

  // 5) Helper für Weekly-Erkennung
  function isWeeklyOffer(offer) {
    if (!offer) return false;
    const cat  = String(offer.category || '');
    const type = String(offer.type || '');
    const sub  = String(offer.sub_type || '').toLowerCase();

    if (cat === 'Weekly') return true;
    if (type === 'Foerdertraining' || type === 'Kindergarten') return true;

    // explizite Non-Weekly
    if (cat === 'Holiday') return false;
    if (sub.includes('powertraining')) return false;

    return false;
  }

  // 6) Mindestens eine Weekly-Buchung in der Familie?
  return bookings.some(b => isWeeklyOffer(b.offerId));
}

module.exports = {
  normalizeString,
  normalizeEmail,
  normalizeDateOnly,
  hasSameChild,
  findBaseCustomerForChild,
  createCustomerForNewParent,
  childHasActiveWeeklyBooking,   // ⬅️ wichtig: exportieren
};







