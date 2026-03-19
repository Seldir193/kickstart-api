// routes/adminNews.js
"use strict";

const express = require("express");
const router = express.Router();
const News = require("../models/News");
const AdminUser = require("../models/AdminUser");
const adminAuth = require("../middleware/adminAuth");
const h = require("./adminNews.helpers");

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function ok(res, payload) {
  return sendJson(res, 200, { ok: true, ...payload });
}

function fail(res, status, error) {
  return sendJson(res, status, { ok: false, error });
}

function requireProvider(req) {
  const pid = h.getProviderId(req);
  if (!pid) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true, pid };
}

function wrap(fn) {
  return (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) =>
      fail(res, 500, h.clean(e?.message || "Error")),
    );
}

router.get(
  "/",
  adminAuth,
  wrap(async (req, res) => {
    const auth = requireProvider(req);
    if (!auth.ok) return fail(res, auth.status, auth.error);

    const { limit, page, view } = h.pickPaging(req);
    const common = h.buildBaseFilters(req);
    if (!h.isSuper(req))
      return providerList(res, auth.pid, view, common, limit, page);
    return superList(res, auth.pid, view, common, limit, page);
  }),
);

async function providerList(res, pid, view, common, limit, page) {
  const q = h.buildProviderViewQuery(view, pid, common);
  const data = await h.pagedFind(News, q, limit, page);
  data.items = data.items.map(h.mergeDraft);
  data.items = await h.enrichProviders(AdminUser, data.items);
  return ok(res, data);
}

async function superList(res, pid, view, common, limit, page) {
  const qs = h.buildSuperQueries(pid, common);
  if (view && view !== "combined")
    return superSingle(res, qs, view, limit, page);
  return superCombined(res, qs, limit, page);
}

async function superSingle(res, qs, view, limit, page) {
  const q = mapSuperView(qs, view);
  if (!q) return ok(res, { items: [], total: 0, page, pages: 1 });
  const data = await h.pagedFind(News, q, limit, page);
  data.items = await h.enrichProviders(AdminUser, data.items);
  return ok(res, data);
}

function mapSuperView(qs, view) {
  if (view === "mine") return qs.mine;
  if (view === "provider_pending") return qs.providerPending;
  if (view === "provider_approved") return qs.providerApproved;
  if (view === "provider_rejected") return qs.providerRejected;
  return null;
}

async function superCombined(res, qs, limit, page) {
  const [mine, pending, approved, rejected] = await Promise.all([
    h.pagedFind(News, qs.mine, limit, page),
    h.pagedFind(News, qs.providerPending, limit, page),
    h.pagedFind(News, qs.providerApproved, limit, page),
    h.pagedFind(News, qs.providerRejected, limit, page),
  ]);

  mine.items = await h.enrichProviders(AdminUser, mine.items);
  pending.items = await h.enrichProviders(AdminUser, pending.items);
  approved.items = await h.enrichProviders(AdminUser, approved.items);
  rejected.items = await h.enrichProviders(AdminUser, rejected.items);

  return ok(res, {
    combined: true,
    mine,
    providerPending: pending,
    providerApproved: approved,
    providerRejected: rejected,
  });
}

router.post(
  "/",
  adminAuth,
  wrap(async (req, res) => {
    const auth = requireProvider(req);
    if (!auth.ok) return fail(res, auth.status, auth.error);

    const body = h.normalizeBody(req.body || {});
    const err = h.ensureCreateFields(body);
    if (err) return fail(res, 400, err);

    const payload = h.buildCreatePayload(auth.pid, body);
    const saved = h.isSuper(req) ? await createAsSuper(payload) : payload;

    const created = await News.create(saved);
    return sendJson(res, 201, { ok: true, item: created });
  }),
);

async function createAsSuper(payload) {
  const set = h.buildApproveSet({ ...payload, draft: payload.draft });
  return { ...payload, ...set, submittedAt: null };
}

