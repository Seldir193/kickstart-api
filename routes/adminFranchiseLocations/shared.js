// routes/adminFranchiseLocations/shared.js
"use strict";

const mongoose = require("mongoose");
const AdminUser = require("../../models/AdminUser");
const FranchiseLocation = require("../../models/FranchiseLocation");

const { isValidObjectId, Types } = mongoose;

const draftFields = [
  "licenseeFirstName",
  "licenseeLastName",
  "country",
  "city",
  "state",
  "address",
  "zip",
  "website",
  "emailPublic",
  "phonePublic",
];

const liveRegexFields = [
  "country",
  "city",
  "state",
  "address",
  "zip",
  "licenseeFirstName",
  "licenseeLastName",
];

function cleanStr(v) {
  return String(v ?? "").trim();
}

function toLower(v) {
  return cleanStr(v).toLowerCase();
}

function isObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function now() {
  return new Date();
}

function ms(v) {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function bool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function normStatus(v) {
  const s = toLower(v);
  return s === "pending" || s === "approved" || s === "rejected" ? s : "";
}

function isSuper(req) {
  return req.isSuperAdmin === true || cleanStr(req.role) === "super";
}

function providerId(req) {
  return cleanStr(req.providerId);
}

function toObjId(id) {
  if (!isValidObjectId(id)) return null;
  return new Types.ObjectId(id);
}

function idParam(req) {
  return cleanStr(req.params.id);
}

function ensureId(res, id) {
  if (isValidObjectId(id)) return true;
  return bad(res, 400, "Invalid id");
}

function ensureAuth(res, superUser, myOwnerId) {
  if (superUser || myOwnerId) return true;
  return bad(res, 401, "Unauthorized");
}

function ok(res, data) {
  return res.json({ ok: true, ...data });
}

function bad(res, status, error) {
  res.status(status).json({ ok: false, error });
  return false;
}

function safeDraft(d) {
  return isObj(d) ? d : {};
}

function mergedForProvider(doc) {
  return { ...doc, ...safeDraft(doc?.draft) };
}

function hasDraftChanges(doc) {
  const d = ms(doc?.draftUpdatedAt);
  const l = ms(doc?.liveUpdatedAt);
  return Boolean(d && (!l || d > l));
}

function editedAfterReject(doc) {
  const d = ms(doc?.draftUpdatedAt);
  const r = ms(doc?.rejectedAt);
  return Boolean(d && r && d > r);
}

function canTogglePublished(doc) {
  return doc?.status === "approved" && doc?.submittedAt == null;
}

function pickDraftPatch(body) {
  const src = isObj(body) ? body : {};
  const draft = {};
  for (const k of draftFields) if (k in src) draft[k] = cleanStr(src[k]);
  return draft;
}

function mergeDraft(prevDraft, patch) {
  return { ...safeDraft(prevDraft), ...patch };
}

function limitOf(req) {
  return Math.min(Number(req.query.limit) || 20, 50);
}

function pageOf(req) {
  return Math.max(Number(req.query.page) || 1, 1);
}

function viewOf(req) {
  return cleanStr(req.query.view);
}

function searchOf(req) {
  return cleanStr(req.query.search);
}

function baseFilters(req) {
  const s = searchOf(req);
  if (!s) return {};
  return { $or: buildSearchOr(s) };
}

function buildSearchOr(s) {
  return liveRegexFields.map((field) => regexField(field, s));
}

function regexField(field, s) {
  return { [field]: { $regex: s, $options: "i" } };
}

function ownerOr(myOwnerId, pid) {
  const p = cleanStr(pid);
  const or = [];
  if (myOwnerId) or.push({ owner: myOwnerId }, { ownerId: String(myOwnerId) });
  if (p) or.push({ owner: p }, { ownerId: p });
  return or.length ? { $or: or } : {};
}

function notOwnerNor(myOwnerId, pid) {
  const or = ownerOr(myOwnerId, pid).$or || [];
  return or.length ? { $nor: or } : {};
}

function mineViewQuery(v, myOwnerId, pid, common) {
  if (v === "mine_approved") return mineApproved(myOwnerId, pid, common);
  if (v === "mine_pending") return minePending(myOwnerId, pid, common);
  if (v === "mine_rejected") return mineRejected(myOwnerId, pid, common);
  throw Object.assign(new Error("Invalid view"), { statusCode: 400 });
}

// function mineApproved(myOwnerId, pid, common) {
//   return {
//     ...common,
//     ...ownerOr(myOwnerId, pid),
//     status: "approved",
//     submittedAt: null,
//   };
// }

function mineApproved(myOwnerId, pid, common) {
  return {
    $and: [
      common,
      ownerOr(myOwnerId, pid),
      { status: "approved", submittedAt: null },
    ],
  };
}

// function minePending(myOwnerId, pid, common) {
//   return { ...common, ...ownerOr(myOwnerId, pid), $or: minePendingOr() };
// }

function minePending(myOwnerId, pid, common) {
  return {
    $and: [common, ownerOr(myOwnerId, pid), { $or: minePendingOr() }],
  };
}

function minePendingOr() {
  return [
    { status: "pending" },
    { status: "approved", submittedAt: { $ne: null } },
  ];
}

// function mineRejected(myOwnerId, pid, common) {
//   return { ...common, ...ownerOr(myOwnerId, pid), status: "rejected" };
// }

function mineRejected(myOwnerId, pid, common) {
  return {
    $and: [common, ownerOr(myOwnerId, pid), { status: "rejected" }],
  };
}

function providerViewQuery(v, myOwnerId, pid, common) {
  const base = notOwnerNor(myOwnerId, pid);
  if (v === "provider_approved") return providerApproved(common, base);
  if (v === "provider_pending") return providerPending(common, base);
  if (v === "provider_rejected") return providerRejected(common, base);
  throw Object.assign(new Error("Invalid view"), { statusCode: 400 });
}

// function providerApproved(common, base) {
//   return { ...common, ...base, status: "approved" };
// }

// function providerPending(common, base) {
//   return { ...common, ...base, $or: minePendingOr() };
// }

// function providerRejected(common, base) {
//   return { ...common, ...base, status: "rejected" };
// }

function providerApproved(common, base) {
  return {
    $and: [common, base, { status: "approved" }],
  };
}

function providerPending(common, base) {
  return {
    $and: [common, base, { $or: minePendingOr() }],
  };
}

function providerRejected(common, base) {
  return {
    $and: [common, base, { status: "rejected" }],
  };
}

function viewQuery(view, myOwnerId, pid, common, superUser) {
  const v = cleanStr(view);
  const isSuperUser = superUser === true;

  if (!v) return isSuperUser ? null : { ...common, ...ownerOr(myOwnerId, pid) };

  if (v.startsWith("mine_")) return mineViewQuery(v, myOwnerId, pid, common);

  if (!isSuperUser) {
    throw Object.assign(new Error("Invalid view"), { statusCode: 400 });
  }

  if (v.startsWith("provider_"))
    return providerViewQuery(v, myOwnerId, pid, common);

  throw Object.assign(new Error("Invalid view"), { statusCode: 400 });
}

async function pagedFind(q, limit, page) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    fetchItems(q, limit, skip),
    countItems(q),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) || 1, limit };
}

