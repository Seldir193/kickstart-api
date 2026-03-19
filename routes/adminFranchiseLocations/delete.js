// routes/adminFranchiseLocations/delete.js
"use strict";

const FranchiseLocation = require("../../models/FranchiseLocation");
const {
  isSuper,
  providerId,
  toObjId,
  ensureAuth,
  ensureId,
  idParam,
  bad,
  cleanStr,
} = require("./shared");

function ownerMatch(req, myOwnerId) {
  const pid = cleanStr(providerId(req));
  const or = [];
  if (myOwnerId) or.push({ owner: myOwnerId }, { ownerId: String(myOwnerId) });
  if (pid) or.push({ owner: pid }, { ownerId: pid });
  return or.length ? { $or: or } : {};
}

async function handleDelete(req, res) {
  const id = idParam(req);
  if (!ensureId(res, id)) return;

  const superUser = isSuper(req);
  const pid = cleanStr(providerId(req));
  const myOwnerId = toObjId(pid);

  if (!ensureAuth(res, superUser, myOwnerId)) return;

  const q = superUser
    ? { _id: id }
    : { _id: id, ...ownerMatch(req, myOwnerId) };

  const del = await FranchiseLocation.findOneAndDelete(q).lean();
  if (!del) return bad(res, 404, "Not found");

  return res.json({ ok: true });
}

module.exports = { handleDelete };

// "use strict";

// const FranchiseLocation = require("../../models/FranchiseLocation");

// const {
//   isSuper,
//   providerId,
//   toObjId,
//   ensureAuth,
//   ensureId,
//   idParam,
//   ok,
//   bad,
// } = require("./shared");

// async function handleDelete(req, res) {
//   const id = idParam(req);
//   if (!ensureId(res, id)) return;
//   const superUser = isSuper(req);
//   const myOwnerId = toObjId(providerId(req));
//   if (!ensureAuth(res, superUser, myOwnerId)) return;
//   const q = superUser ? { _id: id } : { _id: id, owner: myOwnerId };
//   const del = await FranchiseLocation.findOneAndDelete(q).lean();
//   if (!del) return bad(res, 404, "Not found");
//   return ok(res, {});
// }

// module.exports = { handleDelete };
