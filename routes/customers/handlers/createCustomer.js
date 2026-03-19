// routes/customers/handlers/createCustomer.js
"use strict";

const mongoose = require("mongoose");
const { Types } = mongoose;

const crypto = require("crypto");
const Customer = require("../../../models/Customer");

function safeText(v) {
  return String(v ?? "").trim();
}

function newUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeParent(raw) {
  return {
    salutation: ["Frau", "Herr"].includes(raw?.salutation)
      ? raw.salutation
      : "",
    firstName: safeText(raw?.firstName),
    lastName: safeText(raw?.lastName),
    email: safeText(raw?.email).toLowerCase(),
    phone: safeText(raw?.phone),
    phone2: safeText(raw?.phone2),
  };
}

function hasParentData(parent) {
  return !!(
    safeText(parent?.salutation) ||
    safeText(parent?.firstName) ||
    safeText(parent?.lastName) ||
    safeText(parent?.email) ||
    safeText(parent?.phone) ||
    safeText(parent?.phone2)
  );
}

function sameParent(a, b) {
  const aEmail = safeText(a?.email).toLowerCase();
  const bEmail = safeText(b?.email).toLowerCase();

  if (aEmail && bEmail) return aEmail === bEmail;

  return (
    safeText(a?.firstName).toLowerCase() ===
      safeText(b?.firstName).toLowerCase() &&
    safeText(a?.lastName).toLowerCase() === safeText(b?.lastName).toLowerCase()
  );
}

function buildParents(rawParent, rawParents) {
  const activeParent = normalizeParent(rawParent);
  const list = Array.isArray(rawParents)
    ? rawParents.map((p) => normalizeParent(p)).filter(hasParentData)
    : [];

  if (
    hasParentData(activeParent) &&
    !list.some((p) => sameParent(p, activeParent))
  ) {
    list.push(activeParent);
  }

  return list;
}

