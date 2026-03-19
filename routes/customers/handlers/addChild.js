"use strict";

const crypto = require("crypto");
const Customer = require("../../../models/Customer");

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function birthKey(v) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function childNameKey(child) {
  return `${safeLower(child?.firstName)}::${safeLower(child?.lastName)}`;
}

function childExactKey(child) {
  return `${childNameKey(child)}::${birthKey(child?.birthDate)}`;
}

function newUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeChild(raw) {
  return {
    uid: safeText(raw?.uid),
    firstName: safeText(raw?.firstName),
    lastName: safeText(raw?.lastName),
    gender: safeText(raw?.gender),
    birthDate: toDateOrNull(raw?.birthDate),
    club: safeText(raw?.club),
  };
}

function hasChildData(child) {
  return !!(safeText(child?.firstName) || safeText(child?.lastName));
}

function mergeChild(target, source) {
  if (!safeText(target.uid) && safeText(source.uid)) {
    target.uid = safeText(source.uid);
  }
  if (!safeText(target.firstName) && safeText(source.firstName)) {
    target.firstName = safeText(source.firstName);
  }
  if (!safeText(target.lastName) && safeText(source.lastName)) {
    target.lastName = safeText(source.lastName);
  }
  if (!target.birthDate && source.birthDate) {
    target.birthDate = toDateOrNull(source.birthDate);
  }
  if (!safeText(target.gender) && safeText(source.gender)) {
    target.gender = safeText(source.gender);
  }
  if (!safeText(target.club) && safeText(source.club)) {
    target.club = safeText(source.club);
  }
  if (!safeText(target.uid)) {
    target.uid = newUid();
  }
  return target;
}

function findExistingChild(children, child) {
  const uid = safeText(child?.uid);
  if (uid) {
    const byUid = children.find((c) => safeText(c?.uid) === uid);
    if (byUid) return byUid;
  }

  const exactKey = childExactKey(child);
  if (exactKey && exactKey !== "::::") {
    const byExact = children.find((c) => childExactKey(c) === exactKey);
    if (byExact) return byExact;
  }

  const nameKey = childNameKey(child);
  if (!nameKey || nameKey === "::") return null;

  const sameName = children.filter((c) => childNameKey(c) === nameKey);
  if (sameName.length === 1) return sameName[0];

  const wantedBirth = birthKey(child?.birthDate);
  if (wantedBirth) {
    const byBirth = sameName.find(
      (c) => birthKey(c?.birthDate) === wantedBirth,
    );
    if (byBirth) return byBirth;

    const missingBirth = sameName.filter((c) => !birthKey(c?.birthDate));
    if (missingBirth.length === 1) return missingBirth[0];
  }

  return null;
}

function syncPrimaryChild(customer, child) {
  if (!customer.child || typeof customer.child !== "object") {
    customer.child = child;
    return;
  }

  const sameUid =
    safeText(customer.child?.uid) &&
    safeText(customer.child?.uid) === safeText(child?.uid);

  const sameName =
    childNameKey(customer.child) === childNameKey(child) &&
    childNameKey(child) !== "::";

  if (sameUid || sameName || !safeText(customer.child?.uid)) {
    mergeChild(customer.child, child);
  }
}

async function addChild(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const incoming = normalizeChild(req.body || {});
    if (!hasChildData(incoming)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CHILD",
        message: "At least firstName or lastName is required for a child.",
      });
    }

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    if (!Array.isArray(customer.children)) {
      customer.children = [];
    }

    const existing = findExistingChild(customer.children, incoming);

    if (existing) {
      mergeChild(existing, incoming);
      syncPrimaryChild(customer, existing);
    } else {
      incoming.uid = safeText(incoming.uid) || newUid();
      customer.children.push(incoming);
      syncPrimaryChild(customer, incoming);
    }

    await customer.save();

    return res.json({
      ok: true,
      customerId: String(customer._id),
      children: customer.children,
      child: customer.child,
    });
  } catch (err) {
    console.error("[customers/:id/children] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { addChild };

// //routes\customers\handlers\addChild.js
// "use strict";

// const crypto = require("crypto");
// const Customer = require("../../../models/Customer");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function newUid() {
//   if (crypto.randomUUID) return crypto.randomUUID();
//   return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
// }

// async function addChild(req, res, requireOwner, requireId, hasSameChild) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const { firstName, lastName, birthDate } = req.body || {};
//     if (!firstName && !lastName) {
//       return res.status(400).json({
//         ok: false,
//         error: "INVALID_CHILD",
//         message: "At least firstName or lastName is required for a child.",
//       });
//     }

//     const customer = await Customer.findOne({ _id: id, owner });
//     if (!customer) {
//       return res.status(404).json({ ok: false, error: "Customer not found" });
//     }

//     if (!Array.isArray(customer.children)) customer.children = [];

//     const newChild = {
//       uid: newUid(),
//       firstName: safeText(firstName),
//       lastName: safeText(lastName),
//       birthDate: birthDate ? new Date(birthDate) : null,
//     };

//     const exists = customer.children.some((ch) => hasSameChild(ch, newChild));
//     if (!exists) {
//       customer.children.push(newChild);
//       await customer.save();
//     }

//     return res.json({
//       ok: true,
//       customerId: String(customer._id),
//       children: customer.children,
//     });
//   } catch (err) {
//     console.error("[customers/:id/children] error:", err);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// }

// module.exports = { addChild };
