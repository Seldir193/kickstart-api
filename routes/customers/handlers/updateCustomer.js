//routes\customers\handlers\updateCustomer.js
"use strict";

const crypto = require("crypto");
const Customer = require("../../../models/Customer");

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function normalizeGender(v) {
  return ["weiblich", "männlich"].includes(v) ? v : "";
}

function normalizeSalutation(v) {
  return ["Frau", "Herr"].includes(v) ? v : "";
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function uidOrEmpty(v) {
  return safeText(v);
}

function nextUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
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

function normalizeChild(raw) {
  const c = raw || {};
  return {
    uid: uidOrEmpty(c.uid),
    firstName: safeText(c.firstName),
    lastName: safeText(c.lastName),
    gender: normalizeGender(safeText(c.gender)),
    birthDate: toDateOrNull(c.birthDate),
    club: safeText(c.club),
  };
}

function normalizeChildren(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c) => normalizeChild(c));
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
  if (!safeText(target.gender) && safeText(source.gender)) {
    target.gender = normalizeGender(safeText(source.gender));
  }
  if (!target.birthDate && source.birthDate) {
    target.birthDate = toDateOrNull(source.birthDate);
  }
  if (!safeText(target.club) && safeText(source.club)) {
    target.club = safeText(source.club);
  }
  if (!safeText(target.uid)) {
    target.uid = nextUid();
  }
  return target;
}

function findByUid(children, child) {
  const uid = safeText(child?.uid);
  if (!uid) return null;
  return children.find((c) => safeText(c?.uid) === uid) || null;
}

function findByExact(children, child) {
  const key = childExactKey(child);
  if (!key || key === "::::") return null;
  return children.find((c) => childExactKey(c) === key) || null;
}

function findByNameFallback(children, child) {
  const nameKey = childNameKey(child);
  if (!nameKey || nameKey === "::") return null;

  const hits = children.filter((c) => childNameKey(c) === nameKey);
  if (hits.length === 1) return hits[0];

  const wantedBirth = birthKey(child?.birthDate);
  if (wantedBirth) {
    const exactBirth = hits.find((c) => birthKey(c?.birthDate) === wantedBirth);
    if (exactBirth) return exactBirth;

    const missingBirth = hits.filter((c) => !birthKey(c?.birthDate));
    if (missingBirth.length === 1) return missingBirth[0];
  }

  return null;
}

function upsertOneChild(children, rawChild) {
  const child = normalizeChild(rawChild);
  if (!hasChildData(child) && !safeText(child.uid)) return null;

  const byUid = findByUid(children, child);
  if (byUid) return mergeChild(byUid, child);

  const byExact = findByExact(children, child);
  if (byExact) return mergeChild(byExact, child);

  const byName = findByNameFallback(children, child);
  if (byName) return mergeChild(byName, child);

  child.uid = safeText(child.uid) || nextUid();
  children.push(child);
  return child;
}

function buildMergedChildren(current, body) {
  const existing = normalizeChildren(current?.children || []);
  const incomingChildren = normalizeChildren(body?.children || []);
  const incomingSelected = normalizeChild(body?.child);

  const merged = existing.map((c) => ({
    uid: safeText(c.uid) || nextUid(),
    firstName: safeText(c.firstName),
    lastName: safeText(c.lastName),
    gender: normalizeGender(safeText(c.gender)),
    birthDate: toDateOrNull(c.birthDate),
    club: safeText(c.club),
  }));

  for (const child of incomingChildren) {
    upsertOneChild(merged, child);
  }

  const selected = upsertOneChild(merged, incomingSelected);
  return { merged, selected };
}

function resolvePrimaryChild(current, body, mergedChildren, selectedChild) {
  const wantedUid =
    safeText(body?.child?.uid) ||
    safeText(selectedChild?.uid) ||
    safeText(current?.child?.uid);

  if (wantedUid) {
    const byUid = mergedChildren.find((c) => safeText(c.uid) === wantedUid);
    if (byUid) return byUid;
  }

  if (selectedChild) return selectedChild;
  if (mergedChildren[0]) return mergedChildren[0];

  return normalizeChild(body?.child || current?.child || {});
}

function normalizeParent(raw) {
  return {
    salutation: normalizeSalutation(safeText(raw?.salutation)),
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
  const pa = normalizeParent(a);
  const pb = normalizeParent(b);

  const aEmail = safeLower(pa.email);
  const bEmail = safeLower(pb.email);

  if (aEmail && bEmail) return aEmail === bEmail;

  return (
    safeLower(pa.firstName) === safeLower(pb.firstName) &&
    safeLower(pa.lastName) === safeLower(pb.lastName)
  );
}

function mergeParent(target, source) {
  if (!safeText(target.salutation) && safeText(source.salutation)) {
    target.salutation = normalizeSalutation(source.salutation);
  }
  if (!safeText(target.firstName) && safeText(source.firstName)) {
    target.firstName = safeText(source.firstName);
  }
  if (!safeText(target.lastName) && safeText(source.lastName)) {
    target.lastName = safeText(source.lastName);
  }
  if (!safeText(target.email) && safeText(source.email)) {
    target.email = safeLower(source.email);
  }
  if (!safeText(target.phone) && safeText(source.phone)) {
    target.phone = safeText(source.phone);
  }
  if (!safeText(target.phone2) && safeText(source.phone2)) {
    target.phone2 = safeText(source.phone2);
  }
  return target;
}

function normalizeParents(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => normalizeParent(p)).filter(hasParentData);
}