router.patch(
  "/:id",
  adminAuth,
  wrap(async (req, res) => {
    const auth = requireProvider(req);
    if (!auth.ok) return fail(res, auth.status, auth.error);

    const submitForReview = req.body?.submitForReview === true;
    const body = h.normalizeBody({ ...(req.body || {}) });
    delete body.submitForReview;

    const q = { _id: req.params.id };
    if (!h.isSuper(req))
      return patchProvider(res, auth.pid, q, body, submitForReview);
    return patchSuper(res, q, body);
  }),
);

// async function patchProvider(res, pid, q, body, submitForReview) {
//   q.providerId = pid;

//   if (submitForReview) return providerSubmit(res, q);

//   if (h.isOnlyPublishedPatch(body))
//     return providerTogglePublished(res, q, Boolean(body.published));

//   const safe = h.stripProviderForbidden(body);
//   if (!h.isContentEdit(safe)) return fail(res, 400, "No changes");
//   return providerDraft(res, q, safe);
// }

async function patchProvider(res, pid, q, body, submitForReview) {
  q.providerId = pid;

  if (submitForReview) return providerSubmit(res, q);

  if ("published" in body) {
    return providerTogglePublished(res, q, Boolean(body.published));
  }

  const safe = h.stripProviderForbidden(body);
  if (!h.isContentEdit(safe)) return fail(res, 400, "No changes");
  return providerDraft(res, q, safe);
}

async function providerSubmit(res, q) {
  const existing = await News.findOne(q).lean();
  if (!existing) return fail(res, 404, "Not found");
  if (!h.canSubmitForReview(existing))
    return fail(res, 403, "Submit not allowed");

  const set = h.buildProviderSubmitSet(existing);
  const updated = await News.findOneAndUpdate(q, { $set: set }, { new: true });
  if (!updated) return fail(res, 404, "Not found");
  return ok(res, { item: h.mergeDraft(updated.toObject?.() || updated) });
}

async function providerTogglePublished(res, q, nextPublished) {
  const existing = await News.findOne(q).lean();
  if (!existing) return fail(res, 404, "Not found");
  if (!h.canTogglePublished(existing))
    return fail(res, 403, "Toggle not allowed");

  const set = h.buildProviderToggleSet(nextPublished);
  const updated = await News.findOneAndUpdate(q, { $set: set }, { new: true });
  if (!updated) return fail(res, 404, "Not found");
  return ok(res, { item: h.mergeDraft(updated.toObject?.() || updated) });
}

async function providerDraft(res, q, safe) {
  const draft = h.pickDraftPatch(safe);
  const updated = await News.findOneAndUpdate(
    q,
    { $set: h.buildProviderDraftSet(draft) },
    { new: true },
  );
  if (!updated) return fail(res, 404, "Not found");
  return ok(res, { item: h.mergeDraft(updated.toObject?.() || updated) });
}

async function patchSuper(res, q, body) {
  if ("rejectionReason" in body)
    return superReject(res, q, body.rejectionReason);

  if (body.status === "approved" || body.published === true)
    return superApprove(res, q);

  if ("published" in body) return superToggle(res, q, Boolean(body.published));

  return superUpdate(res, q, body);
}

async function superReject(res, q, reason) {
  const r = h.clean(reason);
  if (!r) return fail(res, 400, "Reason required");

  const updated = await News.findOneAndUpdate(
    q,
    { $set: h.buildRejectSet(r) },
    { new: true },
  );
  if (!updated) return fail(res, 404, "Not found");
  return ok(res, { item: updated });
}

async function superApprove(res, q) {
  const existing = await News.findOne(q).lean();
  if (!existing) return fail(res, 404, "Not found");

  const set = h.buildApproveSet(existing);
  const updated = await News.findOneAndUpdate(q, { $set: set }, { new: true });
  if (!updated) return fail(res, 404, "Not found");
  return ok(res, { item: updated });
}

