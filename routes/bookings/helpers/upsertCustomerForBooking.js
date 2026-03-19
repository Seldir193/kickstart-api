//routes\bookings\helpers\upsertCustomerForBooking.js
"use strict";

const Customer = require("../../../models/Customer");

const {
  findBaseCustomerForChild,
  //createCustomerForNewParent,
  ensureParentOnCustomer,
} = require("../../../utils/relations");

const { prorateForStart } = require("./pricing");
const {
  normalizeEmail,
  extractChildFromPayload,
  hasSameChild,
} = require("./customer");

const {
  isWeeklyOffer,
  isPowertrainingOffer,
  isCampOffer,
} = require("./offerTypes");

function asObj(v) {
  return v && typeof v === "object" ? v : {};
}

function pickFirst(...vals) {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function mapWpBilling(payload, fallbackEmailLower) {
  const p = asObj(payload);
  const billing = asObj(p.billing || p.customer || p.parent || p.invoice);
  const addr = asObj(billing.address || billing.billing_address || billing);

  const email = pickFirst(
    billing.email,
    p.parentEmail,
    p.email,
    fallbackEmailLower,
  );

  return {
    parent: {
      salutation: pickFirst(
        billing.salutation,
        billing.title,
        p.salutation,
        p.parent?.salutation,
      ),
      firstName: pickFirst(
        billing.firstName,
        billing.first_name,
        p.parentFirstName,
        p.parent?.firstName,
      ),
      lastName: pickFirst(
        billing.lastName,
        billing.last_name,
        p.parentLastName,
        p.parent?.lastName,
      ),
      email,
      phone: pickFirst(
        billing.phone,
        billing.phone_number,
        p.phone,
        p.parent?.phone,
      ),
      phone2: pickFirst(
        billing.phone2,
        billing.phone_2,
        p.phone2,
        p.parent?.phone2,
      ),
    },
    address: {
      street: pickFirst(
        addr.street,
        addr.address_1,
        p.street,
        p.address1,
        p.address?.street,
      ),
      houseNo: pickFirst(
        addr.houseNo,
        addr.house_no,
        addr.houseNumber,
        addr.house_number,
        p.houseNo,
        p.houseNumber,
        p.address?.houseNo,
      ),
      zip: pickFirst(addr.zip, addr.postcode, p.zip, p.plz, p.address?.zip),
      city: pickFirst(addr.city, p.city, p.stadt, p.address?.city),
    },
  };
}

function setIfEmpty(obj, key, val) {
  const cur = String(obj?.[key] ?? "").trim();
  const next = String(val ?? "").trim();
  if (!cur && next) {
    obj[key] = next;
    return true;
  }
  return false;
}

function applyBillingToCustomerDoc(customer, mapped) {
  if (!customer || !mapped) return false;

  if (!customer.parent) customer.parent = {};
  if (!customer.address) customer.address = {};

  let changed = false;

  changed =
    setIfEmpty(customer.parent, "salutation", mapped.parent.salutation) ||
    changed;
  changed =
    setIfEmpty(customer.parent, "firstName", mapped.parent.firstName) ||
    changed;
  changed =
    setIfEmpty(customer.parent, "lastName", mapped.parent.lastName) || changed;
  changed =
    setIfEmpty(customer.parent, "email", mapped.parent.email) || changed;
  changed =
    setIfEmpty(customer.parent, "phone", mapped.parent.phone) || changed;
  changed =
    setIfEmpty(customer.parent, "phone2", mapped.parent.phone2) || changed;

  changed =
    setIfEmpty(customer.address, "street", mapped.address.street) || changed;
  changed =
    setIfEmpty(customer.address, "houseNo", mapped.address.houseNo) || changed;
  changed = setIfEmpty(customer.address, "zip", mapped.address.zip) || changed;
  changed =
    setIfEmpty(customer.address, "city", mapped.address.city) || changed;

  if (
    !String(customer.email || "").trim() &&
    String(mapped.parent.email || "").trim()
  ) {
    customer.email = String(mapped.parent.email).trim();
    changed = true;
  }

  const lower = String(customer.email || "")
    .trim()
    .toLowerCase();
  if (lower && customer.emailLower !== lower) {
    customer.emailLower = lower;
    changed = true;
  }

  return changed;
}

function parentPayloadFromMapped(mapped, emailLower) {
  return {
    salutation: mapped.parent.salutation || "",
    firstName: mapped.parent.firstName || "",
    lastName: mapped.parent.lastName || "",
    email: emailLower || mapped.parent.email || "",
    phone: mapped.parent.phone || "",
    phone2: mapped.parent.phone2 || "",
  };
}

async function upsertCustomerForBooking({
  ownerId,
  offer,
  bookingDoc,
  payload,
  isPowertraining = false,
}) {
  const emailLower = normalizeEmail(payload.email);
  const mapped = mapWpBilling(payload, emailLower);
  const childFromForm = extractChildFromPayload(payload);

  const bookingDate = new Date(String(payload.date) + "T00:00:00");
  const venue =
    typeof offer?.location === "string"
      ? offer.location
      : offer?.location?.name || offer?.location?.title || "";

  const offerPrice =
    typeof offer?.price === "number" ? Number(offer.price) : null;

  const weekly = isWeeklyOffer(offer);

  const snapCurrency = String(bookingDoc?.currency || "EUR");

  const snapAtBooking =
    typeof bookingDoc?.priceAtBooking === "number"
      ? Number(bookingDoc.priceAtBooking)
      : offerPrice != null
        ? offerPrice
        : null;

  const snapMonthly =
    typeof bookingDoc?.priceMonthly === "number"
      ? Number(bookingDoc.priceMonthly)
      : weekly && offerPrice != null
        ? offerPrice
        : null;

  const snapFirstMonth =
    typeof bookingDoc?.priceFirstMonth === "number"
      ? Number(bookingDoc.priceFirstMonth)
      : weekly && snapMonthly != null && payload?.date
        ? prorateForStart(String(payload.date), snapMonthly).firstMonthPrice
        : null;

  if (!bookingDoc.meta || typeof bookingDoc.meta !== "object")
    bookingDoc.meta = {};
  if (bookingDoc.meta.basePrice == null && offerPrice != null) {
    bookingDoc.meta.basePrice = offerPrice;
  }

  const bookingRef = {
    bookingId: bookingDoc._id,
    offerId: offer._id,
    offerTitle: String(offer.title || ""),
    offerType: String(offer.type || ""),
    venue,
    date: isNaN(bookingDate.getTime()) ? null : bookingDate,
    status: "active",
    currency: snapCurrency,
    priceAtBooking: snapAtBooking,
    priceMonthly: snapMonthly,
    priceFirstMonth: snapFirstMonth,
  };

  let customer = null;

  const isPowerByOffer = isPowertrainingOffer(offer);
  const isCampByOffer = isCampOffer(offer);

  const useHolidayFamilyMode =
    isPowertraining || isPowerByOffer || isCampByOffer;

  if (
    useHolidayFamilyMode &&
    (childFromForm.firstName || childFromForm.lastName)
  ) {
    const baseCustomer = await findBaseCustomerForChild({
      ownerId,
      childFirstName: childFromForm.firstName,
      childLastName: childFromForm.lastName,
      childBirthDate: childFromForm.birthDate,
    });

    const parentEmail = emailLower;

    if (baseCustomer) {
      customer = baseCustomer;

      await ensureParentOnCustomer({
        customer,
        parentData: parentPayloadFromMapped(mapped, parentEmail),
      });

      applyBillingToCustomerDoc(customer, mapped);
    }

    // if (baseCustomer) {
    //   const baseParentEmail = normalizeEmail(baseCustomer.parent?.email);
    //   const isSameParent =
    //     parentEmail && baseParentEmail && parentEmail === baseParentEmail;

    //   if (isSameParent) {
    //     customer = baseCustomer;
    //   } else {
    //     customer = await createCustomerForNewParent({
    //       ownerId,
    //       baseCustomer,
    //       parentData: {
    //         salutation: mapped.parent.salutation || "",
    //         firstName: mapped.parent.firstName || "",
    //         lastName: mapped.parent.lastName || "",
    //         email: parentEmail,
    //         phone: mapped.parent.phone || "",
    //         phone2: mapped.parent.phone2 || "",
    //       },
    //       childDataOverride: {
    //         firstName: childFromForm.firstName,
    //         lastName: childFromForm.lastName,
    //         birthDate: childFromForm.birthDate,
    //         gender: payload.child?.gender || "",
    //         club: payload.child?.club || childFromForm.club || "",
    //       },
    //     });

    //     if (customer) applyBillingToCustomerDoc(customer, mapped);
    //   }
    // }
  }

  // if (!customer && emailLower) {
  //   customer = await Customer.findOne({
  //     owner: ownerId,
  //     $or: [
  //       { emailLower },
  //       { email: emailLower },
  //       { "parent.email": emailLower },
  //     ],
  //   });
  // }

  if (!customer && emailLower) {
    customer = await Customer.findOne({
      owner: ownerId,
      $or: [
        { emailLower },
        { email: emailLower },
        { "parent.email": emailLower },
        { "parents.email": emailLower },
      ],
    });
  }

  if (!customer && (childFromForm.firstName || childFromForm.lastName)) {
    const candidates = await Customer.find({ owner: ownerId })
      .select("child children email emailLower parent bookings")
      .lean();

    const match = candidates.find((c) => {
      const mainChildMatch = hasSameChild(c.child, childFromForm);
      const anyChildMatch =
        Array.isArray(c.children) &&
        c.children.some((ch) => hasSameChild(ch, childFromForm));
      return mainChildMatch || anyChildMatch;
    });

    if (match) customer = await Customer.findById(match._id);
  }

  if (!customer) {
    await Customer.syncCounterWithExisting(ownerId);
    const nextUserId = await Customer.nextUserIdForOwner(ownerId);

    const child = {
      firstName: childFromForm.firstName,
      lastName: childFromForm.lastName,
      birthDate: childFromForm.birthDate,
      club: childFromForm.club,
    };

    customer = await Customer.create({
      owner: ownerId,
      userId: nextUserId,

      email: emailLower || undefined,
      emailLower: emailLower || undefined,
      newsletter: false,

      parent: {
        salutation: mapped.parent.salutation || "",
        firstName: mapped.parent.firstName || "",
        lastName: mapped.parent.lastName || "",
        email: emailLower || undefined,
        phone: mapped.parent.phone || "",
        phone2: mapped.parent.phone2 || "",
      },

      parents: [
        {
          salutation: mapped.parent.salutation || "",
          firstName: mapped.parent.firstName || "",
          lastName: mapped.parent.lastName || "",
          email: emailLower || undefined,
          phone: mapped.parent.phone || "",
          phone2: mapped.parent.phone2 || "",
        },
      ],

      address: {
        street: mapped.address.street || "",
        houseNo: mapped.address.houseNo || "",
        zip: mapped.address.zip || "",
        city: mapped.address.city || "",
      },

      child,
      children: child.firstName || child.lastName ? [child] : [],

      notes: (payload.message || "").toString(),
      bookings: [bookingRef],
      marketingStatus: null,
    });

    return customer;
  }

  if (customer.userId == null) {
    await Customer.assignUserIdIfMissing(customer);
  }

  if (!Array.isArray(customer.children)) {
    customer.children = [];
  }

  if (
    customer.child &&
    (customer.child.firstName || customer.child.lastName) &&
    customer.children.length === 0
  ) {
    customer.children.push({
      firstName: customer.child.firstName,
      lastName: customer.child.lastName,
      birthDate: customer.child.birthDate,
      club: customer.child.club,
    });
  }

  const hasChildAlready =
    hasSameChild(customer.child, childFromForm) ||
    customer.children.some((c) => hasSameChild(c, childFromForm));

  if (!hasChildAlready && (childFromForm.firstName || childFromForm.lastName)) {
    customer.children.push({
      firstName: childFromForm.firstName,
      lastName: childFromForm.lastName,
      birthDate: childFromForm.birthDate,
      club: childFromForm.club,
    });

    if (
      !customer.child ||
      (!customer.child.firstName && !customer.child.lastName)
    ) {
      customer.child = customer.children[0];
    }
  }

  if (!Array.isArray(customer.bookings)) {
    customer.bookings = [];
  }

  const already = customer.bookings.some(
    (b) =>
      String(b.offerId) === String(offer._id) &&
      String(b.bookingId) === String(bookingDoc._id),
  );

  if (!already) {
    customer.bookings.push(bookingRef);
  }

  if (emailLower) {
    if (!customer.emailLower) customer.emailLower = emailLower;
    if (!customer.email) customer.email = emailLower;
    if (!customer.parent) customer.parent = {};
    if (!customer.parent.email) customer.parent.email = emailLower;
  }

  await ensureParentOnCustomer({
    customer,
    parentData: parentPayloadFromMapped(mapped, emailLower),
  });

  applyBillingToCustomerDoc(customer, mapped);

  await customer.save();
  return customer;
}

module.exports = { upsertCustomerForBooking };

// //routes\bookings\helpers\upsertCustomerForBooking.js
// "use strict";

// const Customer = require("../../../models/Customer");

// const {
//   findBaseCustomerForChild,
//   createCustomerForNewParent,
// } = require("../../../utils/relations");

// const { prorateForStart } = require("./pricing");
// const {
//   normalizeEmail,
//   extractChildFromPayload,
//   hasSameChild,
// } = require("./customer");

// const {
//   isWeeklyOffer,
//   isPowertrainingOffer,
//   isCampOffer,
// } = require("./offerTypes");

// async function upsertCustomerForBooking({
//   ownerId,
//   offer,
//   bookingDoc,
//   payload,
//   isPowertraining = false, // wird weiter unterstützt, aber intern ergänzt
// }) {
//   const emailLower = normalizeEmail(payload.email);
//   const childFromForm = extractChildFromPayload(payload);

//   // Basis-Infos für Booking-Referenz
//   const bookingDate = new Date(String(payload.date) + "T00:00:00");
//   const venue =
//     typeof offer?.location === "string"
//       ? offer.location
//       : offer?.location?.name || offer?.location?.title || "";

//   const offerPrice =
//     typeof offer?.price === "number" ? Number(offer.price) : null;

//   const isWeekly = isWeeklyOffer(offer);

//   const snapCurrency = String(bookingDoc?.currency || "EUR");

//   // ✅ FINAL Preis (nach Rabatt) – niemals aus Offer nachträglich berechnen
//   const snapAtBooking =
//     typeof bookingDoc?.priceAtBooking === "number"
//       ? Number(bookingDoc.priceAtBooking)
//       : offerPrice != null
//         ? offerPrice
//         : null;

//   // ✅ Weekly Snapshot (für PDFs + Invoices stabil)
//   const snapMonthly =
//     typeof bookingDoc?.priceMonthly === "number"
//       ? Number(bookingDoc.priceMonthly)
//       : isWeekly && offerPrice != null
//         ? offerPrice
//         : null;

//   const snapFirstMonth =
//     typeof bookingDoc?.priceFirstMonth === "number"
//       ? Number(bookingDoc.priceFirstMonth)
//       : isWeekly && snapMonthly != null && payload?.date
//         ? prorateForStart(String(payload.date), snapMonthly).firstMonthPrice
//         : null;

//   // ✅ BASE Preis Snapshot: verhindert, dass "Reguläre Teilnahmegebühr" bei alten PDFs nachzieht
//   // Nur setzen, wenn noch nicht existiert (niemals überschreiben!)
//   if (!bookingDoc.meta || typeof bookingDoc.meta !== "object")
//     bookingDoc.meta = {};
//   if (bookingDoc.meta.basePrice == null && offerPrice != null) {
//     bookingDoc.meta.basePrice = offerPrice;
//     //await bookingDoc.save(); // wichtig: Snapshot persistieren
//   }

//   const bookingRef = {
//     bookingId: bookingDoc._id,
//     offerId: offer._id,
//     offerTitle: String(offer.title || ""),
//     offerType: String(offer.type || ""),
//     venue,
//     date: isNaN(bookingDate.getTime()) ? null : bookingDate,
//     status: "active",

//     currency: snapCurrency,
//     priceAtBooking: snapAtBooking,
//     priceMonthly: snapMonthly,
//     priceFirstMonth: snapFirstMonth,
//   };

//   let customer = null;

//   /* =========================================================
//    * SPEZIALLOGIK FÜR HOLIDAY (Camp + Powertraining)
//    * ======================================================= */

//   // zusätzlich zum übergebenen Flag auch anhand des Offers erkennen
//   const isPowerByOffer = isPowertrainingOffer(offer);
//   const isCampByOffer = isCampOffer(offer);

//   // wir wollen die „Familien-Logik“ für Camp UND Powertraining anwenden
//   const useHolidayFamilyMode =
//     isPowertraining || isPowerByOffer || isCampByOffer;

//   if (
//     useHolidayFamilyMode &&
//     (childFromForm.firstName || childFromForm.lastName)
//   ) {
//     // 1) Base-Customer für dieses Kind suchen
//     const baseCustomer = await findBaseCustomerForChild({
//       ownerId,
//       childFirstName: childFromForm.firstName,
//       childLastName: childFromForm.lastName,
//       childBirthDate: childFromForm.birthDate,
//     });

//     const parentEmail = emailLower;

//     if (baseCustomer) {
//       const baseParentEmail = normalizeEmail(baseCustomer.parent?.email);

//       const isSameParent =
//         parentEmail && baseParentEmail && parentEmail === baseParentEmail;

//       if (isSameParent) {
//         // gleicher Elternteil → Base-Customer wiederverwenden
//         customer = baseCustomer;
//       } else {
//         // anderer Elternteil → neuer Customer, aber mit Relation + Kind-Kopie
//         customer = await createCustomerForNewParent({
//           ownerId,
//           baseCustomer,
//           parentData: {
//             salutation: payload.parent?.salutation || "",
//             firstName: payload.parent?.firstName || "",
//             lastName: payload.parent?.lastName || "",
//             email: parentEmail,
//             phone: payload.parent?.phone || "",
//             phone2: payload.parent?.phone2 || "",
//           },
//           childDataOverride: {
//             firstName: childFromForm.firstName,
//             lastName: childFromForm.lastName,
//             birthDate: childFromForm.birthDate,
//             gender: payload.child?.gender || "",
//             club: payload.child?.club || childFromForm.club || "",
//           },
//         });
//       }
//     }
//     // Wenn KEIN baseCustomer gefunden wurde, laufen wir unten in die Standard-Logik.
//   }

//   /* =========================================================
//    * STANDARD-LOGIK (für alle Programme + Fallback)
//    * ======================================================= */

//   // 1) Zuerst: nach Eltern-E-Mail suchen (wenn noch kein Customer gesetzt)
//   if (!customer && emailLower) {
//     customer = await Customer.findOne({
//       owner: ownerId,
//       $or: [
//         { emailLower },
//         { email: emailLower },
//         { "parent.email": emailLower },
//       ],
//     });
//   }

//   // 2) Falls kein Treffer: nach Kind suchen (Name + Geburtsdatum)
//   if (!customer && (childFromForm.firstName || childFromForm.lastName)) {
//     const candidates = await Customer.find({ owner: ownerId })
//       .select("child children email emailLower parent bookings")
//       .lean();

//     const match = candidates.find((c) => {
//       const mainChildMatch = hasSameChild(c.child, childFromForm);
//       const anyChildMatch =
//         Array.isArray(c.children) &&
//         c.children.some((ch) => hasSameChild(ch, childFromForm));
//       return mainChildMatch || anyChildMatch;
//     });

//     if (match) {
//       // echtes Mongoose-Dokument nachladen
//       customer = await Customer.findById(match._id);
//     }
//   }

//   // 3) Wenn immer noch kein Customer → neuen anlegen
//   if (!customer) {
//     await Customer.syncCounterWithExisting(ownerId);
//     const nextUserId = await Customer.nextUserIdForOwner(ownerId);

//     const child = {
//       firstName: childFromForm.firstName,
//       lastName: childFromForm.lastName,
//       birthDate: childFromForm.birthDate,
//       club: childFromForm.club,
//     };

//     customer = await Customer.create({
//       owner: ownerId,
//       userId: nextUserId,

//       email: emailLower || undefined,
//       emailLower: emailLower || undefined,
//       newsletter: false,

//       parent: {
//         email: emailLower || undefined,
//       },

//       child,
//       children: child.firstName || child.lastName ? [child] : [],

//       notes: (payload.message || "").toString(),
//       bookings: [bookingRef],
//       marketingStatus: null,
//     });

//     return customer;
//   }

//   // 4) Customer existiert → ggf. fehlende userId vergeben
//   if (customer.userId == null) {
//     await Customer.assignUserIdIfMissing(customer);
//   }

//   // 5) Child-Liste vorbereiten und ggf. neues Kind anhängen
//   if (!Array.isArray(customer.children)) {
//     customer.children = [];
//   }

//   if (
//     customer.child &&
//     (customer.child.firstName || customer.child.lastName) &&
//     customer.children.length === 0
//   ) {
//     customer.children.push({
//       firstName: customer.child.firstName,
//       lastName: customer.child.lastName,
//       birthDate: customer.child.birthDate,
//       club: customer.child.club,
//     });
//   }

//   const hasChildAlready =
//     hasSameChild(customer.child, childFromForm) ||
//     customer.children.some((c) => hasSameChild(c, childFromForm));

//   if (!hasChildAlready && (childFromForm.firstName || childFromForm.lastName)) {
//     customer.children.push({
//       firstName: childFromForm.firstName,
//       lastName: childFromForm.lastName,
//       birthDate: childFromForm.birthDate,
//       club: childFromForm.club,
//     });

//     if (
//       !customer.child ||
//       (!customer.child.firstName && !customer.child.lastName)
//     ) {
//       customer.child = customer.children[0];
//     }
//   }

//   // 6) BookingRef nur hinzufügen, wenn noch nicht vorhanden
//   if (!Array.isArray(customer.bookings)) {
//     customer.bookings = [];
//   }

//   const already = customer.bookings.some(
//     (b) =>
//       String(b.offerId) === String(offer._id) &&
//       String(b.bookingId) === String(bookingDoc._id),
//   );

//   if (!already) {
//     customer.bookings.push(bookingRef);
//   }

//   // 7) Basis-Felder sauber halten (aber nichts überschreiben, was schon da ist)
//   if (emailLower) {
//     if (!customer.emailLower) customer.emailLower = emailLower;
//     if (!customer.email) customer.email = emailLower;
//     if (!customer.parent) customer.parent = {};
//     if (!customer.parent.email) customer.parent.email = emailLower;
//   }

//   await customer.save();
//   return customer;
// }

// module.exports = { upsertCustomerForBooking };
