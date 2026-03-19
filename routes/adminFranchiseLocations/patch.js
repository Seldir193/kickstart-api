// routes/adminFranchiseLocations/patch.js
"use strict";

const {
  isSuper,
  providerId,
  toObjId,
  ensureAuth,
  ensureId,
  idParam,
  isObj,
  cleanStr,
  now,
  normStatus,
  bool,
  pickDraftPatch,
  mergeDraft,
  mergedForProvider,
  hasDraftChanges,
  editedAfterReject,
  canTogglePublished,
  loadDocUpdate,
  loadDoc,
  mapDoc,
  ok,
} = require("./shared");

async function handlePatch(req, res) {
  try {
    const id = idParam(req);
    if (!ensureId(res, id)) return;

    const superUser = isSuper(req);
    const myOwnerId = toObjId(providerId(req));
    if (!ensureAuth(res, superUser, myOwnerId)) return;

    const item = superUser
      ? await patchSuper(req, id)
      : await patchProvider(req, id, myOwnerId);

    return ok(res, { item });
  } catch (e) {
    const code = Number(e?.statusCode || 400);
    return res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
}

function stripSubmit(body) {
  const submitForReview = body?.submitForReview === true;
  const next = { ...(isObj(body) ? body : {}) };
  delete next.submitForReview;
  return { submitForReview, next };
}

function ownerMatch(req, myOwnerId) {
  const pid = cleanStr(providerId(req));
  const or = [];
  if (myOwnerId) or.push({ owner: myOwnerId }, { ownerId: myOwnerId });
  if (pid) or.push({ owner: pid }, { ownerId: pid });
  return or.length ? { $or: or } : {};
}

async function patchProvider(req, id, myOwnerId) {
  const q = { _id: id, ...ownerMatch(req, myOwnerId) };
  const { submitForReview, next } = stripSubmit(req.body);
  const existing = await loadDoc(q);

  if (submitForReview) return submitProvider(existing, q);
  if (hasKey(next, "published")) return togglePublished(existing, q, next);
  return saveDraft(existing, q, next);
}

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

async function submitProvider(existing, q) {
  ensureCanSubmit(existing);
  const t = now();
  const updated = await loadDocUpdate(q, submitSet(existing, t));
  return mapDoc(mergedForProvider(updated));
}

function submitSet(existing, t) {
  const keepApproved = existing?.status === "approved";
  return {
    status: keepApproved ? "approved" : "pending",
    submittedAt: t,
    rejectionReason: "",
    rejectedAt: null,
    moderatedAt: null,
    lastProviderEditAt: t,
  };
}

function ensureCanSubmit(doc) {
  if (canSubmit(doc)) return;
  throw Object.assign(new Error("Submit not allowed"), { statusCode: 403 });
}

function canSubmit(doc) {
  if (isRejected(doc)) return editedAfterReject(doc);
  if (doc.status === "approved") return hasDraftChanges(doc);
  return false;
}

function isRejected(doc) {
  return doc.status === "rejected" || cleanStr(doc.rejectionReason);
}

async function togglePublished(existing, q, next) {
  ensureCanToggle(existing);
  const t = now();
  const updated = await loadDocUpdate(q, toggleSet(next, t));
  return mapDoc(mergedForProvider(updated));
}

function ensureCanToggle(doc) {
  if (canTogglePublished(doc)) return;
  throw Object.assign(new Error("Toggle not allowed"), { statusCode: 403 });
}

function toggleSet(next, t) {
  return {
    published: bool(next.published),
    liveUpdatedAt: t,
    lastProviderEditAt: t,
  };
}

async function saveDraft(existing, q, next) {
  const patch = pickDraftPatch(next);
  ensureHasChanges(patch);
  const t = now();
  const draft = mergeDraft(existing.draft, patch);
  const updated = await loadDocUpdate(q, draftSet(draft, t));
  return mapDoc(mergedForProvider(updated));
}

function ensureHasChanges(patch) {
  if (Object.keys(patch).length) return;
  throw Object.assign(new Error("No changes"), { statusCode: 400 });
}

function draftSet(draft, t) {
  return { draft, hasDraft: true, draftUpdatedAt: t, lastProviderEditAt: t };
}

async function patchSuper(req, id) {
  const { submitForReview, next } = stripSubmit(req.body);
  if (submitForReview) return invalidAction();

  const existing = await loadDoc({ _id: id });
  if (shouldReject(next)) return rejectSuper(id, next);
  if (shouldApprove(next)) return approveSuper(existing, id);
  return updateSuper(id, next);
}

function invalidAction() {
  throw Object.assign(new Error("Invalid action"), { statusCode: 400 });
}

function shouldReject(next) {
  if (hasKey(next, "rejectionReason") && cleanStr(next.rejectionReason))
    return true;
  return normStatus(next.status) === "rejected";
}

function shouldApprove(next) {
  if (next.approve === true) return true;
  return normStatus(next.status) === "approved";
}

async function rejectSuper(id, next) {
  const reason = cleanStr(next.rejectionReason);
  ensureRejectReason(reason);
  const t = now();
  const updated = await loadDocUpdate({ _id: id }, rejectSet(reason, t));
  return mapDoc(updated);
}

function ensureRejectReason(reason) {
  if (reason) return;
  throw Object.assign(new Error("rejectionReason is required"), {
    statusCode: 400,
  });
}

function rejectSet(reason, t) {
  return {
    status: "rejected",
    submittedAt: null,
    rejectionReason: reason,
    rejectedAt: t,
    moderatedAt: t,
    published: false,
    liveUpdatedAt: t,
    lastSuperEditAt: t,
  };
}

async function approveSuper(existing, id) {
  const t = now();
  const set = promoteDraft(existing, t);
  const updated = await loadDocUpdate({ _id: id }, set);
  return mapDoc(updated);
}

function promoteDraft(existing, t) {
  const d = isObj(existing.draft) ? existing.draft : {};
  return {
    ...liveFromDraft(existing, d),
    ...approveMeta(existing, t),
    ...clearDraft(),
  };
}

function approveMeta(existing, t) {
  return {
    status: "approved",
    published: true,
    rejectionReason: "",
    rejectedAt: null,
    submittedAt: null,
    moderatedAt: t,
    approvedAt: existing.approvedAt || t,
    liveUpdatedAt: t,
    lastSuperEditAt: t,
  };
}

function clearDraft() {
  return { hasDraft: false, draftUpdatedAt: null, draft: {} };
}

function liveFromDraft(existing, d) {
  const pick = (k) => (k in d ? d[k] : existing[k]);
  return {
    licenseeFirstName: pick("licenseeFirstName"),
    licenseeLastName: pick("licenseeLastName"),
    country: pick("country"),
    city: pick("city"),
    state: pick("state"),
    address: pick("address"),
    zip: pick("zip"),
    website: pick("website"),
    emailPublic: pick("emailPublic"),
    phonePublic: pick("phonePublic"),
  };
}

async function updateSuper(id, next) {
  const t = now();
  const patch = sanitizeSuperPatch(next);
  const liveTouch = touchesLive(patch);

  const updated = await loadDocUpdate(
    { _id: id },
    {
      ...patch,
      ...(liveTouch ? { liveUpdatedAt: t } : {}),
      lastSuperEditAt: t,
    },
  );
  return mapDoc(updated);
}

function touchesLive(patch) {
  if (hasKey(patch, "published")) return true;
  for (const k of Object.keys(patch || {})) if (isLiveField(k)) return true;
  return false;
}

function sanitizeSuperPatch(next) {
  const patch = {};
  if (hasKey(next, "owner")) patch.owner = ensureOwner(next.owner);
  assignLiveFields(patch, next);
  if (hasKey(next, "published")) patch.published = bool(next.published);
  assignStatus(patch, next);
  return patch;
}

function assignLiveFields(patch, next) {
  for (const k of Object.keys(next || {})) {
    if (isLiveField(k)) patch[k] = cleanStr(next[k]);
  }
}

function assignStatus(patch, next) {
  const s = hasKey(next, "status") ? normStatus(next.status) : "";
  if (s && s !== "rejected") patch.status = s;
}

function isLiveField(k) {
  return [
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
  ].includes(k);
}

function ensureOwner(v) {
  const oid = toObjId(cleanStr(v));
  if (oid) return oid;
  throw Object.assign(new Error("Valid owner is required"), {
    statusCode: 400,
  });
}

module.exports = { handlePatch };

// // routes/adminFranchiseLocations/patch.js
// "use strict";

// const {
//   isSuper,
//   providerId,
//   toObjId,
//   ensureAuth,
//   ensureId,
//   idParam,
//   isObj,
//   cleanStr,
//   now,
//   normStatus,
//   bool,
//   pickDraftPatch,
//   mergeDraft,
//   mergedForProvider,
//   hasDraftChanges,
//   editedAfterReject,
//   canTogglePublished,
//   loadDocUpdate,
//   loadDoc,
//   mapDoc,
//   ok,
// } = require("./shared");

// async function handlePatch(req, res) {
//   try {
//     const id = idParam(req);
//     if (!ensureId(res, id)) return;
//     const superUser = isSuper(req);
//     const myOwnerId = toObjId(providerId(req));
//     if (!ensureAuth(res, superUser, myOwnerId)) return;

//     const item = superUser
//       ? await patchSuper(req, id)
//       : await patchProvider(req, id, myOwnerId);

//     return ok(res, { item });
//   } catch (e) {
//     const code = Number(e?.statusCode || 400);
//     return res.status(code).json({ ok: false, error: String(e?.message || e) });
//   }
// }

// function stripSubmit(body) {
//   const submitForReview = body?.submitForReview === true;
//   const next = { ...(isObj(body) ? body : {}) };
//   delete next.submitForReview;
//   return { submitForReview, next };
// }

// function ownerMatch(req, myOwnerId) {
//   const pid = cleanStr(providerId(req));
//   const or = [];
//   if (myOwnerId) or.push({ owner: myOwnerId }, { ownerId: myOwnerId });
//   if (pid) or.push({ owner: pid }, { ownerId: pid });
//   return or.length ? { $or: or } : {};
// }

// async function patchProvider(req, id, myOwnerId) {
//   const q = { _id: id, ...ownerMatch(req, myOwnerId) };
//   const { submitForReview, next } = stripSubmit(req.body);
//   const existing = await loadDoc(q);
//   if (submitForReview) return submitProvider(existing, q);
//   if (hasKey(next, "published")) return togglePublished(existing, q, next);
//   return saveDraft(existing, q, next);
// }

// function hasKey(obj, key) {
//   return Object.prototype.hasOwnProperty.call(obj || {}, key);
// }

// // async function submitProvider(existing, q) {
// //   ensureCanSubmit(existing);
// //   const t = now();
// //   const updated = await loadDocUpdate(q, submitSet(t));
// //   return mapDoc(mergedForProvider(updated));
// // }

// async function submitProvider(existing, q) {
//   ensureCanSubmit(existing);
//   const t = now();
//   const updated = await loadDocUpdate(q, submitSet(existing, t));
//   return mapDoc(mergedForProvider(updated));
// }

// function submitSet(existing, t) {
//   const keepApproved = existing?.status === "approved";

//   return {
//     status: keepApproved ? "approved" : "pending",
//     submittedAt: t,
//     rejectionReason: "",
//     rejectedAt: null,
//     moderatedAt: null,
//     lastProviderEditAt: t,
//   };
// }

// function ensureCanSubmit(doc) {
//   if (canSubmit(doc)) return;
//   throw Object.assign(new Error("Submit not allowed"), { statusCode: 403 });
// }

// function canSubmit(doc) {
//   if (isRejected(doc)) return editedAfterReject(doc);
//   if (doc.status === "approved") return hasDraftChanges(doc);
//   return false;
// }

// function isRejected(doc) {
//   return doc.status === "rejected" || cleanStr(doc.rejectionReason);
// }

// function submitSet(t) {
//   return {
//     status: "pending",
//     submittedAt: t,
//     rejectionReason: "",
//     rejectedAt: null,
//     moderatedAt: null,
//     lastProviderEditAt: t,
//   };
// }

// async function togglePublished(existing, q, next) {
//   ensureCanToggle(existing);
//   const t = now();
//   const updated = await loadDocUpdate(q, toggleSet(next, t));
//   return mapDoc(mergedForProvider(updated));
// }

// function ensureCanToggle(doc) {
//   if (canTogglePublished(doc)) return;
//   throw Object.assign(new Error("Toggle not allowed"), { statusCode: 403 });
// }

// function toggleSet(next, t) {
//   return {
//     published: bool(next.published),
//     liveUpdatedAt: t,
//     lastProviderEditAt: t,
//   };
// }

// async function saveDraft(existing, q, next) {
//   const patch = pickDraftPatch(next);
//   ensureHasChanges(patch);
//   const t = now();
//   const draft = mergeDraft(existing.draft, patch);
//   const updated = await loadDocUpdate(q, draftSet(draft, t));
//   return mapDoc(mergedForProvider(updated));
// }

// function ensureHasChanges(patch) {
//   if (Object.keys(patch).length) return;
//   throw Object.assign(new Error("No changes"), { statusCode: 400 });
// }

// function draftSet(draft, t) {
//   return { draft, hasDraft: true, draftUpdatedAt: t, lastProviderEditAt: t };
// }

// async function patchSuper(req, id) {
//   const { submitForReview, next } = stripSubmit(req.body);
//   if (submitForReview) return invalidAction();

//   const existing = await loadDoc({ _id: id });
//   if (shouldReject(next)) return rejectSuper(id, next);
//   if (shouldApprove(next)) return approveSuper(existing, id);
//   return updateSuper(id, next);
// }

// function invalidAction() {
//   throw Object.assign(new Error("Invalid action"), { statusCode: 400 });
// }

// function shouldReject(next) {
//   if (hasKey(next, "rejectionReason") && cleanStr(next.rejectionReason))
//     return true;
//   return normStatus(next.status) === "rejected";
// }

// function shouldApprove(next) {
//   if (next.approve === true) return true;
//   return normStatus(next.status) === "approved";
// }

// async function rejectSuper(id, next) {
//   const reason = cleanStr(next.rejectionReason);
//   ensureRejectReason(reason);
//   const t = now();
//   const updated = await loadDocUpdate({ _id: id }, rejectSet(reason, t));
//   return mapDoc(updated);
// }

// function ensureRejectReason(reason) {
//   if (reason) return;
//   throw Object.assign(new Error("rejectionReason is required"), {
//     statusCode: 400,
//   });
// }

// function rejectSet(reason, t) {
//   return {
//     status: "rejected",
//     submittedAt: null,
//     rejectionReason: reason,
//     rejectedAt: t,
//     moderatedAt: t,
//     published: false,
//     liveUpdatedAt: t,
//     lastSuperEditAt: t,
//   };
// }

// async function approveSuper(existing, id) {
//   const t = now();
//   const set = promoteDraft(existing, t);
//   const updated = await loadDocUpdate({ _id: id }, set);
//   return mapDoc(updated);
// }

// function promoteDraft(existing, t) {
//   const d = isObj(existing.draft) ? existing.draft : {};
//   return {
//     ...liveFromDraft(existing, d),
//     ...approveMeta(existing, t),
//     ...clearDraft(),
//   };
// }

// function approveMeta(existing, t) {
//   return {
//     status: "approved",
//     published: true,
//     rejectionReason: "",
//     rejectedAt: null,
//     submittedAt: null,
//     moderatedAt: t,
//     approvedAt: existing.approvedAt || t,
//     liveUpdatedAt: t,
//     lastSuperEditAt: t,
//   };
// }

// function clearDraft() {
//   return { hasDraft: false, draftUpdatedAt: null, draft: {} };
// }

// function liveFromDraft(existing, d) {
//   const pick = (k) => (k in d ? d[k] : existing[k]);
//   return {
//     licenseeFirstName: pick("licenseeFirstName"),
//     licenseeLastName: pick("licenseeLastName"),
//     country: pick("country"),
//     city: pick("city"),
//     state: pick("state"),
//     address: pick("address"),
//     zip: pick("zip"),
//     website: pick("website"),
//     emailPublic: pick("emailPublic"),
//     phonePublic: pick("phonePublic"),
//   };
// }

// async function updateSuper(id, next) {
//   const t = now();
//   const patch = sanitizeSuperPatch(next);
//   const liveTouch = touchesLive(patch);
//   const updated = await loadDocUpdate(
//     { _id: id },
//     {
//       ...patch,
//       ...(liveTouch ? { liveUpdatedAt: t } : {}),
//       lastSuperEditAt: t,
//     },
//   );
//   return mapDoc(updated);
// }

// function touchesLive(patch) {
//   if (hasKey(patch, "published")) return true;
//   for (const k of Object.keys(patch || {})) if (isLiveField(k)) return true;
//   return false;
// }

// function sanitizeSuperPatch(next) {
//   const patch = {};
//   if (hasKey(next, "owner")) patch.owner = ensureOwner(next.owner);
//   assignLiveFields(patch, next);
//   if (hasKey(next, "published")) patch.published = bool(next.published);
//   assignStatus(patch, next);
//   return patch;
// }

// function assignLiveFields(patch, next) {
//   for (const k of Object.keys(next || {})) {
//     if (isLiveField(k)) patch[k] = cleanStr(next[k]);
//   }
// }

// function assignStatus(patch, next) {
//   const s = hasKey(next, "status") ? normStatus(next.status) : "";
//   if (s && s !== "rejected") patch.status = s;
// }

// function isLiveField(k) {
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
//   ].includes(k);
// }

// function ensureOwner(v) {
//   const oid = toObjId(cleanStr(v));
//   if (oid) return oid;
//   throw Object.assign(new Error("Valid owner is required"), {
//     statusCode: 400,
//   });
// }

// module.exports = { handlePatch };

// // routes/adminFranchiseLocations.patch.js
// "use strict";

// const {
//   isSuper,
//   providerId,
//   toObjId,
//   ensureAuth,
//   ensureId,
//   idParam,
//   isObj,
//   cleanStr,
//   now,
//   normStatus,
//   bool,
//   pickDraftPatch,
//   mergeDraft,
//   mergedForProvider,
//   hasDraftChanges,
//   editedAfterReject,
//   canTogglePublished,
//   loadDocUpdate,
//   loadDoc,
//   mapDoc,
//   ok,
// } = require("./shared");

// async function handlePatch(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   const superUser = isSuper(req);
//   const myOwnerId = toObjId(providerId(req));
//   if (!ensureAuth(res, superUser, myOwnerId)) return;
//   if (!superUser)
//     return ok(res, { item: await patchProvider(req, id, myOwnerId) });
//   return ok(res, { item: await patchSuper(req, id) });
// }

// function stripSubmit(body) {
//   const submitForReview = body?.submitForReview === true;
//   const next = { ...(isObj(body) ? body : {}) };
//   delete next.submitForReview;
//   return { submitForReview, next };
// }

// async function patchProvider(req, id, myOwnerId) {
//   const q = { _id: id, owner: myOwnerId };
//   const { submitForReview, next } = stripSubmit(req.body);
//   const existing = await loadDoc(q);
//   if (submitForReview) return submitProvider(existing, q);
//   if ("published" in next) return togglePublished(existing, q, next);
//   return saveDraft(existing, q, next);
// }

// async function submitProvider(existing, q) {
//   if (!canSubmit(existing))
//     throw Object.assign(new Error("Submit not allowed"), { statusCode: 403 });
//   const t = now();
//   const updated = await loadDocUpdate(q, {
//     status: "pending",
//     submittedAt: t,
//     rejectionReason: "",
//     rejectedAt: null,
//     moderatedAt: null,
//     lastProviderEditAt: t,
//   });
//   return mapDoc(mergedForProvider(updated));
// }

// function canSubmit(doc) {
//   const rejected = doc.status === "rejected" || cleanStr(doc.rejectionReason);
//   if (rejected) return editedAfterReject(doc);
//   if (doc.status === "approved") return hasDraftChanges(doc);
//   return false;
// }

// async function togglePublished(existing, q, next) {
//   if (!canTogglePublished(existing))
//     throw Object.assign(new Error("Toggle not allowed"), { statusCode: 403 });
//   const t = now();
//   const updated = await loadDocUpdate(q, {
//     published: bool(next.published),
//     lastProviderEditAt: t,
//   });
//   return mapDoc(mergedForProvider(updated));
// }

// async function saveDraft(existing, q, next) {
//   const patch = pickDraftPatch(next);
//   if (!Object.keys(patch).length)
//     throw Object.assign(new Error("No changes"), { statusCode: 400 });
//   const t = now();
//   const draft = mergeDraft(existing.draft, patch);
//   const updated = await loadDocUpdate(q, {
//     draft,
//     hasDraft: true,
//     draftUpdatedAt: t,
//     lastProviderEditAt: t,
//   });
//   return mapDoc(mergedForProvider(updated));
// }

// async function patchSuper(req, id) {
//   const { submitForReview, next } = stripSubmit(req.body);
//   if (submitForReview)
//     throw Object.assign(new Error("Invalid action"), { statusCode: 400 });
//   const existing = await loadDoc({ _id: id });
//   if (shouldReject(next)) return rejectSuper(id, next);
//   if (shouldApprove(next)) return approveSuper(existing, id);
//   return updateSuper(id, next);
// }

// function shouldReject(next) {
//   if ("rejectionReason" in next && cleanStr(next.rejectionReason)) return true;
//   return normStatus(next.status) === "rejected";
// }

// function shouldApprove(next) {
//   if (next.approve === true) return true;
//   return normStatus(next.status) === "approved";
// }

// async function rejectSuper(id, next) {
//   const reason = cleanStr(next.rejectionReason);
//   if (!reason)
//     throw Object.assign(new Error("rejectionReason is required"), {
//       statusCode: 400,
//     });
//   const t = now();
//   const updated = await loadDocUpdate(
//     { _id: id },
//     {
//       status: "rejected",
//       submittedAt: null,
//       rejectionReason: reason,
//       rejectedAt: t,
//       moderatedAt: t,
//       published: false,
//       lastSuperEditAt: t,
//     },
//   );
//   return mapDoc(updated);
// }

// async function approveSuper(existing, id) {
//   const t = now();
//   const set = promoteDraft(existing, t);
//   const updated = await loadDocUpdate({ _id: id }, set);
//   return mapDoc(updated);
// }

// function promoteDraft(existing, t) {
//   const d =
//     existing.draft && typeof existing.draft === "object" ? existing.draft : {};
//   const live = liveFromDraft(existing, d);
//   return {
//     ...live,
//     status: "approved",
//     published: true,
//     rejectionReason: "",
//     rejectedAt: null,
//     submittedAt: null,
//     moderatedAt: t,
//     approvedAt: existing.approvedAt || t,
//     liveUpdatedAt: t,
//     hasDraft: false,
//     draftUpdatedAt: null,
//     draft: {},
//     lastSuperEditAt: t,
//   };
// }

// function liveFromDraft(existing, d) {
//   const pick = (k) => (k in d ? d[k] : existing[k]);
//   return {
//     licenseeFirstName: pick("licenseeFirstName"),
//     licenseeLastName: pick("licenseeLastName"),
//     country: pick("country"),
//     city: pick("city"),
//     state: pick("state"),
//     address: pick("address"),
//     zip: pick("zip"),
//     website: pick("website"),
//     emailPublic: pick("emailPublic"),
//     phonePublic: pick("phonePublic"),
//   };
// }

// async function updateSuper(id, next) {
//   const t = now();
//   const patch = sanitizeSuperPatch(next);
//   const updated = await loadDocUpdate(
//     { _id: id },
//     { ...patch, lastSuperEditAt: t },
//   );
//   return mapDoc(updated);
// }

// function sanitizeSuperPatch(next) {
//   const patch = {};
//   if ("owner" in next) patch.owner = ensureOwner(next.owner);
//   for (const k of Object.keys(next))
//     if (isLiveField(k)) patch[k] = cleanStr(next[k]);
//   if ("published" in next) patch.published = bool(next.published);
//   const s = "status" in next ? normStatus(next.status) : "";
//   if (s && s !== "rejected") patch.status = s;
//   return patch;
// }

// function isLiveField(k) {
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
//   ].includes(k);
// }

// function ensureOwner(v) {
//   const oid = toObjId(cleanStr(v));
//   if (!oid)
//     throw Object.assign(new Error("Valid owner is required"), {
//       statusCode: 400,
//     });
//   return oid;
// }

// module.exports = { handlePatch };