async function superToggle(res, q, nextPublished) {
  const existing = await News.findOne(q).lean();
  if (!existing) return fail(res, 404, "Not found");
  if (!h.canTogglePublished(existing))
    return fail(res, 403, "Toggle not allowed");

  const updated = await News.findOneAndUpdate(
    q,
    { $set: h.buildToggleSet(nextPublished) },
    { new: true },
  );
  if (!updated) return fail(res, 404, "Not found");
  return ok(res, { item: updated });
}

async function superUpdate(res, q, body) {
  const patch = { ...body };
  if ("status" in patch) delete patch.status;
  if (h.isContentEdit(patch)) patch.lastSuperEditAt = new Date();

  const updated = await News.findOneAndUpdate(q, patch, { new: true });
  if (!updated) return fail(res, 404, "Not found");
  return ok(res, { item: updated });
}

router.delete(
  "/:id",
  adminAuth,
  wrap(async (req, res) => {
    const auth = requireProvider(req);
    if (!auth.ok) return fail(res, auth.status, auth.error);

    const q = { _id: req.params.id };
    if (!h.isSuper(req)) q.providerId = auth.pid;

    const del = await News.findOneAndDelete(q);
    if (!del) return fail(res, 404, "Not found");
    return ok(res, {});
  }),
);

module.exports = router;

// // routes/adminNews.js
// "use strict";

// const express = require("express");
// const router = express.Router();
// const News = require("../models/News");
// const AdminUser = require("../models/AdminUser");
// const adminAuth = require("../middleware/adminAuth");
// const h = require("./adminNews.helpers");

// function sendJson(res, status, payload) {
//   return res.status(status).json(payload);
// }

// function ok(res, payload) {
//   return sendJson(res, 200, { ok: true, ...payload });
// }

// function fail(res, status, error) {
//   return sendJson(res, status, { ok: false, error });
// }

// function requireProvider(req) {
//   const pid = h.getProviderId(req);
//   if (!pid) return { ok: false, status: 401, error: "Unauthorized" };
//   return { ok: true, pid };
// }

// function wrap(fn) {
//   return (req, res) =>
//     Promise.resolve(fn(req, res)).catch((e) =>
//       fail(res, 500, h.clean(e?.message || "Error")),
//     );
// }

// router.get(
//   "/",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const { limit, page, view } = h.pickPaging(req);
//     const common = h.buildBaseFilters(req);

//     if (!h.isSuper(req))
//       return providerList(res, auth.pid, view, common, limit, page);
//     return superList(res, auth.pid, view, common, limit, page);
//   }),
// );

// async function providerList(res, pid, view, common, limit, page) {
//   const q = h.buildProviderViewQuery(view, pid, common);
//   const data = await h.pagedFind(News, q, limit, page);
//   data.items = data.items.map(h.mergeDraft);
//   data.items = await h.enrichProviders(AdminUser, data.items);
//   return ok(res, data);
// }

// async function superList(res, pid, view, common, limit, page) {
//   const qs = h.buildSuperQueries(pid, common);
//   if (view && view !== "combined")
//     return superSingle(res, qs, view, limit, page);
//   return superCombined(res, qs, limit, page);
// }

// async function superSingle(res, qs, view, limit, page) {
//   const q = mapSuperView(qs, view);
//   if (!q) return ok(res, { items: [], total: 0, page, pages: 1 });
//   const data = await h.pagedFind(News, q, limit, page);
//   data.items = await h.enrichProviders(AdminUser, data.items);
//   return ok(res, data);
// }

// function mapSuperView(qs, view) {
//   if (view === "mine") return qs.mine;
//   if (view === "provider_pending") return qs.providerPending;
//   if (view === "provider_approved") return qs.providerApproved;
//   if (view === "provider_rejected") return qs.providerRejected;
//   return null;
// }