function fetchItems(q, limit, skip) {
  return FranchiseLocation.find(q)
    .sort({ updatedAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

function countItems(q) {
  return FranchiseLocation.countDocuments(q);
}

function ownerIds(items) {
  const ids = items.map((it) => cleanStr(it?.owner)).filter(Boolean);
  return Array.from(new Set(ids));
}

async function enrichOwners(items) {
  if (!Array.isArray(items) || !items.length) return items;
  const ids = ownerIds(items);
  if (!ids.length) return items;
  const map = await loadOwnerMap(ids);
  return items.map((it) => ({ ...it, ownerUser: buildOwnerUser(it, map) }));
}

async function loadOwnerMap(ids) {
  const users = await AdminUser.find({ _id: { $in: ids } })
    .select("_id fullName email firstName lastName")
    .lean();
  return new Map(users.map((u) => [cleanStr(u._id), u]));
}

function buildOwnerUser(it, map) {
  const oid = cleanStr(it?.owner);
  if (!oid) return null;
  const u = map.get(oid);
  return u ? ownerUserFrom(u) : emptyOwnerUser(oid);
}

function ownerUserFrom(u) {
  return {
    id: cleanStr(u._id),
    fullName: u.fullName || "",
    email: u.email || "",
    firstName: u.firstName || "",
    lastName: u.lastName || "",
  };
}

function emptyOwnerUser(id) {
  return { id, fullName: "", email: "", firstName: "", lastName: "" };
}

function mapDoc(d) {
  const ownerId = cleanStr(isObj(d.owner) ? d.owner._id : d.owner);
  return {
    ...mapBase(d, ownerId),
    ...mapTimes(d),
    ...mapDraft(d),
  };
}

function mapBase(d, ownerId) {
  const names = locationNames(d);
  return {
    id: cleanStr(d._id),
    owner: ownerId,
    ownerId,
    ownerName: names.ownerName,
    ownerEmail: isObj(d.owner) ? d.owner.email || null : null,
    ownerUser: d.ownerUser || null,
    licenseeFirstName: names.firstName,
    licenseeLastName: names.lastName,
    ...mapAddress(d),
    status: d.status,
    // published: d.published !== false,
    published: d.published === true,
    rejectionReason: d.rejectionReason || "",
  };
}

function mapAddress(d) {
  return {
    country: d.country,
    city: d.city,
    state: d.state || "",
    address: d.address || "",
    zip: d.zip || "",
    website: d.website || "",
    emailPublic: d.emailPublic || "",
    phonePublic: d.phonePublic || "",
  };
}

function mapTimes(d) {
  return {
    approvedAt: d.approvedAt || null,
    liveUpdatedAt: d.liveUpdatedAt || null,
    draftUpdatedAt: d.draftUpdatedAt || null,
    rejectedAt: d.rejectedAt || null,
    submittedAt: d.submittedAt || null,
    lastProviderEditAt: d.lastProviderEditAt || null,
    lastSuperEditAt: d.lastSuperEditAt || null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function mapDraft(d) {
  return { hasDraft: d.hasDraft === true, draft: safeDraft(d.draft) };
}

function locationNames(d) {
  const firstName = d.licenseeFirstName || "";
  const lastName = d.licenseeLastName || "";
  const ownerName = `${firstName} ${lastName}`.trim() || null;
  return { firstName, lastName, ownerName };
}

async function loadDocUpdate(q, set) {
  const updated = await FranchiseLocation.findOneAndUpdate(
    q,
    { $set: set },
    { new: true },
  )
    .populate("owner", "firstName lastName fullName email")
    .lean();
  if (!updated)
    throw Object.assign(new Error("Not found"), { statusCode: 404 });
  return updated;
}

async function loadDoc(q) {
  const doc = await FranchiseLocation.findOne(q)
    .populate("owner", "firstName lastName fullName email")
    .lean();
  if (!doc) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  return doc;
}

function wrapHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const code = Number(e?.statusCode) || 400;
      res.status(code).json({ ok: false, error: String(e?.message || e) });
    }
  };
}

module.exports = {
  cleanStr,
  toLower,
  isObj,
  now,
  ms,
  bool,
  normStatus,
  isSuper,
  providerId,
  toObjId,
  idParam,
  ensureId,
  ensureAuth,
  ok,
  bad,
  safeDraft,
  mergedForProvider,
  hasDraftChanges,
  editedAfterReject,
  canTogglePublished,
  pickDraftPatch,
  mergeDraft,
  limitOf,
  pageOf,
  viewOf,
  baseFilters,
  viewQuery,
  pagedFind,
  enrichOwners,
  mapDoc,
  loadDocUpdate,
  loadDoc,
  wrapHandler,
};

// "use strict";

// const mongoose = require("mongoose");
// const AdminUser = require("../../models/AdminUser");
// const FranchiseLocation = require("../../models/FranchiseLocation");

// const { isValidObjectId, Types } = mongoose;

// const draftFields = [
//   "licenseeFirstName",
//   "licenseeLastName",
//   "country",
//   "city",
//   "state",
//   "address",
//   "zip",
//   "website",
//   "emailPublic",
//   "phonePublic",
// ];

// const liveRegexFields = [
//   "country",
//   "city",
//   "state",
//   "address",
//   "zip",
//   "licenseeFirstName",
//   "licenseeLastName",
// ];

// function cleanStr(v) {
//   return String(v ?? "").trim();
// }

// function toLower(v) {
//   return cleanStr(v).toLowerCase();
// }

// function isObj(v) {
//   return Boolean(v) && typeof v === "object" && !Array.isArray(v);
// }

// function now() {
//   return new Date();
// }

// function ms(v) {
//   const t = v ? new Date(v).getTime() : 0;
//   return Number.isFinite(t) ? t : 0;
// }

// function bool(v) {
//   return v === true || v === "true" || v === 1 || v === "1";
// }

// function normStatus(v) {
//   const s = toLower(v);
//   return s === "pending" || s === "approved" || s === "rejected" ? s : "";
// }

// function isSuper(req) {
//   return req.isSuperAdmin === true || cleanStr(req.role) === "super";
// }

// function providerId(req) {
//   return cleanStr(req.providerId);
// }

// function toObjId(id) {
//   if (!isValidObjectId(id)) return null;
//   return new Types.ObjectId(id);
// }

// function idParam(req) {
//   return cleanStr(req.params.id);
// }

// function ensureId(res, id) {
//   if (isValidObjectId(id)) return true;
//   return bad(res, 400, "Invalid id");
// }

// function ensureAuth(res, superUser, myOwnerId) {
//   if (superUser || myOwnerId) return true;
//   return bad(res, 401, "Unauthorized");
// }

// function ok(res, data) {
//   return res.json({ ok: true, ...data });
// }

// function bad(res, status, error) {
//   res.status(status).json({ ok: false, error });
//   return false;
// }

// function safeDraft(d) {
//   return isObj(d) ? d : {};
// }

// function mergedForProvider(doc) {
//   return { ...doc, ...safeDraft(doc?.draft) };
// }

// function hasDraftChanges(doc) {
//   const d = ms(doc?.draftUpdatedAt);
//   const l = ms(doc?.liveUpdatedAt);
//   return Boolean(d && (!l || d > l));
// }

// function editedAfterReject(doc) {
//   const d = ms(doc?.draftUpdatedAt);
//   const r = ms(doc?.rejectedAt);
//   return Boolean(d && r && d > r);
// }

// function canTogglePublished(doc) {
//   return doc?.status === "approved" && doc?.submittedAt == null;
// }

// function pickDraftPatch(body) {
//   const src = isObj(body) ? body : {};
//   const draft = {};
//   for (const k of draftFields) if (k in src) draft[k] = cleanStr(src[k]);
//   return draft;
// }

// function mergeDraft(prevDraft, patch) {
//   return { ...safeDraft(prevDraft), ...patch };
// }

// function limitOf(req) {
//   return Math.min(Number(req.query.limit) || 20, 50);
// }

// function pageOf(req) {
//   return Math.max(Number(req.query.page) || 1, 1);
// }

// function viewOf(req) {
//   return cleanStr(req.query.view);
// }

// function searchOf(req) {
//   return cleanStr(req.query.search);
// }

// function baseFilters(req) {
//   const s = searchOf(req);
//   if (!s) return {};
//   return { $or: buildSearchOr(s) };
// }

// function buildSearchOr(s) {
//   return liveRegexFields.map((field) => regexField(field, s));
// }

// function regexField(field, s) {
//   return { [field]: { $regex: s, $options: "i" } };
// }

// function ownerOr(myOwnerId, pid) {
//   const p = cleanStr(pid);
//   const or = [];
//   if (myOwnerId) or.push({ owner: myOwnerId }, { ownerId: myOwnerId });
//   if (p) or.push({ owner: p }, { ownerId: p });
//   return or.length ? { $or: or } : {};
// }

// function notOwnerNor(myOwnerId, pid) {
//   const or = ownerOr(myOwnerId, pid).$or || [];
//   return or.length ? { $nor: or } : {};
// }

// function mineViewQuery(v, myOwnerId, pid, common) {
//   if (v === "mine_approved") return mineApproved(myOwnerId, pid, common);
//   if (v === "mine_pending") return minePending(myOwnerId, pid, common);
//   if (v === "mine_rejected") return mineRejected(myOwnerId, pid, common);
//   return { ...common, ...ownerOr(myOwnerId, pid) };
// }

// function mineApproved(myOwnerId, pid, common) {
//   return {
//     ...common,
//     ...ownerOr(myOwnerId, pid),
//     status: "approved",
//     submittedAt: null,
//   };
// }

// function minePending(myOwnerId, pid, common) {
//   return { ...common, ...ownerOr(myOwnerId, pid), $or: minePendingOr() };
// }

// function minePendingOr() {
//   return [
//     { status: "pending" },
//     { status: "approved", submittedAt: { $ne: null } },
//   ];
// }

// function mineRejected(myOwnerId, pid, common) {
//   return { ...common, ...ownerOr(myOwnerId, pid), status: "rejected" };
// }

// function providerViewQuery(v, myOwnerId, pid, common) {
//   const base = notOwnerNor(myOwnerId, pid);
//   if (v === "provider_approved") return providerApproved(common, base);
//   if (v === "provider_pending") return providerPending(common, base);
//   if (v === "provider_rejected") return providerRejected(common, base);
//   return null;
// }

// function providerApproved(common, base) {
//   return { ...common, ...base, status: "approved", submittedAt: null };
// }

// function providerPending(common, base) {
//   return { ...common, ...base, $or: minePendingOr() };
// }

// function providerRejected(common, base) {
//   return { ...common, ...base, status: "rejected" };
// }

// function viewQuery(view, myOwnerId, pid, common, superUser) {
//   const v = cleanStr(view);

//   if (v.startsWith("mine_")) return mineViewQuery(v, myOwnerId, pid, common);

//   if (!superUser) return mineViewQuery(v, myOwnerId, pid, common);

//   return providerViewQuery(v, myOwnerId, pid, common);
// }

// async function pagedFind(q, limit, page) {
//   const skip = (page - 1) * limit;
//   const [items, total] = await Promise.all([
//     fetchItems(q, limit, skip),
//     countItems(q),
//   ]);
//   return { items, total, page, pages: Math.ceil(total / limit) || 1, limit };
// }

// function fetchItems(q, limit, skip) {
//   return FranchiseLocation.find(q)
//     .sort({ updatedAt: -1, _id: -1 })
//     .skip(skip)
//     .limit(limit)
//     .lean();
// }

// function countItems(q) {
//   return FranchiseLocation.countDocuments(q);
// }

// function ownerIds(items) {
//   const ids = items.map((it) => cleanStr(it?.owner)).filter(Boolean);
//   return Array.from(new Set(ids));
// }

// async function enrichOwners(items) {
//   if (!Array.isArray(items) || !items.length) return items;
//   const ids = ownerIds(items);
//   if (!ids.length) return items;
//   const map = await loadOwnerMap(ids);
//   return items.map((it) => ({ ...it, ownerUser: buildOwnerUser(it, map) }));
// }

// async function loadOwnerMap(ids) {
//   const users = await AdminUser.find({ _id: { $in: ids } })
//     .select("_id fullName email firstName lastName")
//     .lean();
//   return new Map(users.map((u) => [cleanStr(u._id), u]));
// }

// function buildOwnerUser(it, map) {
//   const oid = cleanStr(it?.owner);
//   if (!oid) return null;
//   const u = map.get(oid);
//   return u ? ownerUserFrom(u) : emptyOwnerUser(oid);
// }

// function ownerUserFrom(u) {
//   return {
//     id: cleanStr(u._id),
//     fullName: u.fullName || "",
//     email: u.email || "",
//     firstName: u.firstName || "",
//     lastName: u.lastName || "",
//   };
// }

// function emptyOwnerUser(id) {
//   return { id, fullName: "", email: "", firstName: "", lastName: "" };
// }

// function mapDoc(d) {
//   const ownerId = cleanStr(isObj(d.owner) ? d.owner._id : d.owner);
//   return {
//     ...mapBase(d, ownerId),
//     ...mapTimes(d),
//     ...mapDraft(d),
//   };
// }

// function mapBase(d, ownerId) {
//   const names = locationNames(d);
//   return {
//     id: cleanStr(d._id),
//     owner: ownerId,
//     ownerId,
//     ownerName: names.ownerName,
//     ownerEmail: isObj(d.owner) ? d.owner.email || null : null,
//     ownerUser: d.ownerUser || null,
//     licenseeFirstName: names.firstName,
//     licenseeLastName: names.lastName,
//     ...mapAddress(d),
//     status: d.status,
//     published: d.published !== false,
//     rejectionReason: d.rejectionReason || "",
//   };
// }

// function mapAddress(d) {
//   return {
//     country: d.country,
//     city: d.city,
//     state: d.state || "",
//     address: d.address || "",
//     zip: d.zip || "",
//     website: d.website || "",
//     emailPublic: d.emailPublic || "",
//     phonePublic: d.phonePublic || "",
//   };
// }

// function mapTimes(d) {
//   return {
//     approvedAt: d.approvedAt || null,
//     liveUpdatedAt: d.liveUpdatedAt || null,
//     draftUpdatedAt: d.draftUpdatedAt || null,
//     rejectedAt: d.rejectedAt || null,
//     submittedAt: d.submittedAt || null,
//     lastProviderEditAt: d.lastProviderEditAt || null,
//     lastSuperEditAt: d.lastSuperEditAt || null,
//     createdAt: d.createdAt,
//     updatedAt: d.updatedAt,
//   };
// }

// function mapDraft(d) {
//   return { hasDraft: d.hasDraft === true, draft: safeDraft(d.draft) };
// }

// function locationNames(d) {
//   const firstName = d.licenseeFirstName || "";
//   const lastName = d.licenseeLastName || "";
//   const ownerName = `${firstName} ${lastName}`.trim() || null;
//   return { firstName, lastName, ownerName };
// }

// async function loadDocUpdate(q, set) {
//   const updated = await FranchiseLocation.findOneAndUpdate(
//     q,
//     { $set: set },
//     { new: true },
//   )
//     .populate("owner", "firstName lastName fullName email")
//     .lean();
//   if (!updated)
//     throw Object.assign(new Error("Not found"), { statusCode: 404 });
//   return updated;
// }

// async function loadDoc(q) {
//   const doc = await FranchiseLocation.findOne(q)
//     .populate("owner", "firstName lastName fullName email")
//     .lean();
//   if (!doc) throw Object.assign(new Error("Not found"), { statusCode: 404 });
//   return doc;
// }

// function wrapHandler(fn) {
//   return async (req, res) => {
//     try {
//       await fn(req, res);
//     } catch (e) {
//       const code = Number(e?.statusCode) || 400;
//       res.status(code).json({ ok: false, error: String(e?.message || e) });
//     }
//   };
// }

// module.exports = {
//   cleanStr,
//   toLower,
//   isObj,
//   now,
//   ms,
//   bool,
//   normStatus,
//   isSuper,
//   providerId,
//   toObjId,
//   idParam,
//   ensureId,
//   ensureAuth,
//   ok,
//   bad,
//   safeDraft,
//   mergedForProvider,
//   hasDraftChanges,
//   editedAfterReject,
//   canTogglePublished,
//   pickDraftPatch,
//   mergeDraft,
//   limitOf,
//   pageOf,
//   viewOf,
//   baseFilters,
//   viewQuery,
//   pagedFind,
//   enrichOwners,
//   mapDoc,
//   loadDocUpdate,
//   loadDoc,
//   wrapHandler,
// };

// // routes/adminFranchiseLocations.shared.js
// "use strict";

// const mongoose = require("mongoose");
// // const AdminUser = require("../models/AdminUser");
// // const FranchiseLocation = require("../models/FranchiseLocation");

// const AdminUser = require("../../models/AdminUser");
// const FranchiseLocation = require("../../models/FranchiseLocation");

// const { isValidObjectId, Types } = mongoose;

// function cleanStr(v) {
//   return String(v ?? "").trim();
// }

// function toLower(v) {
//   return cleanStr(v).toLowerCase();
// }

// function isObj(v) {
//   return v && typeof v === "object" && !Array.isArray(v);
// }

// function now() {
//   return new Date();
// }

// function ms(v) {
//   const t = v ? new Date(v).getTime() : 0;
//   return Number.isFinite(t) ? t : 0;
// }

// function bool(v) {
//   return v === true || v === "true" || v === 1 || v === "1";
// }

// function normStatus(v) {
//   const s = toLower(v);
//   return s === "pending" || s === "approved" || s === "rejected" ? s : "";
// }

// function isSuper(req) {
//   return req.isSuperAdmin === true || cleanStr(req.role) === "super";
// }

// function providerId(req) {
//   return cleanStr(req.providerId);
// }

// function toObjId(id) {
//   if (!isValidObjectId(id)) return null;
//   return new Types.ObjectId(id);
// }

// function idParam(req) {
//   return cleanStr(req.params.id);
// }

// function ensureId(res, id) {
//   if (isValidObjectId(id)) return true;
//   return bad(res, 400, "Invalid id");
// }

// function ensureAuth(res, superUser, myOwnerId) {
//   if (superUser || myOwnerId) return true;
//   return bad(res, 401, "Unauthorized");
// }

// function ok(res, data) {
//   return res.json({ ok: true, ...data });
// }

// function bad(res, status, error) {
//   res.status(status).json({ ok: false, error });
//   return false;
// }

// function safeDraft(d) {
//   return isObj(d) ? d : {};
// }

// function mergedForProvider(doc) {
//   return { ...doc, ...safeDraft(doc?.draft) };
// }

// function hasDraftChanges(doc) {
//   const d = ms(doc?.draftUpdatedAt);
//   const l = ms(doc?.liveUpdatedAt);
//   return Boolean(d && (!l || d > l));
// }

// function editedAfterReject(doc) {
//   const d = ms(doc?.draftUpdatedAt);
//   const r = ms(doc?.rejectedAt);
//   return Boolean(d && r && d > r);
// }

// function canTogglePublished(doc) {
//   return doc?.status === "approved" && doc?.submittedAt == null;
// }

// function allowedDraftFields() {
//   return [
//     "licenseeFirstName",
//     "licenseeLastName",
//     "country",
//     "city",
//     "state",
//     "address",
//     "zip",
//     "website",
//     "emailPublic",
//     "phonePublic",
//   ];
// }

// function pickDraftPatch(body) {
//   const draft = {};
//   for (const k of allowedDraftFields()) {
//     if (!(k in body)) continue;
//     draft[k] = cleanStr(body[k]);
//   }
//   return draft;
// }

// function mergeDraft(prevDraft, patch) {
//   return { ...safeDraft(prevDraft), ...patch };
// }

// function limitOf(req) {
//   return Math.min(Number(req.query.limit) || 20, 50);
// }

// function pageOf(req) {
//   return Math.max(Number(req.query.page) || 1, 1);
// }

// function viewOf(req) {
//   return cleanStr(req.query.view);
// }

// function searchOf(req) {
//   return cleanStr(req.query.search);
// }

// function baseFilters(req) {
//   const s = searchOf(req);
//   if (!s) return {};
//   return {
//     $or: [
//       { country: { $regex: s, $options: "i" } },
//       { city: { $regex: s, $options: "i" } },
//       { state: { $regex: s, $options: "i" } },
//       { address: { $regex: s, $options: "i" } },
//       { zip: { $regex: s, $options: "i" } },
//       { licenseeFirstName: { $regex: s, $options: "i" } },
//       { licenseeLastName: { $regex: s, $options: "i" } },
//     ],
//   };
// }

// function mineViewQuery(v, myOwnerId, common) {
//   if (v === "mine_approved")
//     return {
//       ...common,
//       owner: myOwnerId,
//       status: "approved",
//       submittedAt: null,
//     };
//   if (v === "mine_pending")
//     return {
//       ...common,
//       owner: myOwnerId,
//       $or: [
//         { status: "pending" },
//         { status: "approved", submittedAt: { $ne: null } },
//       ],
//     };
//   if (v === "mine_rejected")
//     return { ...common, owner: myOwnerId, status: "rejected" };
//   return { ...common, owner: myOwnerId };
// }

// function providerViewQuery(v, myOwnerId, common) {
//   const base = myOwnerId ? { owner: { $ne: myOwnerId } } : {};
//   if (v === "provider_approved")
//     return { ...common, ...base, status: "approved", submittedAt: null };
//   if (v === "provider_pending")
//     return {
//       ...common,
//       ...base,
//       $or: [
//         { status: "pending" },
//         { status: "approved", submittedAt: { $ne: null } },
//       ],
//     };
//   if (v === "provider_rejected")
//     return { ...common, ...base, status: "rejected" };
//   return null;
// }

// function viewQuery(view, myOwnerId, common, superUser) {
//   const v = cleanStr(view);
//   if (!superUser) return mineViewQuery(v, myOwnerId, common);
//   return providerViewQuery(v, myOwnerId, common);
// }

// async function pagedFind(q, limit, page) {
//   const skip = (page - 1) * limit;
//   const [items, total] = await Promise.all([
//     FranchiseLocation.find(q)
//       .sort({ updatedAt: -1, _id: -1 })
//       .skip(skip)
//       .limit(limit)
//       .lean(),
//     FranchiseLocation.countDocuments(q),
//   ]);
//   return { items, total, page, pages: Math.ceil(total / limit) || 1, limit };
// }

// function ownerIds(items) {
//   return Array.from(
//     new Set(items.map((it) => cleanStr(it?.owner)).filter(Boolean)),
//   );
// }

// function buildOwnerUser(it, map) {
//   const oid = cleanStr(it?.owner);
//   const u = oid ? map.get(oid) : null;
//   if (!oid) return null;
//   if (!u)
//     return { id: oid, fullName: "", email: "", firstName: "", lastName: "" };
//   return {
//     id: cleanStr(u._id),
//     fullName: u.fullName || "",
//     email: u.email || "",
//     firstName: u.firstName || "",
//     lastName: u.lastName || "",
//   };
// }

// async function enrichOwners(items) {
//   if (!Array.isArray(items) || !items.length) return items;
//   const ids = ownerIds(items);
//   if (!ids.length) return items;
//   const users = await AdminUser.find({ _id: { $in: ids } })
//     .select("_id fullName email firstName lastName")
//     .lean();
//   const map = new Map(users.map((u) => [cleanStr(u._id), u]));
//   return items.map((it) => ({ ...it, ownerUser: buildOwnerUser(it, map) }));
// }

// function mapDoc(d) {
//   const ownerId = cleanStr(isObj(d.owner) ? d.owner._id : d.owner);
//   const fn = d.licenseeFirstName || "";
//   const ln = d.licenseeLastName || "";
//   const ownerName = `${fn} ${ln}`.trim() || null;
//   return {
//     id: cleanStr(d._id),
//     owner: ownerId,
//     ownerId,
//     ownerName,
//     ownerEmail: isObj(d.owner) ? d.owner.email || null : null,
//     ownerUser: d.ownerUser || null,
//     licenseeFirstName: fn,
//     licenseeLastName: ln,
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
//     draftUpdatedAt: d.draftUpdatedAt || null,
//     rejectedAt: d.rejectedAt || null,
//     submittedAt: d.submittedAt || null,
//     lastProviderEditAt: d.lastProviderEditAt || null,
//     lastSuperEditAt: d.lastSuperEditAt || null,
//     hasDraft: d.hasDraft === true,
//     draft: safeDraft(d.draft),
//     createdAt: d.createdAt,
//     updatedAt: d.updatedAt,
//   };
// }

// async function loadDocUpdate(q, set) {
//   const updated = await FranchiseLocation.findOneAndUpdate(
//     q,
//     { $set: set },
//     { new: true },
//   )
//     .populate("owner", "firstName lastName fullName email")
//     .lean();
//   if (!updated)
//     throw Object.assign(new Error("Not found"), { statusCode: 404 });
//   return updated;
// }

// async function loadDoc(q) {
//   const doc = await FranchiseLocation.findOne(q)
//     .populate("owner", "firstName lastName fullName email")
//     .lean();
//   if (!doc) throw Object.assign(new Error("Not found"), { statusCode: 404 });
//   return doc;
// }

// function wrapHandler(fn) {
//   return async (req, res) => {
//     try {
//       await fn(req, res);
//     } catch (e) {
//       const code = Number(e?.statusCode) || 400;
//       res.status(code).json({ ok: false, error: String(e?.message || e) });
//     }
//   };
// }

// module.exports = {
//   cleanStr,
//   toLower,
//   isObj,
//   now,
//   ms,
//   bool,
//   normStatus,
//   isSuper,
//   providerId,
//   toObjId,
//   idParam,
//   ensureId,
//   ensureAuth,
//   ok,
//   bad,
//   safeDraft,
//   mergedForProvider,
//   hasDraftChanges,
//   editedAfterReject,
//   canTogglePublished,
//   pickDraftPatch,
//   mergeDraft,
//   limitOf,
//   pageOf,
//   viewOf,
//   baseFilters,
//   viewQuery,
//   pagedFind,
//   enrichOwners,
//   mapDoc,
//   loadDocUpdate,
//   loadDoc,
//   wrapHandler,
// };