function buildMergedParents(current, body) {
  const existing = normalizeParents(current?.parents || []);
  const legacy = normalizeParent(current?.parent || {});
  const incomingParents = normalizeParents(body?.parents || []);
  const incomingActive = normalizeParent(body?.parent || {});

  const merged = existing.map((p) => ({ ...p }));

  if (hasParentData(legacy) && !merged.some((p) => sameParent(p, legacy))) {
    merged.push({ ...legacy });
  }

  for (const parent of incomingParents) {
    const hit = merged.find((p) => sameParent(p, parent));
    if (hit) {
      mergeParent(hit, parent);
    } else {
      merged.push({ ...parent });
    }
  }

  if (hasParentData(incomingActive)) {
    const hit = merged.find((p) => sameParent(p, incomingActive));
    if (hit) {
      mergeParent(hit, incomingActive);
    } else {
      merged.push({ ...incomingActive });
    }
  }

  return merged.filter(hasParentData);
}

function resolveActiveParent(current, body, mergedParents) {
  const incoming = normalizeParent(body?.parent || {});
  if (hasParentData(incoming)) {
    const hit = mergedParents.find((p) => sameParent(p, incoming));
    if (hit) return hit;
    return incoming;
  }

  const currentParent = normalizeParent(current?.parent || {});
  if (hasParentData(currentParent)) {
    const hit = mergedParents.find((p) => sameParent(p, currentParent));
    if (hit) return hit;
    return currentParent;
  }

  return normalizeParent({});
}

async function updateCustomer(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const b = req.body || {};

    const current = await Customer.findOne({ _id: id, owner }).exec();
    if (!current) {
      return res.status(404).json({ error: "Customer not found" });
    }

    // const parent = normalizeParent(b.parent);
    // const { merged, selected } = buildMergedChildren(current, b);
    // const primaryChild = resolvePrimaryChild(current, b, merged, selected);

    const mergedParents = buildMergedParents(current, b);
    const parent = resolveActiveParent(current, b, mergedParents);
    const { merged, selected } = buildMergedChildren(current, b);
    const primaryChild = resolvePrimaryChild(current, b, merged, selected);

    const update = {
      newsletter: !!b.newsletter,
      email: parent.email || safeText(current.email),
      emailLower: safeLower(parent.email || current.email),
      address: {
        street: safeText(b.address?.street),
        houseNo: safeText(b.address?.houseNo),
        zip: safeText(b.address?.zip),
        city: safeText(b.address?.city),
      },
      child: primaryChild,
      children: merged,
      parent,
      parents: mergedParents,
      notes: safeText(b.notes),
    };

    if (Array.isArray(b.bookings)) {
      update.bookings = b.bookings;
    }

    if (current.userId == null) {
      update.userId = await Customer.nextUserIdForOwner(owner);
    }

    const doc = await Customer.findOneAndUpdate(
      { _id: id, owner },
      { $set: update },
      { new: true },
    ).lean();

    return res.json(doc);
  } catch (err) {
    console.error("[customers:update] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { updateCustomer };

// // routes/customers/handlers/updateCustomer.js
// "use strict";

// const Customer = require("../../../models/Customer");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function normalizeGender(v) {
//   return ["weiblich", "männlich"].includes(v) ? v : "";
// }

// function normalizeSalutation(v) {
//   return ["Frau", "Herr"].includes(v) ? v : "";
// }

// function toDateOrNull(v) {
//   if (!v) return null;
//   const d = new Date(v);
//   return Number.isNaN(d.getTime()) ? null : d;
// }

// function uidOrEmpty(v) {
//   return safeText(v);
// }

// function normalizeChild(raw) {
//   const c = raw || {};
//   return {
//     uid: uidOrEmpty(c.uid),
//     firstName: safeText(c.firstName),
//     lastName: safeText(c.lastName),
//     gender: normalizeGender(safeText(c.gender)),
//     birthDate: toDateOrNull(c.birthDate),
//     club: safeText(c.club),
//   };
// }

// function normalizeChildren(list) {
//   if (!Array.isArray(list)) return null;
//   return list.map((c) => normalizeChild(c));
// }

// async function updateCustomer(req, res, requireOwner, requireId) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const b = req.body || {};

//     const current = await Customer.findOne({ _id: id, owner }).exec();
//     if (!current) return res.status(404).json({ error: "Customer not found" });

//     const update = {
//       newsletter: !!b.newsletter,
//       address: {
//         street: safeText(b.address?.street),
//         houseNo: safeText(b.address?.houseNo),
//         zip: safeText(b.address?.zip),
//         city: safeText(b.address?.city),
//       },
//       child: normalizeChild(b.child),
//       parent: {
//         salutation: normalizeSalutation(safeText(b.parent?.salutation)),
//         firstName: safeText(b.parent?.firstName),
//         lastName: safeText(b.parent?.lastName),
//         email: safeText(b.parent?.email),
//         phone: safeText(b.parent?.phone),
//         phone2: safeText(b.parent?.phone2),
//       },
//       notes: safeText(b.notes),
//     };

//     const nextChildren = normalizeChildren(b.children);
//     if (nextChildren) update.children = nextChildren;

//     if (Array.isArray(b.bookings)) update.bookings = b.bookings;

//     if (current.userId == null) {
//       update.userId = await Customer.nextUserIdForOwner(owner);
//     }

//     const doc = await Customer.findOneAndUpdate(
//       { _id: id, owner },
//       { $set: update },
//       { new: true },
//     ).lean();

//     return res.json(doc);
//   } catch (err) {
//     console.error("[customers:update] error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { updateCustomer };