// async function superCombined(res, qs, limit, page) {
//   const [mine, pending, approved, rejected] = await Promise.all([
//     h.pagedFind(News, qs.mine, limit, page),
//     h.pagedFind(News, qs.providerPending, limit, page),
//     h.pagedFind(News, qs.providerApproved, limit, page),
//     h.pagedFind(News, qs.providerRejected, limit, page),
//   ]);

//   mine.items = await h.enrichProviders(AdminUser, mine.items);
//   pending.items = await h.enrichProviders(AdminUser, pending.items);
//   approved.items = await h.enrichProviders(AdminUser, approved.items);
//   rejected.items = await h.enrichProviders(AdminUser, rejected.items);

//   return ok(res, {
//     combined: true,
//     mine,
//     providerPending: pending,
//     providerApproved: approved,
//     providerRejected: rejected,
//   });
// }

// router.post(
//   "/",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const body = h.normalizeBody(req.body || {});
//     const err = h.ensureCreateFields(body);
//     if (err) return fail(res, 400, err);

//     const payload = h.buildCreatePayload(auth.pid, body);
//     const saved = h.isSuper(req) ? await createAsSuper(payload) : payload;

//     const created = await News.create(saved);
//     return sendJson(res, 201, { ok: true, item: created });
//   }),
// );

// async function createAsSuper(payload) {
//   const set = h.buildApproveSet({ ...payload, draft: payload.draft });
//   return { ...payload, ...set, submittedAt: null };
// }

// router.patch(
//   "/:id",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const submitForReview = req.body?.submitForReview === true;
//     const body = h.normalizeBody({ ...(req.body || {}) });
//     delete body.submitForReview;

//     const q = { _id: req.params.id };
//     if (!h.isSuper(req))
//       return patchProvider(res, auth.pid, q, body, submitForReview);
//     return patchSuper(res, q, body);
//   }),
// );

// async function patchProvider(res, pid, q, body, submitForReview) {
//   q.providerId = pid;

//   if (submitForReview) return providerSubmit(res, q);

//   if (h.isOnlyPublishedPatch(body))
//     return providerToggle(res, q, Boolean(body.published));

//   const safe = h.stripProviderForbidden(body);
//   if (!h.isContentEdit(safe)) return fail(res, 400, "No changes");
//   return providerDraft(res, q, safe);
// }

// async function providerToggle(res, q, nextPublished) {
//   const existing = await News.findOne(q).lean();
//   if (!existing) return fail(res, 404, "Not found");
//   if (!h.canTogglePublished(existing))
//     return fail(res, 403, "Toggle not allowed");

//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildProviderToggleSet(nextPublished) },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// async function providerSubmit(res, q) {
//   const existing = await News.findOne(q).lean();
//   if (!existing) return fail(res, 404, "Not found");
//   if (!h.canSubmitForReview(existing))
//     return fail(res, 403, "Submit not allowed");

//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildProviderSubmitSet() },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, {
//     item: h.mergeDraft(updated.toObject ? updated.toObject() : updated),
//   });
// }

// async function providerDraft(res, q, safe) {
//   const draft = h.pickDraftPatch(safe);
//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildProviderDraftSet(draft) },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, {
//     item: h.mergeDraft(updated.toObject ? updated.toObject() : updated),
//   });
// }

// async function patchSuper(res, q, body) {
//   if ("rejectionReason" in body)
//     return superReject(res, q, body.rejectionReason);

//   if (body.status === "approved" || body.published === true)
//     return superApprove(res, q);

//   if ("published" in body) return superToggle(res, q, Boolean(body.published));
//   return superUpdate(res, q, body);
// }

// async function superReject(res, q, reason) {
//   const r = h.clean(reason);
//   if (!r) return fail(res, 400, "Reason required");

//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildRejectSet(r) },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// async function superApprove(res, q) {
//   const existing = await News.findOne(q).lean();
//   if (!existing) return fail(res, 404, "Not found");