async function createCustomer(req, res, requireOwner) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const b = req.body || {};

    const familyOfRaw = b.familyOf;
    const familyOf =
      familyOfRaw && mongoose.isValidObjectId(familyOfRaw)
        ? new Types.ObjectId(familyOfRaw)
        : null;

    const parentEmail = safeText(b.parent?.email).toLowerCase();

    if (!familyOf && parentEmail) {
      const existing = await Customer.findOne({
        owner,
        $or: [
          { emailLower: parentEmail },
          { email: parentEmail },
          { "parent.email": parentEmail },
          { "parents.email": parentEmail },
        ],
      }).lean();

      if (existing) {
        return res.status(409).json({
          ok: false,
          error: "CUSTOMER_EXISTS",
          message: "Ein Kunde mit dieser E-Mail ist bereits vorhanden.",
          customerId: existing._id,
        });
      }
    }

    const errors = {};
    if (!b.child?.firstName) errors.childFirstName = "required";
    if (!b.child?.lastName) errors.childLastName = "required";
    if (!b.parent?.email) errors.parentEmail = "required";
    if (Object.keys(errors).length) {
      return res.status(400).json({ errors });
    }

    const nextNo = await Customer.nextUserIdForOwner(owner);

    const childUid = safeText(b.child?.uid) || newUid();

    const childObj = {
      uid: childUid,
      firstName: safeText(b.child?.firstName),
      lastName: safeText(b.child?.lastName),
      gender: ["weiblich", "männlich"].includes(b.child?.gender)
        ? b.child.gender
        : "",
      birthDate: b.child?.birthDate ? new Date(b.child.birthDate) : null,
      club: safeText(b.child?.club),
    };

    const parentObj = normalizeParent(b.parent);
    const parents = buildParents(b.parent, b.parents);

    const doc = await Customer.create({
      owner,
      userId: nextNo,
      newsletter: !!b.newsletter,
      email: parentObj.email || undefined,
      emailLower: parentObj.email || undefined,
      address: {
        street: b.address?.street || "",
        houseNo: b.address?.houseNo || "",
        zip: b.address?.zip || "",
        city: b.address?.city || "",
      },
      child: childObj,
      children: [childObj],
      // parent: {
      //   salutation: ["Frau", "Herr"].includes(b.parent?.salutation)
      //     ? b.parent.salutation
      //     : "",
      //   firstName: b.parent?.firstName || "",
      //   lastName: b.parent?.lastName || "",
      //   email: b.parent?.email || "",
      //   phone: b.parent?.phone || "",
      //   phone2: b.parent?.phone2 || "",
      // },

      parent: parentObj,
      parents,
      notes: b.notes || "",
      bookings: Array.isArray(b.bookings) ? b.bookings : [],
      relatedCustomerIds: familyOf
        ? [familyOf]
        : Array.isArray(b.relatedCustomerIds)
          ? b.relatedCustomerIds
          : [],
    });

    if (familyOf) {
      await Customer.updateOne(
        { _id: familyOf, owner },
        { $addToSet: { relatedCustomerIds: doc._id } },
      );
    }

    res.status(201).json(doc);
  } catch (err) {
    console.error("[customers:POST] error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { createCustomer };

// //routes\customers\handlers\createCustomer.js
// "use strict";

// const mongoose = require("mongoose");
// const { Types } = mongoose;

// const Customer = require("../../../models/Customer");

// async function createCustomer(req, res, requireOwner) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const b = req.body || {};

//     const familyOfRaw = b.familyOf;
//     const familyOf =
//       familyOfRaw && mongoose.isValidObjectId(familyOfRaw)
//         ? new Types.ObjectId(familyOfRaw)
//         : null;

//     const parentEmail = String(b.parent?.email || "")
//       .trim()
//       .toLowerCase();
//     const parentFirst = String(b.parent?.firstName || "")
//       .trim()
//       .toLowerCase();
//     const parentLast = String(b.parent?.lastName || "")
//       .trim()
//       .toLowerCase();

//     if (!familyOf && parentEmail) {
//       const existing = await Customer.findOne({
//         owner,
//         $or: [
//           { emailLower: parentEmail },
//           { email: parentEmail },
//           { "parent.email": parentEmail },
//         ],
//       }).lean();

//       if (existing) {
//         return res.status(409).json({
//           ok: false,
//           error: "CUSTOMER_EXISTS",
//           message: "Ein Kunde mit dieser E-Mail ist bereits vorhanden.",
//           customerId: existing._id,
//         });
//       }
//     }

//     const errors = {};
//     if (!b.child?.firstName) errors.childFirstName = "required";
//     if (!b.child?.lastName) errors.childLastName = "required";
//     if (!b.parent?.email) errors.parentEmail = "required";
//     if (Object.keys(errors).length) {
//       return res.status(400).json({ errors });
//     }

//     const nextNo = await Customer.nextUserIdForOwner(owner);

//     const doc = await Customer.create({
//       owner,
//       userId: nextNo,
//       newsletter: !!b.newsletter,
//       address: {
//         street: b.address?.street || "",
//         houseNo: b.address?.houseNo || "",
//         zip: b.address?.zip || "",
//         city: b.address?.city || "",
//       },
//       child: {
//         firstName: b.child?.firstName || "",
//         lastName: b.child?.lastName || "",
//         gender: ["weiblich", "männlich"].includes(b.child?.gender)
//           ? b.child.gender
//           : "",
//         birthDate: b.child?.birthDate ? new Date(b.child.birthDate) : null,
//         club: b.child?.club || "",
//       },
//       parent: {
//         salutation: ["Frau", "Herr"].includes(b.parent?.salutation)
//           ? b.parent.salutation
//           : "",
//         firstName: b.parent?.firstName || "",
//         lastName: b.parent?.lastName || "",
//         email: b.parent?.email || "",
//         phone: b.parent?.phone || "",
//         phone2: b.parent?.phone2 || "",
//       },
//       notes: b.notes || "",
//       bookings: Array.isArray(b.bookings) ? b.bookings : [],
//       relatedCustomerIds: familyOf
//         ? [familyOf]
//         : Array.isArray(b.relatedCustomerIds)
//           ? b.relatedCustomerIds
//           : [],
//     });

//     if (familyOf) {
//       await Customer.updateOne(
//         { _id: familyOf, owner },
//         { $addToSet: { relatedCustomerIds: doc._id } },
//       );
//     }

//     res.status(201).json(doc);
//   } catch (err) {
//     console.error("[customers:POST] error:", err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { createCustomer };
