// routes/adminFranchiseLocations/get.js
"use strict";

const {
  isSuper,
  providerId,
  toObjId,
  ensureAuth,
  limitOf,
  pageOf,
  viewOf,
  baseFilters,
  viewQuery,
  pagedFind,
  enrichOwners,
  mapDoc,
  mergedForProvider,
  ok,
  cleanStr,
} = require("./shared");

async function handleGet(req, res) {
  const limit = limitOf(req);
  const page = pageOf(req);
  const common = baseFilters(req);
  const superUser = isSuper(req);

  const pid = cleanStr(providerId(req));
  const myOwnerId = toObjId(pid);

  if (!ensureAuth(res, superUser, myOwnerId)) return;

  if (!superUser) {
    return ok(res, await mineResult(req, common, myOwnerId, pid, limit, page));
  }

  return ok(res, await superResult(req, common, myOwnerId, pid, limit, page));
}

async function mineResult(req, common, myOwnerId, pid, limit, page) {
  const q = viewQuery(viewOf(req), myOwnerId, pid, common, false);
  const data = await pagedFind(q, limit, page);
  const items = await enrichOwners(data.items);
  const mapped = items.map((d) => mapDoc(mergedForProvider(d)));
  return { ...data, items: mapped };
}

async function superResult(req, common, myOwnerId, pid, limit, page) {
  const q = viewQuery(viewOf(req), myOwnerId, pid, common, true);
  if (q) return await singleView(q, limit, page);
  return await combined(common, myOwnerId, pid, limit, page);
}

async function singleView(q, limit, page) {
  const data = await pagedFind(q, limit, page);
  const items = await enrichOwners(data.items);
  return { ...data, items: items.map(mapDoc) };
}

async function combined(common, myOwnerId, pid, limit, page) {
  const base = otherOwners(myOwnerId, pid);
  const queries = buildCombinedQueries(common, myOwnerId, pid, base);

  const [mine, pending, rejected, approved] = await Promise.all([
    bucket(queries.mine, limit, page),
    bucket(queries.pending, limit, page),
    bucket(queries.rejected, limit, page),
    bucket(queries.approved, limit, page),
  ]);

  return wrapCombined(mine, pending, rejected, approved);
}

function otherOwners(myOwnerId, pid) {
  const ors = [];
  if (myOwnerId)
    ors.push(
      { owner: { $ne: myOwnerId } },
      { ownerId: { $ne: String(myOwnerId) } },
    );
  if (pid) ors.push({ owner: { $ne: pid } }, { ownerId: { $ne: pid } });
  if (!ors.length) return {};
  return { $and: ors };
}

function buildCombinedQueries(common, myOwnerId, pid, base) {
  const mine =
    myOwnerId || pid
      ? {
          ...common,
          $or: [
            ...(myOwnerId
              ? [{ owner: myOwnerId }, { ownerId: String(myOwnerId) }]
              : []),
            ...(pid ? [{ owner: pid }, { ownerId: pid }] : []),
          ],
        }
      : { ...common };

  return {
    mine,
    pending: { ...common, ...base, $or: pendingOr() },
    rejected: { ...common, ...base, status: "rejected" },
    approved: { ...common, ...base, status: "approved", submittedAt: null },
  };
}

function pendingOr() {
  return [
    { status: "pending" },
    { status: "approved", submittedAt: { $ne: null } },
  ];
}

function wrapCombined(mine, pending, rejected, approved) {
  return {
    combined: true,
    mine,
    providerPending: pending,
    providerRejected: rejected,
    providerApproved: approved,
  };
}

async function bucket(q, limit, page) {
  const data = await pagedFind(q, limit, page);
  const items = await enrichOwners(data.items);
  return { ...data, items: items.map(mapDoc) };
}

module.exports = { handleGet };

// // routes/adminFranchiseLocations.get.js
// "use strict";

// const {
//   isSuper,
//   providerId,
//   toObjId,
//   ensureAuth,
//   limitOf,
//   pageOf,
//   viewOf,
//   baseFilters,
//   viewQuery,
//   pagedFind,
//   enrichOwners,
//   mapDoc,
//   mergedForProvider,
//   ok,
// } = require("./shared");

// async function handleGet(req, res) {
//   const limit = limitOf(req);
//   const page = pageOf(req);
//   const common = baseFilters(req);
//   const superUser = isSuper(req);
//   const myOwnerId = toObjId(providerId(req));
//   if (!ensureAuth(res, superUser, myOwnerId)) return;
//   if (!superUser) return handleMine(req, res, common, myOwnerId, limit, page);
//   return handleSuper(req, res, common, myOwnerId, limit, page);
// }

// async function handleMine(req, res, common, myOwnerId, limit, page) {
//   const q = viewQuery(viewOf(req), myOwnerId, common, false);
//   const data = await pagedFind(q, limit, page);
//   const items = await enrichOwners(data.items);
//   const mapped = items.map((d) => mapDoc(mergedForProvider(d)));
//   return ok(res, { ...data, items: mapped });
// }

// async function handleSuper(req, res, common, myOwnerId, limit, page) {
//   const q = viewQuery(viewOf(req), myOwnerId, common, true);
//   if (q) return ok(res, await singleView(q, limit, page));
//   return ok(res, await combined(common, myOwnerId, limit, page));
// }

// async function singleView(q, limit, page) {
//   const data = await pagedFind(q, limit, page);
//   const items = await enrichOwners(data.items);
//   return { ...data, items: items.map(mapDoc) };
// }

// async function combined(common, myOwnerId, limit, page) {
//   const base = myOwnerId ? { owner: { $ne: myOwnerId } } : {};
//   const qMine = myOwnerId ? { ...common, owner: myOwnerId } : { ...common };
//   const qPending = {
//     ...common,
//     ...base,
//     $or: [
//       { status: "pending" },
//       { status: "approved", submittedAt: { $ne: null } },
//     ],
//   };
//   const qRejected = { ...common, ...base, status: "rejected" };
//   const qApproved = {
//     ...common,
//     ...base,
//     status: "approved",
//     submittedAt: null,
//   };
//   const [mine, pending, rejected, approved] = await Promise.all([
//     bucket(qMine, limit, page),
//     bucket(qPending, limit, page),
//     bucket(qRejected, limit, page),
//     bucket(qApproved, limit, page),
//   ]);
//   return {
//     combined: true,
//     mine,
//     providerPending: pending,
//     providerRejected: rejected,
//     providerApproved: approved,
//   };
// }

// async function bucket(q, limit, page) {
//   const data = await pagedFind(q, limit, page);
//   const items = await enrichOwners(data.items);
//   return { ...data, items: items.map(mapDoc) };
// }

// module.exports = { handleGet };