//   const set = h.buildApproveSet(existing);
//   const updated = await News.findOneAndUpdate(q, { $set: set }, { new: true });
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// async function superToggle(res, q, nextPublished) {
//   const existing = await News.findOne(q).lean();
//   if (!existing) return fail(res, 404, "Not found");
//   if (!h.canTogglePublished(existing))
//     return fail(res, 403, "Toggle not allowed");

//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildToggleSet(nextPublished) },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// async function superUpdate(res, q, body) {
//   const patch = { ...body };
//   if ("status" in patch) delete patch.status;
//   if (h.isContentEdit(patch)) patch.lastSuperEditAt = new Date();

//   const updated = await News.findOneAndUpdate(q, patch, { new: true });
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// router.delete(
//   "/:id",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const q = { _id: req.params.id };
//     if (!h.isSuper(req)) q.providerId = auth.pid;

//     const del = await News.findOneAndDelete(q);
//     if (!del) return fail(res, 404, "Not found");
//     return ok(res, {});
//   }),
// );

// module.exports = router;

// // routes/adminNews.js
// "use strict";

// const express = require("express");
// const router = express.Router();

// const News = require("../models/News");
// const AdminUser = require("../models/AdminUser");
// const adminAuth = require("../middleware/adminAuth");

// const h = require("./adminNews.helpers");

// function sendJson(res, status, payload) {
//   return res.status(status).json(payload);
// }

// function ok(res, payload) {
//   return sendJson(res, 200, { ok: true, ...payload });
// }

// function fail(res, status, error) {
//   return sendJson(res, status, { ok: false, error });
// }

// function wrap(fn) {
//   return (req, res) =>
//     Promise.resolve(fn(req, res)).catch((e) =>
//       fail(res, 500, h.clean(e?.message || "Error")),
//     );
// }

// function requireProvider(req) {
//   const pid = h.getProviderId(req);
//   if (!pid) return { ok: false, status: 401, error: "Unauthorized" };
//   return { ok: true, pid };
// }

// router.get(
//   "/",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const { limit, page, view } = h.pickPaging(req);
//     const common = h.buildBaseFilters(req);

//     if (!h.isSuper(req)) {
//       const q = h.buildProviderViewQuery(view, auth.pid, common);
//       const data = await h.pagedFind(News, q, limit, page);
//       data.items = data.items.map(h.mergeDraft);
//       data.items = await h.enrichProviders(AdminUser, data.items);
//       return ok(res, data);
//     }

//     const qs = h.buildSuperQueries(auth.pid, common);
//     if (view && view !== "combined") {
//       const q = h.mapSuperView(qs, view);
//       if (!q) return ok(res, { items: [], total: 0, page, pages: 1 });
//       const data = await h.pagedFind(News, q, limit, page);
//       data.items = await h.enrichProviders(AdminUser, data.items);
//       return ok(res, data);
//     }

//     const [mine, pending, approved, rejected] = await Promise.all([
//       h.pagedFind(News, qs.mine, limit, page),
//       h.pagedFind(News, qs.providerPending, limit, page),
//       h.pagedFind(News, qs.providerApproved, limit, page),
//       h.pagedFind(News, qs.providerRejected, limit, page),
//     ]);

//     mine.items = await h.enrichProviders(AdminUser, mine.items);
//     pending.items = await h.enrichProviders(AdminUser, pending.items);
//     approved.items = await h.enrichProviders(AdminUser, approved.items);
//     rejected.items = await h.enrichProviders(AdminUser, rejected.items);

//     return ok(res, {
//       combined: true,
//       mine,
//       providerPending: pending,
//       providerApproved: approved,
//       providerRejected: rejected,
//     });
//   }),
// );

// router.post(
//   "/",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const body = h.normalizeBody(req.body || {});
//     const err = h.ensureCreateFields(body);
//     if (err) return fail(res, 400, err);

