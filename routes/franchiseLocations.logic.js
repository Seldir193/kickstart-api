//routes\franchiseLocations.logic.js
"use strict";

const mongoose = require("mongoose");
const FranchiseLocation = require("../models/FranchiseLocation");

const { isValidObjectId, Types } = mongoose;

function cleanStr(v) {
  return String(v ?? "").trim();
}

function ok(res, data) {
  return res.json({ ok: true, ...data });
}

function bad(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

function idParam(req) {
  return cleanStr(req.params?.id);
}

function ensureId(res, id) {
  if (isValidObjectId(id)) return true;
  bad(res, 400, "Invalid id");
  return false;
}

function isObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function pickBody(req) {
  return isObj(req.body) ? req.body : {};
}

function requireNames(res, body) {
  const firstName = cleanStr(body.licenseeFirstName);
  const lastName = cleanStr(body.licenseeLastName);
  if (firstName && lastName) return { firstName, lastName };
  bad(res, 400, "licenseeFirstName and licenseeLastName are required");
  return null;
}

function requirePlace(res, body) {
  const country = cleanStr(body.country);
  const city = cleanStr(body.city);
  if (country && city) return { country, city };
  bad(res, 400, "country and city are required");
  return null;
}

function providerKey(req) {
  return cleanStr(req.providerId);
}

function ownerMatchFilter(req) {
  const pid = providerKey(req);
  const or = [];
  if (pid && isValidObjectId(pid)) or.push({ owner: new Types.ObjectId(pid) });
  if (pid) or.push({ owner: pid }, { ownerId: pid });
  return or.length ? { $or: or } : {};
}

function ownerCreateValue(req) {
  const pid = providerKey(req);
  return pid && isValidObjectId(pid) ? new Types.ObjectId(pid) : pid;
}

/**
 * ✅ FIX: Public list muss exakt das liefern, was die WP-Worldmap erwartet:
 * - published != false
 * - status === "approved"
 * - submittedAt === null (kein laufender Review/Draft)
 */
// function publicFilter() {
//   return {
//     //published: { $ne: false },
//     published: true,
//     status: "approved",
//     submittedAt: null,
//   };
// }

function publicFilter() {
  return {
    published: { $ne: false },
    status: "approved",
  };
}

// function mapDoc(d) {
//   const owner = cleanStr(d.owner);
//   const ownerId = cleanStr(d.ownerId || d.owner);
//   return {
//     id: cleanStr(d._id),
//     owner,
//     ownerId,
//     ownerName: null,
//     ownerEmail: null,
//     licenseeFirstName: d.licenseeFirstName || "",
//     licenseeLastName: d.licenseeLastName || "",
//     country: d.country,
//     city: d.city,
//     state: d.state || "",
//     address: d.address || "",
//     zip: d.zip || "",
//     website: d.website || "",
//     emailPublic: d.emailPublic || "",
//     phonePublic: d.phonePublic || "",
//     status: d.status,
//     published: d.published !== false,
//     rejectionReason: d.rejectionReason || "",
//     approvedAt: d.approvedAt || null,
//     liveUpdatedAt: d.liveUpdatedAt || null,
//     createdAt: d.createdAt,
//     updatedAt: d.updatedAt,
//   };
// }

function mapDoc(d) {
  const owner = cleanStr(d.owner);
  const ownerId = cleanStr(d.ownerId || d.owner);

  return {
    id: cleanStr(d._id),
    owner,
    ownerId,

    ownerName: d.ownerName ?? null,
    ownerEmail: d.ownerEmail ?? null,

    licenseeFirstName: d.licenseeFirstName || "",
    licenseeLastName: d.licenseeLastName || "",

    country: d.country,
    city: d.city,
    state: d.state || "",
    address: d.address || "",
    zip: d.zip || "",
    website: d.website || "",
    emailPublic: d.emailPublic || "",
    phonePublic: d.phonePublic || "",

    status: d.status,
    published: d.published === true,

    rejectionReason: d.rejectionReason || "",

    approvedAt: d.approvedAt || null,
    liveUpdatedAt: d.liveUpdatedAt || null,
    draftUpdatedAt: d.draftUpdatedAt || null,
    rejectedAt: d.rejectedAt || null,
    submittedAt: d.submittedAt || null,

    lastProviderEditAt: d.lastProviderEditAt || null,
    lastSuperEditAt: d.lastSuperEditAt || null,

    hasDraft: d.hasDraft === true,
    draft:
      d && typeof d.draft === "object" && !Array.isArray(d.draft)
        ? d.draft
        : {},

    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function snapshot(doc) {
  return JSON.stringify({
    licenseeFirstName: doc.licenseeFirstName || "",
    licenseeLastName: doc.licenseeLastName || "",
    country: doc.country,
    city: doc.city,
    state: doc.state || "",
    address: doc.address || "",
    zip: doc.zip || "",
    website: doc.website || "",
    emailPublic: doc.emailPublic || "",
    phonePublic: doc.phonePublic || "",
  });
}

function setIfPresent(doc, body, key) {
  if (!(key in body)) return;
  doc[key] = cleanStr(body[key]);
}

function applyPatch(doc, body) {
  setIfPresent(doc, body, "licenseeFirstName");
  setIfPresent(doc, body, "licenseeLastName");
  if ("country" in body) doc.country = cleanStr(body.country) || doc.country;
  if ("city" in body) doc.city = cleanStr(body.city) || doc.city;
  setIfPresent(doc, body, "state");
  setIfPresent(doc, body, "address");
  setIfPresent(doc, body, "zip");
  setIfPresent(doc, body, "website");
  setIfPresent(doc, body, "emailPublic");
  setIfPresent(doc, body, "phonePublic");
}

function ensureRequiredAfter(res, doc) {
  const fn = cleanStr(doc.licenseeFirstName);
  const ln = cleanStr(doc.licenseeLastName);
  if (!fn || !ln)
    return bad(res, 400, "licenseeFirstName and licenseeLastName are required");
  if (!cleanStr(doc.country) || !cleanStr(doc.city))
    return bad(res, 400, "country and city are required");
  return true;
}

function applyPendingIfNeeded(doc, before) {
  const after = snapshot(doc);
  if (before === after) return;
  if (doc.status !== "approved") return;
  doc.status = "pending";
  doc.rejectionReason = "";
  doc.moderatedAt = null;
  doc.published = false;
}

function buildCreatePayload(owner, body, names, place) {
  return {
    owner,
    licenseeFirstName: names.firstName,
    licenseeLastName: names.lastName,
    country: place.country,
    city: place.city,
    state: cleanStr(body.state),
    address: cleanStr(body.address),
    zip: cleanStr(body.zip),
    website: cleanStr(body.website),
    emailPublic: cleanStr(body.emailPublic),
    phonePublic: cleanStr(body.phonePublic),
    status: "pending",
    published: false,
    rejectionReason: "",
    moderatedAt: null,
  };
}

async function getPublicList(_req, res) {
  try {
    const items = await FranchiseLocation.find(publicFilter())
      .sort({ country: 1, city: 1 })
      .lean();
    return ok(res, { items: items.map(mapDoc) });
  } catch {
    return bad(res, 500, "Server error");
  }
}

// async function getMine(req, res) {
//   try {
//     const q = ownerMatchFilter(req);
//     const items = await FranchiseLocation.find(q)
//       .sort({ createdAt: -1 })
//       .lean();
//     return ok(res, { items: items.map(mapDoc) });
//   } catch {
//     return bad(res, 500, "Server error");
//   }
// }
async function getMine(req, res) {
  try {
    const q = ownerMatchFilter(req);
    const view = cleanStr(req.query?.view).toLowerCase();

    if (view === "mine_pending") q.status = "pending";
    if (view === "mine_approved") q.status = "approved";
    if (view === "mine_rejected") q.status = "rejected";

    const items = await FranchiseLocation.find(q)
      .sort({ createdAt: -1 })
      .lean();

    return ok(res, { items: items.map(mapDoc) });
  } catch {
    return bad(res, 500, "Server error");
  }
}

async function createMine(req, res) {
  try {
    const owner = ownerCreateValue(req);
    const body = pickBody(req);
    const names = requireNames(res, body);
    const place = requirePlace(res, body);
    if (!names || !place) return;

    const doc = await FranchiseLocation.create(
      buildCreatePayload(owner, body, names, place),
    );

    return res.status(201).json({ ok: true, item: mapDoc(doc) });
  } catch (e) {
    if (e?.code === 11000)
      return bad(res, 409, "Location already exists (duplicate).");
    return bad(res, 400, String(e?.message || e));
  }
}

async function patchMine(req, res) {
  const id = idParam(req);
  if (!ensureId(res, id)) return;

  try {
    const q = { _id: id, ...ownerMatchFilter(req) };
    const doc = await FranchiseLocation.findOne(q);
    if (!doc) return bad(res, 404, "Not found");

    const body = pickBody(req);
    const before = snapshot(doc);
    applyPatch(doc, body);
    if (!ensureRequiredAfter(res, doc)) return;
    applyPendingIfNeeded(doc, before);

    await doc.save();
    return ok(res, { item: mapDoc(doc) });
  } catch (e) {
    if (e?.code === 11000)
      return bad(res, 409, "Location already exists (duplicate).");
    return bad(res, 400, String(e?.message || e));
  }
}

async function deleteMine(req, res) {
  const id = idParam(req);
  if (!ensureId(res, id)) return;

  try {
    const q = { _id: id, ...ownerMatchFilter(req) };
    const r = await FranchiseLocation.deleteOne(q);
    if (r.deletedCount === 0) return bad(res, 404, "Not found");
    return ok(res, { deleted: 1 });
  } catch {
    return bad(res, 500, "Server error");
  }
}

async function putAlias(req, res) {
  return patchMine(req, res);
}

module.exports = {
  getPublicList,
  getMine,
  createMine,
  patchMine,
  deleteMine,
  putAlias,
};

// // routes/franchiseLocations.logic.js
// "use strict";

// const mongoose = require("mongoose");
// const FranchiseLocation = require("../models/FranchiseLocation");

// const { isValidObjectId, Types } = mongoose;

// function cleanStr(v) {
//   return String(v ?? "").trim();
// }

// function ok(res, data) {
//   return res.json({ ok: true, ...data });
// }

// function bad(res, status, error) {
//   return res.status(status).json({ ok: false, error });
// }

// function idParam(req) {
//   return cleanStr(req.params?.id);
// }

// function ensureId(res, id) {
//   if (isValidObjectId(id)) return true;
//   bad(res, 400, "Invalid id");
//   return false;
// }

// function toOwnerId(req) {
//   return new Types.ObjectId(cleanStr(req.providerId));
// }

// function isObj(v) {
//   return Boolean(v) && typeof v === "object" && !Array.isArray(v);
// }

// function pickBody(req) {
//   return isObj(req.body) ? req.body : {};
// }

// function requireNames(res, body) {
//   const firstName = cleanStr(body.licenseeFirstName);
//   const lastName = cleanStr(body.licenseeLastName);
//   if (firstName && lastName) return { firstName, lastName };
//   bad(res, 400, "licenseeFirstName and licenseeLastName are required");
//   return null;
// }

// function requirePlace(res, body) {
//   const country = cleanStr(body.country);
//   const city = cleanStr(body.city);
//   if (country && city) return { country, city };
//   bad(res, 400, "country and city are required");
//   return null;
// }

// function publicFilter() {
//   return {
//     published: { $ne: false },
//     $or: [{ status: "approved" }, { approvedAt: { $ne: null } }],
//   };
// }

// function mapDoc(d) {
//   const owner = cleanStr(d.owner);
//   const ownerId = cleanStr(d.ownerId || d.owner);
//   return {
//     id: cleanStr(d._id),
//     owner,
//     ownerId,
//     ownerName: null,
//     ownerEmail: null,
//     licenseeFirstName: d.licenseeFirstName || "",
//     licenseeLastName: d.licenseeLastName || "",
//     country: d.country,
//     city: d.city,
//     state: d.state || "",
//     address: d.address || "",
//     zip: d.zip || "",
//     website: d.website || "",
//     emailPublic: d.emailPublic || "",
//     phonePublic: d.phonePublic || "",
//     status: d.status,
//     published: d.published !== false,
//     rejectionReason: d.rejectionReason || "",
//     approvedAt: d.approvedAt || null,
//     liveUpdatedAt: d.liveUpdatedAt || null,
//     createdAt: d.createdAt,
//     updatedAt: d.updatedAt,
//   };
// }

// function snapshot(doc) {
//   return JSON.stringify({
//     licenseeFirstName: doc.licenseeFirstName || "",
//     licenseeLastName: doc.licenseeLastName || "",
//     country: doc.country,
//     city: doc.city,
//     state: doc.state || "",
//     address: doc.address || "",
//     zip: doc.zip || "",
//     website: doc.website || "",
//     emailPublic: doc.emailPublic || "",
//     phonePublic: doc.phonePublic || "",
//   });
// }

// function setIfPresent(doc, body, key) {
//   if (!(key in body)) return;
//   doc[key] = cleanStr(body[key]);
// }

// function applyPatch(doc, body) {
//   setIfPresent(doc, body, "licenseeFirstName");
//   setIfPresent(doc, body, "licenseeLastName");
//   if ("country" in body) doc.country = cleanStr(body.country) || doc.country;
//   if ("city" in body) doc.city = cleanStr(body.city) || doc.city;
//   setIfPresent(doc, body, "state");
//   setIfPresent(doc, body, "address");
//   setIfPresent(doc, body, "zip");
//   setIfPresent(doc, body, "website");
//   setIfPresent(doc, body, "emailPublic");
//   setIfPresent(doc, body, "phonePublic");
// }

// function ensureRequiredAfter(res, doc) {
//   const fn = cleanStr(doc.licenseeFirstName);
//   const ln = cleanStr(doc.licenseeLastName);
//   if (!fn || !ln)
//     return bad(res, 400, "licenseeFirstName and licenseeLastName are required");
//   if (!cleanStr(doc.country) || !cleanStr(doc.city))
//     return bad(res, 400, "country and city are required");
//   return true;
// }

// function applyPendingIfNeeded(doc, before) {
//   const after = snapshot(doc);
//   if (before === after) return;
//   if (doc.status !== "approved") return;
//   doc.status = "pending";
//   doc.rejectionReason = "";
//   doc.moderatedAt = null;
//   doc.published = false;
// }

// function buildCreatePayload(owner, body, names, place) {
//   return {
//     owner,
//     licenseeFirstName: names.firstName,
//     licenseeLastName: names.lastName,
//     country: place.country,
//     city: place.city,
//     state: cleanStr(body.state),
//     address: cleanStr(body.address),
//     zip: cleanStr(body.zip),
//     website: cleanStr(body.website),
//     emailPublic: cleanStr(body.emailPublic),
//     phonePublic: cleanStr(body.phonePublic),
//     status: "pending",
//     published: false,
//     rejectionReason: "",
//     moderatedAt: null,
//   };
// }

// async function getPublicList(_req, res) {
//   try {
//     const items = await FranchiseLocation.find(publicFilter())
//       .sort({ country: 1, city: 1 })
//       .lean();
//     return ok(res, { items: items.map(mapDoc) });
//   } catch {
//     return bad(res, 500, "Server error");
//   }
// }

// async function getMine(req, res) {
//   try {
//     const owner = toOwnerId(req);
//     const items = await FranchiseLocation.find({ owner })
//       .sort({ createdAt: -1 })
//       .lean();
//     return ok(res, { items: items.map(mapDoc) });
//   } catch {
//     return bad(res, 500, "Server error");
//   }
// }

// async function createMine(req, res) {
//   try {
//     const owner = toOwnerId(req);
//     const body = pickBody(req);
//     const names = requireNames(res, body);
//     const place = requirePlace(res, body);
//     if (!names || !place) return;
//     const doc = await FranchiseLocation.create(
//       buildCreatePayload(owner, body, names, place),
//     );
//     return res.status(201).json({ ok: true, item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000)
//       return bad(res, 409, "Location already exists (duplicate).");
//     return bad(res, 400, String(e?.message || e));
//   }
// }

// async function patchMine(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   try {
//     const owner = toOwnerId(req);
//     const doc = await FranchiseLocation.findOne({ _id: id, owner });
//     if (!doc) return bad(res, 404, "Not found");
//     const body = pickBody(req);
//     const before = snapshot(doc);
//     applyPatch(doc, body);
//     if (!ensureRequiredAfter(res, doc)) return;
//     applyPendingIfNeeded(doc, before);
//     await doc.save();
//     return ok(res, { item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000)
//       return bad(res, 409, "Location already exists (duplicate).");
//     return bad(res, 400, String(e?.message || e));
//   }
// }

// async function deleteMine(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   try {
//     const owner = toOwnerId(req);
//     const r = await FranchiseLocation.deleteOne({ _id: id, owner });
//     if (r.deletedCount === 0) return bad(res, 404, "Not found");
//     return ok(res, { deleted: 1 });
//   } catch {
//     return bad(res, 500, "Server error");
//   }
// }

// async function putAlias(req, res) {
//   return patchMine(req, res);
// }

// module.exports = {
//   getPublicList,
//   getMine,
//   createMine,
//   patchMine,
//   deleteMine,
//   putAlias,
// };

// // routes/franchiseLocations.logic.js
// "use strict";

// const mongoose = require("mongoose");
// const FranchiseLocation = require("../models/FranchiseLocation");

// const { isValidObjectId, Types } = mongoose;

// function cleanStr(v) {
//   return String(v ?? "").trim();
// }

// function ok(res, data) {
//   return res.json({ ok: true, ...data });
// }

// function bad(res, status, error) {
//   return res.status(status).json({ ok: false, error });
// }

// function idParam(req) {
//   return cleanStr(req.params?.id);
// }

// function ensureId(res, id) {
//   if (isValidObjectId(id)) return true;
//   bad(res, 400, "Invalid id");
//   return false;
// }

// function toOwnerId(req) {
//   return new Types.ObjectId(cleanStr(req.providerId));
// }

// function isObj(v) {
//   return Boolean(v) && typeof v === "object" && !Array.isArray(v);
// }

// function pickBody(req) {
//   return isObj(req.body) ? req.body : {};
// }

// function requireNames(res, body) {
//   const firstName = cleanStr(body.licenseeFirstName);
//   const lastName = cleanStr(body.licenseeLastName);
//   if (firstName && lastName) return { firstName, lastName };
//   bad(res, 400, "licenseeFirstName and licenseeLastName are required");
//   return null;
// }

// function requirePlace(res, body) {
//   const country = cleanStr(body.country);
//   const city = cleanStr(body.city);
//   if (country && city) return { country, city };
//   bad(res, 400, "country and city are required");
//   return null;
// }

// function publicFilter() {
//   return {
//     published: { $ne: false },
//     $or: [
//       { status: "approved" },
//       { approvedAt: { $type: "date" } },
//       { approvedAt: { $ne: null } },
//       { status: { $exists: false } },
//       { status: null },
//       { status: "" },
//     ],
//   };
// }

// function mapDoc(d) {
//   return {
//     id: cleanStr(d._id),
//     owner: cleanStr(d.owner),
//     ownerId: cleanStr(d.owner),
//     ownerName: null,
//     ownerEmail: null,
//     licenseeFirstName: d.licenseeFirstName || "",
//     licenseeLastName: d.licenseeLastName || "",
//     country: d.country,
//     city: d.city,
//     state: d.state || "",
//     address: d.address || "",
//     zip: d.zip || "",
//     website: d.website || "",
//     emailPublic: d.emailPublic || "",
//     phonePublic: d.phonePublic || "",
//     status: d.status,
//     published: d.published !== false,
//     rejectionReason: d.rejectionReason || "",
//     approvedAt: d.approvedAt || null,
//     liveUpdatedAt: d.liveUpdatedAt || null,
//     createdAt: d.createdAt,
//     updatedAt: d.updatedAt,
//   };
// }

// function snapshot(doc) {
//   return JSON.stringify({
//     licenseeFirstName: doc.licenseeFirstName || "",
//     licenseeLastName: doc.licenseeLastName || "",
//     country: doc.country,
//     city: doc.city,
//     state: doc.state || "",
//     address: doc.address || "",
//     zip: doc.zip || "",
//     website: doc.website || "",
//     emailPublic: doc.emailPublic || "",
//     phonePublic: doc.phonePublic || "",
//   });
// }

// function setIfPresent(doc, body, key) {
//   if (!(key in body)) return;
//   doc[key] = cleanStr(body[key]);
// }

// function applyPatch(doc, body) {
//   setIfPresent(doc, body, "licenseeFirstName");
//   setIfPresent(doc, body, "licenseeLastName");
//   if ("country" in body) doc.country = cleanStr(body.country) || doc.country;
//   if ("city" in body) doc.city = cleanStr(body.city) || doc.city;
//   setIfPresent(doc, body, "state");
//   setIfPresent(doc, body, "address");
//   setIfPresent(doc, body, "zip");
//   setIfPresent(doc, body, "website");
//   setIfPresent(doc, body, "emailPublic");
//   setIfPresent(doc, body, "phonePublic");
// }

// function ensureRequiredAfter(res, doc) {
//   const fn = cleanStr(doc.licenseeFirstName);
//   const ln = cleanStr(doc.licenseeLastName);
//   if (!fn || !ln)
//     return bad(res, 400, "licenseeFirstName and licenseeLastName are required");
//   if (!cleanStr(doc.country) || !cleanStr(doc.city))
//     return bad(res, 400, "country and city are required");
//   return true;
// }

// function applyPendingIfNeeded(doc, before) {
//   const after = snapshot(doc);
//   if (before === after) return;
//   if (doc.status !== "approved") return;
//   doc.status = "pending";
//   doc.rejectionReason = "";
//   doc.moderatedAt = null;
// }

// function buildCreatePayload(owner, body, names, place) {
//   return {
//     owner,
//     licenseeFirstName: names.firstName,
//     licenseeLastName: names.lastName,
//     country: place.country,
//     city: place.city,
//     state: cleanStr(body.state),
//     address: cleanStr(body.address),
//     zip: cleanStr(body.zip),
//     website: cleanStr(body.website),
//     emailPublic: cleanStr(body.emailPublic),
//     phonePublic: cleanStr(body.phonePublic),
//     status: "pending",
//     published: true,
//     rejectionReason: "",
//     moderatedAt: null,
//   };
// }

// async function getPublicList(_req, res) {
//   try {
//     const items = await FranchiseLocation.find(publicFilter())
//       .sort({ country: 1, city: 1 })
//       .lean();
//     return ok(res, { items: items.map(mapDoc) });
//   } catch {
//     return bad(res, 500, "Server error");
//   }
// }

// async function getMine(req, res) {
//   try {
//     const owner = toOwnerId(req);
//     const items = await FranchiseLocation.find({ owner })
//       .sort({ createdAt: -1 })
//       .lean();
//     return ok(res, { items: items.map(mapDoc) });
//   } catch {
//     return bad(res, 500, "Server error");
//   }
// }

// async function createMine(req, res) {
//   try {
//     const owner = toOwnerId(req);
//     const body = pickBody(req);
//     const names = requireNames(res, body);
//     const place = requirePlace(res, body);
//     if (!names || !place) return;
//     const doc = await FranchiseLocation.create(
//       buildCreatePayload(owner, body, names, place),
//     );
//     return res.status(201).json({ ok: true, item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000)
//       return bad(res, 409, "Location already exists (duplicate).");
//     return bad(res, 400, String(e?.message || e));
//   }
// }

// async function patchMine(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   try {
//     const owner = toOwnerId(req);
//     const doc = await FranchiseLocation.findOne({ _id: id, owner });
//     if (!doc) return bad(res, 404, "Not found");
//     const body = pickBody(req);
//     const before = snapshot(doc);
//     applyPatch(doc, body);
//     if (!ensureRequiredAfter(res, doc)) return;
//     applyPendingIfNeeded(doc, before);
//     await doc.save();
//     return ok(res, { item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000)
//       return bad(res, 409, "Location already exists (duplicate).");
//     return bad(res, 400, String(e?.message || e));
//   }
// }

// async function deleteMine(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   try {
//     const owner = toOwnerId(req);
//     const r = await FranchiseLocation.deleteOne({ _id: id, owner });
//     if (r.deletedCount === 0) return bad(res, 404, "Not found");
//     return ok(res, { deleted: 1 });
//   } catch {
//     return bad(res, 500, "Server error");
//   }
// }

// async function putAlias(req, res) {
//   return patchMine(req, res);
// }

// module.exports = {
//   getPublicList,
//   getMine,
//   createMine,
//   patchMine,
//   deleteMine,
//   putAlias,
// };

// // routes/franchiseLocations.logic.js
// "use strict";

// const mongoose = require("mongoose");
// const FranchiseLocation = require("../models/FranchiseLocation");

// const { isValidObjectId, Types } = mongoose;

// function cleanStr(v) {
//   return String(v ?? "").trim();
// }

// function idParam(req) {
//   return cleanStr(req.params?.id);
// }

// function bad(res, status, error) {
//   return res.status(status).json({ ok: false, error });
// }

// function ok(res, data) {
//   return res.json({ ok: true, ...data });
// }

// function toOwnerId(req) {
//   return new Types.ObjectId(cleanStr(req.providerId));
// }

// function ensureId(res, id) {
//   if (isValidObjectId(id)) return true;
//   bad(res, 400, "Invalid id");
//   return false;
// }

// function publicFilter() {
//   return {
//     published: { $ne: false },
//     $or: [
//       { status: "approved" },
//       { approvedAt: { $type: "date" } },
//       { approvedAt: { $ne: null } },
//       { status: { $exists: false } },
//       { status: null },
//       { status: "" },
//     ],
//   };
// }

// function mapDoc(d) {
//   return {
//     id: cleanStr(d._id),
//     owner: cleanStr(d.owner),
//     ownerId: cleanStr(d.owner),
//     ownerName: null,
//     ownerEmail: null,
//     licenseeFirstName: d.licenseeFirstName || "",
//     licenseeLastName: d.licenseeLastName || "",
//     country: d.country,
//     city: d.city,
//     state: d.state || "",
//     address: d.address || "",
//     zip: d.zip || "",
//     website: d.website || "",
//     emailPublic: d.emailPublic || "",
//     phonePublic: d.phonePublic || "",
//     status: d.status,
//     published: d.published !== false,
//     rejectionReason: d.rejectionReason || "",
//     approvedAt: d.approvedAt || null,
//     liveUpdatedAt: d.liveUpdatedAt || null,
//     createdAt: d.createdAt,
//     updatedAt: d.updatedAt,
//   };
// }

// function pickBody(req) {
//   return req.body && typeof req.body === "object" ? req.body : {};
// }

// function requireNames(res, b) {
//   const fn = cleanStr(b.licenseeFirstName);
//   const ln = cleanStr(b.licenseeLastName);
//   if (fn && ln) return { fn, ln };
//   bad(res, 400, "licenseeFirstName and licenseeLastName are required");
//   return null;
// }

// function requirePlace(res, b) {
//   const country = cleanStr(b.country);
//   const city = cleanStr(b.city);
//   if (country && city) return { country, city };
//   bad(res, 400, "country and city are required");
//   return null;
// }

// function applyIfPresent(doc, b, key) {
//   if (!(key in b)) return;
//   doc[key] = cleanStr(b[key]);
// }

// function snapshot(doc) {
//   return JSON.stringify({
//     licenseeFirstName: doc.licenseeFirstName || "",
//     licenseeLastName: doc.licenseeLastName || "",
//     country: doc.country,
//     city: doc.city,
//     state: doc.state || "",
//     address: doc.address || "",
//     zip: doc.zip || "",
//     website: doc.website || "",
//     emailPublic: doc.emailPublic || "",
//     phonePublic: doc.phonePublic || "",
//   });
// }

// async function getPublicList(_req, res) {
//   try {
//     const items = await FranchiseLocation.find(publicFilter())
//       .sort({ country: 1, city: 1 })
//       .lean();
//     return ok(res, { items: items.map(mapDoc) });
//   } catch (e) {
//     return bad(res, 500, "Server error");
//   }
// }

// async function getMine(req, res) {
//   try {
//     const owner = toOwnerId(req);
//     const items = await FranchiseLocation.find({ owner })
//       .sort({ createdAt: -1 })
//       .lean();
//     return ok(res, { items: items.map(mapDoc) });
//   } catch (e) {
//     return bad(res, 500, "Server error");
//   }
// }

// async function createMine(req, res) {
//   try {
//     const owner = toOwnerId(req);
//     const b = pickBody(req);
//     const names = requireNames(res, b);
//     const place = requirePlace(res, b);
//     if (!names || !place) return;
//     const doc = await FranchiseLocation.create(
//       buildCreatePayload(owner, b, names, place),
//     );
//     return res.status(201).json({ ok: true, item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000)
//       return bad(res, 409, "Location already exists (duplicate).");
//     return bad(res, 400, String(e?.message || e));
//   }
// }

// function buildCreatePayload(owner, b, names, place) {
//   return {
//     owner,
//     licenseeFirstName: names.fn,
//     licenseeLastName: names.ln,
//     country: place.country,
//     city: place.city,
//     state: cleanStr(b.state),
//     address: cleanStr(b.address),
//     zip: cleanStr(b.zip),
//     website: cleanStr(b.website),
//     emailPublic: cleanStr(b.emailPublic),
//     phonePublic: cleanStr(b.phonePublic),
//     status: "pending",
//     published: true,
//     rejectionReason: "",
//     moderatedAt: null,
//   };
// }

// async function patchMine(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   try {
//     const owner = toOwnerId(req);
//     const doc = await FranchiseLocation.findOne({ _id: id, owner });
//     if (!doc) return bad(res, 404, "Not found");
//     const b = pickBody(req);
//     const before = snapshot(doc);
//     applyPatch(doc, b);
//     if (!ensureRequiredAfter(res, doc)) return;
//     applyPendingIfNeeded(doc, before);
//     await doc.save();
//     return ok(res, { item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000)
//       return bad(res, 409, "Location already exists (duplicate).");
//     return bad(res, 400, String(e?.message || e));
//   }
// }

// function applyPatch(doc, b) {
//   applyIfPresent(doc, b, "licenseeFirstName");
//   applyIfPresent(doc, b, "licenseeLastName");
//   if ("country" in b) doc.country = cleanStr(b.country) || doc.country;
//   if ("city" in b) doc.city = cleanStr(b.city) || doc.city;
//   applyIfPresent(doc, b, "state");
//   applyIfPresent(doc, b, "address");
//   applyIfPresent(doc, b, "zip");
//   applyIfPresent(doc, b, "website");
//   applyIfPresent(doc, b, "emailPublic");
//   applyIfPresent(doc, b, "phonePublic");
// }

// function ensureRequiredAfter(res, doc) {
//   if (!cleanStr(doc.licenseeFirstName) || !cleanStr(doc.licenseeLastName)) {
//     bad(res, 400, "licenseeFirstName and licenseeLastName are required");
//     return false;
//   }
//   if (!cleanStr(doc.country) || !cleanStr(doc.city)) {
//     bad(res, 400, "country and city are required");
//     return false;
//   }
//   return true;
// }

// function applyPendingIfNeeded(doc, before) {
//   const after = snapshot(doc);
//   const changed = before !== after;
//   if (!changed || doc.status !== "approved") return;
//   doc.status = "pending";
//   doc.rejectionReason = "";
//   doc.moderatedAt = null;
// }

// async function deleteMine(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   try {
//     const owner = toOwnerId(req);
//     const r = await FranchiseLocation.deleteOne({ _id: id, owner });
//     if (r.deletedCount === 0) return bad(res, 404, "Not found");
//     return ok(res, { deleted: 1 });
//   } catch (e) {
//     return bad(res, 500, "Server error");
//   }
// }

// async function putAlias(req, res) {
//   req.method = "PATCH";
//   return req.app._router.handle(req, res);
// }

// module.exports = {
//   getPublicList,
//   getMine,
//   createMine,
//   patchMine,
//   deleteMine,
//   putAlias,
// };
