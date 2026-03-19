// routes/adminFranchiseLocations/create.js
"use strict";

const FranchiseLocation = require("../../models/FranchiseLocation");
const {
  isSuper,
  providerId,
  toObjId,
  cleanStr,
  normStatus,
  now,
  isObj,
  mapDoc,
  loadDoc,
} = require("./shared");

async function handleCreate(req, res) {
  const ctx = createContext(req);
  if (!ctx.ownerId)
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  const created = await createDoc(ctx.body, ctx.ownerId, ctx.superUser);
  return res.status(201).json({ ok: true, item: created });
}

function createContext(req) {
  const superUser = isSuper(req);
  const pid = providerId(req);
  const ownerRaw = superUser ? cleanStr(req.body?.owner || pid) : pid;
  const ownerId = toObjId(ownerRaw);
  const body = isObj(req.body) ? req.body : {};
  return { superUser, ownerId, body };
}

async function createDoc(body, ownerId, superUser) {
  validateCreate(body);
  const t = now();
  const base = baseFields(body);
  const status = resolveCreateStatus(body, superUser);
  const payload = buildCreatePayload(ownerId, base, status, superUser, body, t);
  const created = await FranchiseLocation.create(payload);
  const fresh = await loadDoc({ _id: created._id });
  return mapDoc(fresh);
}

function resolveCreateStatus(body, superUser) {
  const given = normStatus(body.status);
  if (given) return given;

  if (superUser) return "approved";
  return "pending";
}

function validateCreate(body) {
  if (!cleanStr(body.licenseeFirstName) || !cleanStr(body.licenseeLastName)) {
    throw Object.assign(
      new Error("licenseeFirstName and licenseeLastName are required"),
      { statusCode: 400 },
    );
  }
  if (!cleanStr(body.country) || !cleanStr(body.city)) {
    throw Object.assign(new Error("country and city are required"), {
      statusCode: 400,
    });
  }
}

function baseFields(body) {
  return {
    licenseeFirstName: cleanStr(body.licenseeFirstName),
    licenseeLastName: cleanStr(body.licenseeLastName),
    country: cleanStr(body.country),
    city: cleanStr(body.city),
    state: cleanStr(body.state),
    address: cleanStr(body.address),
    zip: cleanStr(body.zip),
    website: cleanStr(body.website),
    emailPublic: cleanStr(body.emailPublic),
    phonePublic: cleanStr(body.phonePublic),
  };
}

function buildCreatePayload(ownerId, base, status, superUser, body, t) {
  const payload = baseCreatePayload(ownerId, base, superUser, t);
  if (status === "rejected") return applyRejectCreate(payload, body, t);
  if (status === "approved") return applyApproveCreate(payload, t);
  return payload;
}

function baseCreatePayload(ownerId, base, superUser, t) {
  return {
    owner: ownerId,
    ...base,
    status: "pending",
    published: false,
    rejectionReason: "",
    moderatedAt: null,
    approvedAt: null,
    liveUpdatedAt: null,
    draftUpdatedAt: superUser ? null : t,
    rejectedAt: null,
    submittedAt: superUser ? null : t,
    lastProviderEditAt: superUser ? null : t,
    lastSuperEditAt: superUser ? t : null,
    hasDraft: !superUser,
    draft: superUser ? {} : { ...base },
  };
}

function applyRejectCreate(payload, body, t) {
  const reason = cleanStr(body.rejectionReason);
  if (!reason) {
    throw Object.assign(
      new Error("rejectionReason is required when status is rejected"),
      { statusCode: 400 },
    );
  }
  return {
    ...payload,
    status: "rejected",
    published: false,
    rejectionReason: reason,
    rejectedAt: t,
    moderatedAt: t,
    submittedAt: null,
    liveUpdatedAt: t,
  };
}

function applyApproveCreate(payload, t) {
  return {
    ...payload,
    status: "approved",
    published: true,
    approvedAt: t,
    liveUpdatedAt: t,
    submittedAt: null,
    hasDraft: false,
    draftUpdatedAt: null,
    draft: {},
    moderatedAt: t,
  };
}

module.exports = { handleCreate };