//     const payload = h.buildCreatePayload(auth.pid, body);
//     const createPayload = h.isSuper(req)
//       ? h.buildSuperCreatePayload(payload)
//       : payload;

//     const created = await News.create(createPayload);
//     return sendJson(res, 201, { ok: true, item: created });
//   }),
// );

// router.patch(
//   "/:id",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const id = h.clean(req.params.id);
//     if (!id) return fail(res, 400, "Bad request");

//     const submitForReview = req.body?.submitForReview === true;
//     const body = h.normalizeBody({ ...(req.body || {}) });
//     delete body.submitForReview;

//     const q = { _id: id };

//     if (!h.isSuper(req)) {
//       q.providerId = auth.pid;
//       const safe = h.stripProviderForbidden(body);

//       if (submitForReview) {
//         const existing = await News.findOne(q).lean();
//         if (!existing) return fail(res, 404, "Not found");
//         if (!h.canSubmitForReview(existing))
//           return fail(res, 403, "Submit not allowed");

//         const set = h.buildProviderSubmitSet(existing);
//         const updated = await News.findOneAndUpdate(
//           q,
//           { $set: set },
//           { new: true },
//         );
//         if (!updated) return fail(res, 404, "Not found");

//         const out = h.mergeDraft(
//           updated.toObject ? updated.toObject() : updated,
//         );
//         return ok(res, { item: out });
//       }

//       if (!h.isContentEdit(safe)) return fail(res, 400, "No changes");

//       const existing = await News.findOne(q).lean();
//       if (!existing) return fail(res, 404, "Not found");

//       const draftPatch = h.pickDraftPatch(safe);
//       const set = h.buildProviderDraftSet(existing, draftPatch);

//       const updated = await News.findOneAndUpdate(
//         q,
//         { $set: set },
//         { new: true },
//       );
//       if (!updated) return fail(res, 404, "Not found");

//       const out = h.mergeDraft(updated.toObject ? updated.toObject() : updated);
//       return ok(res, { item: out });
//     }

//     if ("rejectionReason" in body) {
//       const reason = h.clean(body.rejectionReason);
//       if (!reason) return fail(res, 400, "Reason required");

//       const updated = await News.findOneAndUpdate(
//         q,
//         { $set: h.buildRejectSet(reason) },
//         { new: true },
//       );
//       if (!updated) return fail(res, 404, "Not found");
//       return ok(res, { item: updated });
//     }

//     if (body.status === "approved" || body.published === true) {
//       const existing = await News.findOne(q).lean();
//       if (!existing) return fail(res, 404, "Not found");

//       const set = h.buildApproveSet(existing);
//       const updated = await News.findOneAndUpdate(
//         q,
//         { $set: set },
//         { new: true },
//       );
//       if (!updated) return fail(res, 404, "Not found");
//       return ok(res, { item: updated });
//     }

//     if ("published" in body) {
//       const existing = await News.findOne(q).lean();
//       if (!existing) return fail(res, 404, "Not found");
//       if (!h.canTogglePublished(existing))
//         return fail(res, 403, "Toggle not allowed");

//       const set = h.buildToggleSet(Boolean(body.published));
//       const updated = await News.findOneAndUpdate(
//         q,
//         { $set: set },
//         { new: true },
//       );
//       if (!updated) return fail(res, 404, "Not found");
//       return ok(res, { item: updated });
//     }

//     const patch = { ...body };
//     if ("status" in patch) delete patch.status;
//     if (h.isContentEdit(patch)) patch.lastSuperEditAt = new Date();

//     const updated = await News.findOneAndUpdate(q, patch, { new: true });
//     if (!updated) return fail(res, 404, "Not found");
//     return ok(res, { item: updated });
//   }),
// );

// router.delete(
//   "/:id",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const id = h.clean(req.params.id);
//     if (!id) return fail(res, 400, "Bad request");

//     const q = { _id: id };
//     if (!h.isSuper(req)) q.providerId = auth.pid;

//     const del = await News.findOneAndDelete(q);
//     if (!del) return fail(res, 404, "Not found");
//     return ok(res, {});
//   }),
// );

// module.exports = router;

// // routes/adminNews.js
// "use strict";

// const express = require("express");
// const router = express.Router();
// const News = require("../models/News");
// const AdminUser = require("../models/AdminUser");
// const adminAuth = require("../middleware/adminAuth");
// const h = require("./adminNews.helpers");

// function sendJson(res, status, payload) {
//   return res.status(status).json(payload);
// }

// function ok(res, payload) {
//   return sendJson(res, 200, { ok: true, ...payload });
// }

// function fail(res, status, error) {
//   return sendJson(res, status, { ok: false, error });
// }

// function requireProvider(req) {
//   const pid = h.getProviderId(req);
//   if (!pid) return { ok: false, status: 401, error: "Unauthorized" };
//   return { ok: true, pid };
// }

// function wrap(fn) {
//   return (req, res) =>
//     Promise.resolve(fn(req, res)).catch((e) =>
//       fail(res, 500, h.clean(e?.message || "Error")),
//     );
// }

// router.get(
//   "/",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const { limit, page, view } = h.pickPaging(req);
//     const common = h.buildBaseFilters(req);
//     if (!h.isSuper(req))
//       return providerList(res, auth.pid, view, common, limit, page);
//     return superList(res, auth.pid, view, common, limit, page);
//   }),
// );

// async function providerList(res, pid, view, common, limit, page) {
//   const q = h.buildProviderViewQuery(view, pid, common);
//   const data = await h.pagedFind(News, q, limit, page);
//   data.items = data.items.map(h.mergeDraft);
//   data.items = await h.enrichProviders(AdminUser, data.items);
//   return ok(res, data);
// }

// async function superList(res, pid, view, common, limit, page) {
//   const qs = h.buildSuperQueries(pid, common);
//   if (view && view !== "combined")
//     return superSingle(res, qs, view, limit, page);
//   return superCombined(res, qs, limit, page);
// }

// async function superSingle(res, qs, view, limit, page) {
//   const q = mapSuperView(qs, view);
//   if (!q) return ok(res, { items: [], total: 0, page, pages: 1 });
//   const data = await h.pagedFind(News, q, limit, page);
//   data.items = await h.enrichProviders(AdminUser, data.items);
//   return ok(res, data);
// }

// function mapSuperView(qs, view) {
//   if (view === "mine") return qs.mine;
//   if (view === "provider_pending") return qs.providerPending;
//   if (view === "provider_approved") return qs.providerApproved;
//   if (view === "provider_rejected") return qs.providerRejected;
//   return null;
// }

// async function superCombined(res, qs, limit, page) {
//   const [mine, pending, approved, rejected] = await Promise.all([
//     h.pagedFind(News, qs.mine, limit, page),
//     h.pagedFind(News, qs.providerPending, limit, page),
//     h.pagedFind(News, qs.providerApproved, limit, page),
//     h.pagedFind(News, qs.providerRejected, limit, page),
//   ]);

//   mine.items = await h.enrichProviders(AdminUser, mine.items);
//   pending.items = await h.enrichProviders(AdminUser, pending.items);
//   approved.items = await h.enrichProviders(AdminUser, approved.items);
//   rejected.items = await h.enrichProviders(AdminUser, rejected.items);

//   return ok(res, {
//     combined: true,
//     mine,
//     providerPending: pending,
//     providerApproved: approved,
//     providerRejected: rejected,
//   });
// }

// router.post(
//   "/",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const body = h.normalizeBody(req.body || {});
//     const err = h.ensureCreateFields(body);
//     if (err) return fail(res, 400, err);

//     const payload = h.buildCreatePayload(auth.pid, body);
//     const saved = h.isSuper(req) ? await createAsSuper(payload) : payload;