// // routes/adminFranchiseLocations.create.js
// "use strict";

// const FranchiseLocation = require("../../models/FranchiseLocation");

// const {
//   isSuper,
//   providerId,
//   toObjId,
//   cleanStr,
//   normStatus,
//   bool,
//   now,
//   isObj,
//   mapDoc,
//   loadDoc,
//   bad,
// } = require("./shared");

// async function handleCreate(req, res) {
//   const superUser = isSuper(req);
//   const pid = providerId(req);
//   const ownerRaw = superUser ? cleanStr(req.body?.owner || pid) : pid;
//   const ownerId = toObjId(ownerRaw);
//   if (!ownerId) return bad(res, 401, "Unauthorized");
//   const body = isObj(req.body) ? req.body : {};
//   const created = await createDoc(body, ownerId, superUser);
//   return res.status(201).json({ ok: true, item: created });
// }

// async function createDoc(b, ownerId, superUser) {
//   ensureCreateRequired(b);
//   const t = now();
//   const base = baseFields(b);
//   const status = superUser
//     ? normStatus(b.status || "pending") || "pending"
//     : "pending";
//   const payload = basePayload(ownerId, base, status, superUser, b, t);
//   const created = await FranchiseLocation.create(payload);
//   const fresh = await loadDoc({ _id: created._id });
//   return mapDoc(fresh);
// }

// function ensureCreateRequired(b) {
//   if (!cleanStr(b.licenseeFirstName) || !cleanStr(b.licenseeLastName)) {
//     throw Object.assign(
//       new Error("licenseeFirstName and licenseeLastName are required"),
//       { statusCode: 400 },
//     );
//   }
//   if (!cleanStr(b.country) || !cleanStr(b.city)) {
//     throw Object.assign(new Error("country and city are required"), {
//       statusCode: 400,
//     });
//   }
// }

// function baseFields(b) {
//   return {
//     licenseeFirstName: cleanStr(b.licenseeFirstName),
//     licenseeLastName: cleanStr(b.licenseeLastName),
//     country: cleanStr(b.country),
//     city: cleanStr(b.city),
//     state: cleanStr(b.state),
//     address: cleanStr(b.address),
//     zip: cleanStr(b.zip),
//     website: cleanStr(b.website),
//     emailPublic: cleanStr(b.emailPublic),
//     phonePublic: cleanStr(b.phonePublic),
//   };
// }

// function basePayload(ownerId, base, status, superUser, b, t) {
//   const draft = superUser ? {} : { ...base };
//   const published = status === "approved" ? true : bool(b.published) || true;
//   const payload = {
//     owner: ownerId,
//     ...base,
//     status,
//     published,
//     rejectionReason: "",
//     moderatedAt: status === "pending" ? null : t,
//     approvedAt: null,
//     liveUpdatedAt: null,
//     draftUpdatedAt: superUser ? null : t,
//     rejectedAt: null,
//     submittedAt: superUser ? null : t,
//     lastProviderEditAt: superUser ? null : t,
//     lastSuperEditAt: superUser ? t : null,
//     hasDraft: !superUser,
//     draft,
//   };
//   if (status === "rejected") applyReject(payload, b, t);
//   if (status === "approved") applyApproveCreate(payload, t);
//   return payload;
// }

// function applyReject(payload, b, t) {
//   const reason = cleanStr(b.rejectionReason);
//   if (!reason)
//     throw Object.assign(
//       new Error("rejectionReason is required when status is rejected"),
//       { statusCode: 400 },
//     );
//   payload.status = "rejected";
//   payload.rejectionReason = reason;
//   payload.rejectedAt = t;
//   payload.moderatedAt = t;
//   payload.published = false;
// }

// function applyApproveCreate(payload, t) {
//   payload.status = "approved";
//   payload.published = true;
//   payload.approvedAt = t;
//   payload.liveUpdatedAt = t;
//   payload.submittedAt = null;
//   payload.hasDraft = false;
//   payload.draftUpdatedAt = null;
//   payload.draft = {};
//   payload.rejectionReason = "";
//   payload.rejectedAt = null;
// }

// module.exports = { handleCreate };