//     const created = await News.create(saved);
//     return sendJson(res, 201, { ok: true, item: created });
//   }),
// );

// async function createAsSuper(payload) {
//   const set = h.buildApproveSet({
//     ...payload,
//     draft: payload.draft,
//     approvedAt: null,
//   });
//   return { ...payload, ...set, submittedAt: null };
// }

// router.patch(
//   "/:id",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const submitForReview = req.body?.submitForReview === true;
//     const body = h.normalizeBody({ ...(req.body || {}) });
//     delete body.submitForReview;

//     const q = { _id: req.params.id };
//     if (!h.isSuper(req))
//       return patchProvider(res, auth.pid, q, body, submitForReview);
//     return patchSuper(res, q, body);
//   }),
// );

// async function patchProvider(res, pid, q, body, submitForReview) {
//   q.providerId = pid;
//   const safe = h.stripProviderForbidden(body);
//   if (submitForReview) return providerSubmit(res, q);
//   if (!h.isContentEdit(safe)) return fail(res, 400, "No changes");
//   return providerDraft(res, q, safe);
// }

// async function providerSubmit(res, q) {
//   const existing = await News.findOne(q).lean();
//   if (!existing) return fail(res, 404, "Not found");
//   if (!h.canSubmitForReview(existing))
//     return fail(res, 403, "Submit not allowed");

//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildProviderSubmitSet() },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, {
//     item: h.mergeDraft(updated.toObject ? updated.toObject() : updated),
//   });
// }

// async function providerDraft(res, q, safe) {
//   const draft = h.pickDraftPatch(safe);
//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildProviderDraftSet(draft) },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, {
//     item: h.mergeDraft(updated.toObject ? updated.toObject() : updated),
//   });
// }

// async function patchSuper(res, q, body) {
//   if ("rejectionReason" in body)
//     return superReject(res, q, body.rejectionReason);
//   if (body.status === "approved" || body.published === true)
//     return superApprove(res, q);
//   if ("published" in body) return superToggle(res, q, Boolean(body.published));
//   return superUpdate(res, q, body);
// }

// async function superReject(res, q, reason) {
//   const r = h.clean(reason);
//   if (!r) return fail(res, 400, "Reason required");

//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildRejectSet(r) },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// async function superApprove(res, q) {
//   const existing = await News.findOne(q).lean();
//   if (!existing) return fail(res, 404, "Not found");

//   const set = h.buildApproveSet(existing);
//   const updated = await News.findOneAndUpdate(q, { $set: set }, { new: true });
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// async function superToggle(res, q, nextPublished) {
//   const existing = await News.findOne(q).lean();
//   if (!existing) return fail(res, 404, "Not found");
//   if (!h.canTogglePublished(existing))
//     return fail(res, 403, "Toggle not allowed");

//   const updated = await News.findOneAndUpdate(
//     q,
//     { $set: h.buildToggleSet(nextPublished) },
//     { new: true },
//   );
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// async function superUpdate(res, q, body) {
//   const patch = { ...body };
//   if ("status" in patch) delete patch.status;
//   if (h.isContentEdit(patch)) patch.lastSuperEditAt = new Date();

//   const updated = await News.findOneAndUpdate(q, patch, { new: true });
//   if (!updated) return fail(res, 404, "Not found");
//   return ok(res, { item: updated });
// }

// router.delete(
//   "/:id",
//   adminAuth,
//   wrap(async (req, res) => {
//     const auth = requireProvider(req);
//     if (!auth.ok) return fail(res, auth.status, auth.error);

//     const q = { _id: req.params.id };
//     if (!h.isSuper(req)) q.providerId = auth.pid;

//     const del = await News.findOneAndDelete(q);
//     if (!del) return fail(res, 404, "Not found");
//     return ok(res, {});
//   }),
// );

// module.exports = router;
