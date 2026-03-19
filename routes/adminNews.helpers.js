// routes/adminNews.helpers.js
"use strict";

const allowedCategories = ["Allgemein", "News", "Partnerverein", "Projekte"];

const displayFields = [
  "title",
  "slug",
  "excerpt",
  "content",
  "coverImage",
  "category",
  "tags",
  "media",
];

function clean(v) {
  return String(v ?? "").trim();
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isSuper(req) {
  return req.isSuperAdmin === true || clean(req.role) === "super";
}

function getProviderId(req) {
  return clean(req.providerId);
}

function normCategory(val) {
  const v = clean(val);
  return allowedCategories.includes(v) ? v : "News";
}

function normTags(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(clean).filter(Boolean);
}

function normTagsSafe(v) {
  if (Array.isArray(v)) return normTags(v);
  const s = clean(v);
  if (!s) return [];
  return s.split(",").map(clean).filter(Boolean);
}

function isVideoUrl(u) {
  return /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(String(u || ""));
}

function isVideoMime(m) {
  return /^video\//i.test(String(m || ""));
}

function mapMediaItem(m) {
  const url = clean(m?.url);
  const isVideo =
    m?.type === "video" || isVideoUrl(url) || isVideoMime(m?.mimetype);
  return {
    type: isVideo ? "video" : "image",
    url,
    alt: String(m?.alt || ""),
    title: String(m?.title || ""),
  };
}

function normMedia(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(mapMediaItem).filter((m) => Boolean(m.url));
}

function normalizeBody(raw) {
  const body = { ...(raw || {}) };
  if ("title" in body) body.title = clean(body.title);
  if ("slug" in body) body.slug = clean(body.slug);
  if ("excerpt" in body) body.excerpt = String(body.excerpt || "");
  if ("content" in body) body.content = String(body.content || "");
  if ("coverImage" in body) body.coverImage = String(body.coverImage || "");
  if ("category" in body) body.category = normCategory(body.category);
  if ("tags" in body) body.tags = normTagsSafe(body.tags);
  if ("media" in body) body.media = normMedia(body.media);
  if ("published" in body) body.published = Boolean(body.published);
  if ("status" in body) body.status = clean(body.status);
  if ("rejectionReason" in body)
    body.rejectionReason = clean(body.rejectionReason);
  return body;
}

function isContentEdit(body) {
  return displayFields.some((k) => k in (body || {}));
}

function pickDraftPatch(body) {
  const d = {};
  for (const k of displayFields) if (k in body) d[k] = body[k];
  return d;
}

function mergeDraft(doc) {
  if (!doc?.draft) return doc;
  const out = { ...doc };
  for (const k of displayFields) if (k in doc.draft) out[k] = doc.draft[k];
  return out;
}

function legacyStatus(it) {
  if (clean(it?.rejectionReason)) return "rejected";
  if (it?.approvedAt) return "approved";
  if (it?.submittedAt) return "pending";
  return it?.published === true ? "approved" : "pending";
}

function readStatus(it) {
  const s = clean(it?.status);
  if (s === "pending" || s === "approved" || s === "rejected") return s;
  return legacyStatus(it);
}

function hasDraftChanges(it) {
  const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
  const l = it?.liveUpdatedAt ? new Date(it.liveUpdatedAt).getTime() : 0;
  return Boolean(d && (!l || d > l));
}

function editedAfterReject(it) {
  const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
  const r = it?.rejectedAt ? new Date(it.rejectedAt).getTime() : 0;
  return Boolean(d && r && d > r);
}

function canSubmitForReview(it) {
  const st = readStatus(it);
  if (st === "rejected") return editedAfterReject(it);
  if (st === "approved") return hasDraftChanges(it);
  return hasDraftChanges(it) || Boolean(it?.hasDraft);
}

function canTogglePublished(it) {
  return readStatus(it) === "approved";
}

function isOnlyPublishedPatch(body) {
  const keys = Object.keys(body || {});
  return keys.length === 1 && keys[0] === "published";
}

function buildBaseFilters(req) {
  const search = clean(req.query.search);
  const category = clean(req.query.category);
  const tag = clean(req.query.tag);
  return buildFilters(search, category, tag);
}

function buildFilters(search, category, tag) {
  const q = {};
  if (search) q.$or = buildSearchOr(search);
  if (category) q.category = category;
  if (tag) q.tags = tag;
  return q;
}

function buildSearchOr(search) {
  return [
    { title: { $regex: search, $options: "i" } },
    { excerpt: { $regex: search, $options: "i" } },
    { content: { $regex: search, $options: "i" } },
  ];
}

function buildProviderViewQuery(view, pid, common) {
  const base = { ...common, providerId: pid };
  if (view === "mine_pending") return { ...base, submittedAt: { $ne: null } };
  if (view === "mine_approved") return { ...base, status: "approved" };
  if (view === "mine_rejected") return { ...base, status: "rejected" };
  return base;
}

function buildSuperQueries(pid, common) {
  return {
    mine: { ...common, providerId: pid },
    providerPending: {
      ...common,
      providerId: { $ne: pid },
      submittedAt: { $ne: null },
    },
    providerApproved: {
      ...common,
      providerId: { $ne: pid },
      status: "approved",
    },
    providerRejected: {
      ...common,
      providerId: { $ne: pid },
      status: "rejected",
    },
  };
}

function pickPaging(req) {
  const limit = Math.min(toInt(req.query.limit, 10), 50);
  const page = Math.max(toInt(req.query.page, 1), 1);
  const view = clean(req.query.view);
  return { limit, page, view };
}

async function pagedFind(NewsModel, q, limit, page) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    NewsModel.find(q)
      .sort({ date: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    NewsModel.countDocuments(q),
  ]);
  const pages = Math.max(Math.ceil(total / limit) || 1, 1);
  return { items, total, page, pages };
}

async function enrichProviders(AdminUserModel, items) {
  if (!Array.isArray(items) || !items.length) return items;
  const ids = uniqueProviderIds(items);
  if (!ids.length) return items;
  const users = await loadProviders(AdminUserModel, ids);
  return attachProviders(items, users);
}

function uniqueProviderIds(items) {
  const ids = items.map((it) => clean(it?.providerId)).filter(Boolean);
  return Array.from(new Set(ids));
}

function loadProviders(AdminUserModel, ids) {
  return AdminUserModel.find({ _id: { $in: ids } })
    .select("_id fullName email")
    .lean();
}

function attachProviders(items, users) {
  const map = new Map(users.map((u) => [clean(u._id), u]));
  return items.map((it) => ({ ...it, provider: buildProvider(map, it) }));
}

function buildProvider(map, it) {
  const pid = clean(it?.providerId);
  const u = pid ? map.get(pid) : null;
  if (!pid) return null;
  if (!u) return { id: pid, fullName: "", email: "" };
  return { id: clean(u._id), fullName: u.fullName || "", email: u.email || "" };
}

function buildCreatePayload(pid, body) {
  const now = new Date();
  return {
    providerId: pid,
    date: body.date,
    title: body.title,
    slug: body.slug,
    excerpt: body.excerpt || "",
    content: body.content || "",
    coverImage: body.coverImage || "",
    media: body.media || [],
    category: body.category,
    tags: body.tags || [],
    status: "pending",
    published: false,
    everPublished: false,
    approvedAt: null,
    liveUpdatedAt: null,
    submittedAt: now,
    rejectionReason: "",
    rejectedAt: null,
    lastProviderEditAt: now,
    lastSuperEditAt: null,
    hasDraft: true,
    draftUpdatedAt: now,
    draft: pickDraftPatch(body),
  };
}

function buildRejectSet(reason) {
  const now = new Date();
  return {
    status: "rejected",
    published: false,
    submittedAt: null,
    rejectionReason: clean(reason),
    rejectedAt: now,
    lastSuperEditAt: now,
  };
}

function buildToggleSet(nextPublished) {
  return { published: Boolean(nextPublished), lastSuperEditAt: new Date() };
}

function buildProviderToggleSet(nextPublished) {
  return { published: Boolean(nextPublished), lastProviderEditAt: new Date() };
}

function buildProviderSubmitSet(existing) {
  const now = new Date();
  const everApproved = Boolean(existing?.approvedAt);
  return {
    status: everApproved ? "approved" : "pending",
    published: everApproved ? Boolean(existing?.published) : false,
    submittedAt: now,
    rejectionReason: "",
    rejectedAt: null,
    lastProviderEditAt: now,
  };
}

function buildProviderDraftSet(draft) {
  const now = new Date();
  return {
    draft,
    hasDraft: true,
    draftUpdatedAt: now,
    lastProviderEditAt: now,
  };
}

function mergeDraftIntoLive(existing) {
  const d = existing?.draft || {};
  const out = {};
  for (const k of displayFields) out[k] = k in d ? d[k] : existing[k];
  return out;
}

function approveMeta(existing, now) {
  return {
    status: "approved",
    published: true,
    everPublished: true,
    submittedAt: null,
    rejectionReason: "",
    rejectedAt: null,
    approvedAt: existing.approvedAt ? existing.approvedAt : now,
    liveUpdatedAt: now,
  };
}

function clearDraft(now) {
  return {
    hasDraft: false,
    draftUpdatedAt: null,
    draft: {},
    correctionRequired: false,
    correctionFixedAt: now,
  };
}

function buildApproveSet(existing) {
  const now = new Date();
  const merged = mergeDraftIntoLive(existing);
  return {
    ...merged,
    ...approveMeta(existing, now),
    ...clearDraft(now),
    lastSuperEditAt: now,
  };
}

function ensureCreateFields(body) {
  if (!body?.title || !body?.slug) return "Title and slug are required";
  return "";
}

function stripProviderForbidden(body) {
  const blocked = [
    "status",
    "published",
    "rejectionReason",
    "rejectedAt",
    "approvedAt",
    "liveUpdatedAt",
    "submittedAt",
  ];
  const out = { ...body };
  for (const k of blocked) if (k in out) delete out[k];
  return out;
}

module.exports = {
  clean,
  isSuper,
  getProviderId,
  normalizeBody,
  isContentEdit,
  pickDraftPatch,
  mergeDraft,
  readStatus,
  canSubmitForReview,
  canTogglePublished,
  isOnlyPublishedPatch,
  buildBaseFilters,
  buildProviderViewQuery,
  buildSuperQueries,
  pickPaging,
  pagedFind,
  enrichProviders,
  buildCreatePayload,
  buildRejectSet,
  buildToggleSet,
  buildProviderToggleSet,
  buildProviderSubmitSet,
  buildProviderDraftSet,
  buildApproveSet,
  ensureCreateFields,
  stripProviderForbidden,
};

// // routes/adminNews.helpers.js
// "use strict";

// const allowedCategories = ["Allgemein", "News", "Partnerverein", "Projekte"];
// const displayFields = [
//   "title",
//   "slug",
//   "excerpt",
//   "content",
//   "coverImage",
//   "category",
//   "tags",
//   "media",
// ];

// function clean(v) {
//   return String(v ?? "").trim();
// }

// function toInt(v, fallback) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function isSuper(req) {
//   return req.isSuperAdmin === true || clean(req.role) === "super";
// }

// function getProviderId(req) {
//   return clean(req.providerId);
// }

// function normCategory(val) {
//   const v = clean(val);
//   return allowedCategories.includes(v) ? v : "News";
// }

// function normTags(arr) {
//   if (!Array.isArray(arr)) return [];
//   return arr.map(clean).filter(Boolean);
// }

// function normTagsSafe(v) {
//   if (Array.isArray(v)) return normTags(v);
//   const s = clean(v);
//   if (!s) return [];
//   return s.split(",").map(clean).filter(Boolean);
// }

// function isVideoUrl(u) {
//   return /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(String(u || ""));
// }

// function isVideoMime(m) {
//   return /^video\//i.test(String(m || ""));
// }

// function mapMediaItem(m) {
//   const url = clean(m?.url);
//   const isVideo =
//     m?.type === "video" || isVideoUrl(url) || isVideoMime(m?.mimetype);
//   return {
//     type: isVideo ? "video" : "image",
//     url,
//     alt: String(m?.alt || ""),
//     title: String(m?.title || ""),
//   };
// }

// function normMedia(arr) {
//   if (!Array.isArray(arr)) return [];
//   return arr.map(mapMediaItem).filter((m) => Boolean(m.url));
// }

// function normalizeBody(raw) {
//   const body = { ...(raw || {}) };
//   if ("title" in body) body.title = clean(body.title);
//   if ("slug" in body) body.slug = clean(body.slug);
//   if ("excerpt" in body) body.excerpt = String(body.excerpt || "");
//   if ("content" in body) body.content = String(body.content || "");
//   if ("coverImage" in body) body.coverImage = String(body.coverImage || "");
//   if ("category" in body) body.category = normCategory(body.category);
//   if ("tags" in body) body.tags = normTagsSafe(body.tags);
//   if ("media" in body) body.media = normMedia(body.media);
//   if ("published" in body) body.published = Boolean(body.published);
//   if ("status" in body) body.status = clean(body.status);
//   if ("rejectionReason" in body)
//     body.rejectionReason = clean(body.rejectionReason);
//   return body;
// }

// function isContentEdit(body) {
//   return displayFields.some((k) => k in (body || {}));
// }

// function pickDraftPatch(body) {
//   const d = {};
//   for (const k of displayFields) if (k in body) d[k] = body[k];
//   return d;
// }

// function mergeDraft(doc) {
//   if (!doc?.draft) return doc;
//   const out = { ...doc };
//   for (const k of displayFields) if (k in doc.draft) out[k] = doc.draft[k];
//   return out;
// }

// function legacyStatus(it) {
//   if (clean(it?.rejectionReason)) return "rejected";
//   if (it?.approvedAt) return "approved";
//   if (it?.submittedAt) return "pending";
//   return it?.published === true ? "approved" : "pending";
// }

// function readStatus(it) {
//   const s = clean(it?.status);
//   if (s === "pending" || s === "approved" || s === "rejected") return s;
//   return legacyStatus(it);
// }

// function hasDraftChanges(it) {
//   const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
//   const l = it?.liveUpdatedAt ? new Date(it.liveUpdatedAt).getTime() : 0;
//   return Boolean(d && (!l || d > l));
// }

// function editedAfterReject(it) {
//   const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
//   const r = it?.rejectedAt ? new Date(it.rejectedAt).getTime() : 0;
//   return Boolean(d && r && d > r);
// }

// function canSubmitForReview(it) {
//   const st = readStatus(it);
//   if (st === "rejected") return editedAfterReject(it);
//   if (st === "approved") return hasDraftChanges(it);
//   return hasDraftChanges(it) || Boolean(it?.hasDraft);
// }

// function canTogglePublished(it) {
//   return readStatus(it) === "approved";
// }

// function buildBaseFilters(req) {
//   const search = clean(req.query.search);
//   const category = clean(req.query.category);
//   const tag = clean(req.query.tag);
//   return buildFilters(search, category, tag);
// }

// function buildFilters(search, category, tag) {
//   const q = {};
//   if (search) q.$or = buildSearchOr(search);
//   if (category) q.category = category;
//   if (tag) q.tags = tag;
//   return q;
// }

// function buildSearchOr(search) {
//   return [
//     { title: { $regex: search, $options: "i" } },
//     { excerpt: { $regex: search, $options: "i" } },
//     { content: { $regex: search, $options: "i" } },
//   ];
// }

// function buildProviderViewQuery(view, pid, common) {
//   const base = { ...common, providerId: pid };
//   if (view === "mine_pending") return { ...base, status: "pending" };
//   if (view === "mine_approved") return { ...base, status: "approved" };
//   if (view === "mine_rejected") return { ...base, status: "rejected" };
//   return base;
// }

// function buildSuperQueries(pid, common) {
//   return {
//     mine: { ...common, providerId: pid },
//     providerPending: { ...common, providerId: { $ne: pid }, status: "pending" },
//     providerApproved: {
//       ...common,
//       providerId: { $ne: pid },
//       status: "approved",
//     },
//     providerRejected: {
//       ...common,
//       providerId: { $ne: pid },
//       status: "rejected",
//     },
//   };
// }

// function pickPaging(req) {
//   const limit = Math.min(toInt(req.query.limit, 10), 50);
//   const page = Math.max(toInt(req.query.page, 1), 1);
//   const view = clean(req.query.view);
//   return { limit, page, view };
// }

// async function pagedFind(NewsModel, q, limit, page) {
//   const skip = (page - 1) * limit;
//   const [items, total] = await Promise.all([
//     NewsModel.find(q)
//       .sort({ date: -1, _id: -1 })
//       .skip(skip)
//       .limit(limit)
//       .lean(),
//     NewsModel.countDocuments(q),
//   ]);
//   const pages = Math.max(Math.ceil(total / limit) || 1, 1);
//   return { items, total, page, pages };
// }

// async function enrichProviders(AdminUserModel, items) {
//   if (!Array.isArray(items) || !items.length) return items;
//   const ids = uniqueProviderIds(items);
//   if (!ids.length) return items;
//   const users = await loadProviders(AdminUserModel, ids);
//   return attachProviders(items, users);
// }

// function uniqueProviderIds(items) {
//   const ids = items.map((it) => clean(it?.providerId)).filter(Boolean);
//   return Array.from(new Set(ids));
// }

// function loadProviders(AdminUserModel, ids) {
//   return AdminUserModel.find({ _id: { $in: ids } })
//     .select("_id fullName email")
//     .lean();
// }

// function attachProviders(items, users) {
//   const map = new Map(users.map((u) => [clean(u._id), u]));
//   return items.map((it) => ({ ...it, provider: buildProvider(map, it) }));
// }

// function buildProvider(map, it) {
//   const pid = clean(it?.providerId);
//   const u = pid ? map.get(pid) : null;
//   if (!pid) return null;
//   if (!u) return { id: pid, fullName: "", email: "" };
//   return { id: clean(u._id), fullName: u.fullName || "", email: u.email || "" };
// }

// function buildCreatePayload(pid, body) {
//   const now = new Date();
//   return {
//     providerId: pid,
//     date: body.date,
//     title: body.title,
//     slug: body.slug,
//     excerpt: body.excerpt || "",
//     content: body.content || "",
//     coverImage: body.coverImage || "",
//     media: body.media || [],
//     category: body.category,
//     tags: body.tags || [],
//     status: "pending",
//     published: false,
//     everPublished: false,
//     approvedAt: null,
//     liveUpdatedAt: null,
//     submittedAt: now,
//     rejectionReason: "",
//     rejectedAt: null,
//     lastProviderEditAt: now,
//     lastSuperEditAt: null,
//     hasDraft: true,
//     draftUpdatedAt: now,
//     draft: pickDraftPatch(body),
//   };
// }

// function buildRejectSet(reason) {
//   const now = new Date();
//   return {
//     status: "rejected",
//     published: false,
//     submittedAt: null,
//     rejectionReason: clean(reason),
//     rejectedAt: now,
//     lastSuperEditAt: now,
//   };
// }

// function buildToggleSet(nextPublished) {
//   return { published: Boolean(nextPublished), lastSuperEditAt: new Date() };
// }

// function buildProviderToggleSet(nextPublished) {
//   return { published: Boolean(nextPublished), lastProviderEditAt: new Date() };
// }

// function buildProviderSubmitSet() {
//   const now = new Date();
//   return {
//     status: "pending",
//     submittedAt: now,
//     rejectionReason: "",
//     rejectedAt: null,
//     lastProviderEditAt: now,
//   };
// }

// function buildProviderDraftSet(draft) {
//   const now = new Date();
//   return {
//     draft,
//     hasDraft: true,
//     draftUpdatedAt: now,
//     lastProviderEditAt: now,
//   };
// }

// function buildApproveSet(existing) {
//   const now = new Date();
//   const merged = mergeDraftIntoLive(existing);
//   return {
//     ...merged,
//     ...approveMeta(existing, now),
//     ...clearDraft(now),
//     lastSuperEditAt: now,
//   };
// }

// function mergeDraftIntoLive(existing) {
//   const d = existing?.draft || {};
//   const out = {};
//   for (const k of displayFields) out[k] = k in d ? d[k] : existing[k];
//   return out;
// }

// function approveMeta(existing, now) {
//   return {
//     status: "approved",
//     published: true,
//     everPublished: true,
//     submittedAt: null,
//     rejectionReason: "",
//     rejectedAt: null,
//     approvedAt: existing.approvedAt ? existing.approvedAt : now,
//     liveUpdatedAt: now,
//   };
// }

// function clearDraft(now) {
//   return {
//     hasDraft: false,
//     draftUpdatedAt: null,
//     draft: {},
//     correctionRequired: false,
//     correctionFixedAt: now,
//   };
// }

// function ensureCreateFields(body) {
//   if (!body?.title || !body?.slug) return "Title and slug are required";
//   return "";
// }

// function stripProviderForbidden(body) {
//   const blocked = [
//     "status",
//     "published",
//     "rejectionReason",
//     "rejectedAt",
//     "approvedAt",
//     "liveUpdatedAt",
//     "submittedAt",
//   ];
//   const out = { ...body };
//   for (const k of blocked) if (k in out) delete out[k];
//   return out;
// }

// function isOnlyPublishedPatch(body) {
//   if (!body || typeof body !== "object") return false;
//   const keys = Object.keys(body);
//   if (keys.length !== 1) return false;
//   return keys[0] === "published";
// }

// module.exports = {
//   clean,
//   isSuper,
//   getProviderId,
//   normalizeBody,
//   isContentEdit,
//   pickDraftPatch,
//   mergeDraft,
//   readStatus,
//   canSubmitForReview,
//   canTogglePublished,
//   buildBaseFilters,
//   buildProviderViewQuery,
//   buildSuperQueries,
//   pickPaging,
//   pagedFind,
//   enrichProviders,
//   buildCreatePayload,
//   buildRejectSet,
//   buildToggleSet,
//   buildProviderToggleSet,
//   buildProviderSubmitSet,
//   buildProviderDraftSet,
//   buildApproveSet,
//   ensureCreateFields,
//   stripProviderForbidden,
//   isOnlyPublishedPatch,
// };

// // routes/adminNews.helpers.js
// "use strict";

// const allowedCategories = ["Allgemein", "News", "Partnerverein", "Projekte"];

// const displayFields = [
//   "title",
//   "slug",
//   "excerpt",
//   "content",
//   "coverImage",
//   "category",
//   "tags",
//   "media",
// ];

// function clean(v) {
//   return String(v ?? "").trim();
// }

// function toInt(v, fallback) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function isSuper(req) {
//   return req.isSuperAdmin === true || clean(req.role) === "super";
// }

// function getProviderId(req) {
//   return clean(req.providerId);
// }

// function normCategory(val) {
//   const v = clean(val);
//   return allowedCategories.includes(v) ? v : "News";
// }

// function normTags(arr) {
//   if (!Array.isArray(arr)) return [];
//   return arr.map(clean).filter(Boolean);
// }

// function normTagsSafe(v) {
//   if (Array.isArray(v)) return normTags(v);
//   const s = clean(v);
//   if (!s) return [];
//   return s.split(",").map(clean).filter(Boolean);
// }

// function isVideoUrl(u) {
//   return /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(String(u || ""));
// }

// function isVideoMime(m) {
//   return /^video\//i.test(String(m || ""));
// }

// function mapMediaItem(m) {
//   const url = clean(m?.url);
//   const isVideo =
//     m?.type === "video" || isVideoUrl(url) || isVideoMime(m?.mimetype);
//   return {
//     type: isVideo ? "video" : "image",
//     url,
//     alt: String(m?.alt || ""),
//     title: String(m?.title || ""),
//   };
// }

// function normMedia(arr) {
//   if (!Array.isArray(arr)) return [];
//   return arr.map(mapMediaItem).filter((m) => Boolean(m.url));
// }

// function normalizeBody(raw) {
//   const body = { ...(raw || {}) };

//   if ("date" in body) body.date = body.date ? new Date(body.date) : body.date;
//   if ("title" in body) body.title = clean(body.title);
//   if ("slug" in body) body.slug = clean(body.slug);
//   if ("excerpt" in body) body.excerpt = String(body.excerpt || "");
//   if ("content" in body) body.content = String(body.content || "");
//   if ("coverImage" in body) body.coverImage = String(body.coverImage || "");
//   if ("category" in body) body.category = normCategory(body.category);
//   if ("tags" in body) body.tags = normTagsSafe(body.tags);
//   if ("media" in body) body.media = normMedia(body.media);

//   if ("published" in body) body.published = Boolean(body.published);
//   if ("status" in body) body.status = clean(body.status);
//   if ("rejectionReason" in body)
//     body.rejectionReason = clean(body.rejectionReason);

//   return body;
// }

// function isContentEdit(body) {
//   return displayFields.some((k) => k in (body || {}));
// }

// function pickDraftPatch(body) {
//   const d = {};
//   for (const k of displayFields) if (k in body) d[k] = body[k];
//   return d;
// }

// function mergeDraft(doc) {
//   if (!doc?.draft) return doc;
//   const out = { ...doc };
//   for (const k of displayFields) if (k in doc.draft) out[k] = doc.draft[k];
//   return out;
// }

// function legacyStatus(it) {
//   if (clean(it?.rejectionReason)) return "rejected";
//   if (it?.approvedAt) return "approved";
//   if (it?.submittedAt) return "pending";
//   return it?.published === true ? "approved" : "pending";
// }

// function readStatus(it) {
//   const s = clean(it?.status);
//   if (s === "pending" || s === "approved" || s === "rejected") return s;
//   return legacyStatus(it);
// }

// function hasDraftChanges(it) {
//   const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
//   const l = it?.liveUpdatedAt ? new Date(it.liveUpdatedAt).getTime() : 0;
//   return Boolean(d && (!l || d > l));
// }

// function editedAfterReject(it) {
//   const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
//   const r = it?.rejectedAt ? new Date(it.rejectedAt).getTime() : 0;
//   return Boolean(d && r && d > r);
// }

// function canSubmitForReview(it) {
//   const st = readStatus(it);
//   if (st === "rejected") return editedAfterReject(it);
//   if (st === "approved") return hasDraftChanges(it);
//   return hasDraftChanges(it) || Boolean(it?.hasDraft);
// }

// function canTogglePublished(it) {
//   return readStatus(it) === "approved";
// }

// function buildSearchOr(search) {
//   return [
//     { title: { $regex: search, $options: "i" } },
//     { excerpt: { $regex: search, $options: "i" } },
//     { content: { $regex: search, $options: "i" } },
//   ];
// }

// function buildFilters(search, category, tag) {
//   const q = {};
//   if (search) q.$or = buildSearchOr(search);
//   if (category) q.category = category;
//   if (tag) q.tags = tag;
//   return q;
// }

// function buildBaseFilters(req) {
//   const search = clean(req.query.search);
//   const category = clean(req.query.category);
//   const tag = clean(req.query.tag);
//   return buildFilters(search, category, tag);
// }

// function buildProviderViewQuery(view, pid, common) {
//   const base = { ...common, providerId: pid };
//   if (view === "mine_pending") return { ...base, status: "pending" };
//   if (view === "mine_approved") return { ...base, status: "approved" };
//   if (view === "mine_rejected") return { ...base, status: "rejected" };
//   return base;
// }

// function buildSuperQueries(pid, common) {
//   return {
//     mine: { ...common, providerId: pid },
//     providerPending: { ...common, providerId: { $ne: pid }, status: "pending" },
//     providerApproved: {
//       ...common,
//       providerId: { $ne: pid },
//       status: "approved",
//     },
//     providerRejected: {
//       ...common,
//       providerId: { $ne: pid },
//       status: "rejected",
//     },
//   };
// }

// function mapSuperView(qs, view) {
//   if (view === "mine") return qs.mine;
//   if (view === "provider_pending") return qs.providerPending;
//   if (view === "provider_approved") return qs.providerApproved;
//   if (view === "provider_rejected") return qs.providerRejected;
//   return null;
// }

// function pickPaging(req) {
//   const limit = Math.min(toInt(req.query.limit, 10), 50);
//   const page = Math.max(toInt(req.query.page, 1), 1);
//   const view = clean(req.query.view);
//   return { limit, page, view };
// }

// async function pagedFind(NewsModel, q, limit, page) {
//   const skip = (page - 1) * limit;
//   const [items, total] = await Promise.all([
//     NewsModel.find(q)
//       .sort({ date: -1, _id: -1 })
//       .skip(skip)
//       .limit(limit)
//       .lean(),
//     NewsModel.countDocuments(q),
//   ]);
//   const pages = Math.max(Math.ceil(total / limit) || 1, 1);
//   return { items, total, page, pages };
// }

// function uniqueProviderIds(items) {
//   const ids = items.map((it) => clean(it?.providerId)).filter(Boolean);
//   return Array.from(new Set(ids));
// }

// function loadProviders(AdminUserModel, ids) {
//   return AdminUserModel.find({ _id: { $in: ids } })
//     .select("_id fullName email")
//     .lean();
// }

// function buildProvider(map, it) {
//   const pid = clean(it?.providerId);
//   const u = pid ? map.get(pid) : null;
//   if (!pid) return null;
//   if (!u) return { id: pid, fullName: "", email: "" };
//   return { id: clean(u._id), fullName: u.fullName || "", email: u.email || "" };
// }

// function attachProviders(items, users) {
//   const map = new Map(users.map((u) => [clean(u._id), u]));
//   return items.map((it) => ({ ...it, provider: buildProvider(map, it) }));
// }

// async function enrichProviders(AdminUserModel, items) {
//   if (!Array.isArray(items) || !items.length) return items;
//   const ids = uniqueProviderIds(items);
//   if (!ids.length) return items;
//   const users = await loadProviders(AdminUserModel, ids);
//   return attachProviders(items, users);
// }

// function ensureCreateFields(body) {
//   if (!body?.title || !body?.slug) return "Title and slug are required";
//   if (!body?.date || isNaN(new Date(body.date).getTime()))
//     return "Date is required";
//   return "";
// }

// function buildCreatePayload(pid, body) {
//   const now = new Date();
//   return {
//     providerId: pid,
//     date: body.date,
//     title: body.title,
//     slug: body.slug,
//     excerpt: body.excerpt || "",
//     content: body.content || "",
//     coverImage: body.coverImage || "",
//     media: body.media || [],
//     category: body.category,
//     tags: body.tags || [],
//     status: "pending",
//     published: false,
//     everPublished: false,
//     approvedAt: null,
//     liveUpdatedAt: null,
//     submittedAt: now,
//     rejectionReason: "",
//     rejectedAt: null,
//     lastProviderEditAt: now,
//     lastSuperEditAt: null,
//     hasDraft: true,
//     draftUpdatedAt: now,
//     draft: pickDraftPatch(body),
//   };
// }

// function stripProviderForbidden(body) {
//   const blocked = [
//     "status",
//     "published",
//     "rejectionReason",
//     "rejectedAt",
//     "approvedAt",
//     "liveUpdatedAt",
//     "submittedAt",
//     "everPublished",
//     "correctionRequired",
//     "correctionRequestedAt",
//     "correctionFixedAt",
//   ];
//   const out = { ...body };
//   for (const k of blocked) if (k in out) delete out[k];
//   return out;
// }

// function mergeDraftIntoLive(existing) {
//   const d = existing?.draft || {};
//   const out = {};
//   for (const k of displayFields) out[k] = k in d ? d[k] : existing[k];
//   return out;
// }

// function approveMeta(existing, now) {
//   return {
//     status: "approved",
//     published: true,
//     everPublished: true,
//     submittedAt: null,
//     rejectionReason: "",
//     rejectedAt: null,
//     approvedAt: existing.approvedAt ? existing.approvedAt : now,
//     liveUpdatedAt: now,
//   };
// }

// function clearDraft(now) {
//   return {
//     hasDraft: false,
//     draftUpdatedAt: null,
//     draft: {},
//     correctionRequired: false,
//     correctionFixedAt: now,
//   };
// }

// function buildApproveSet(existing) {
//   const now = new Date();
//   const merged = mergeDraftIntoLive(existing);
//   return {
//     ...merged,
//     ...approveMeta(existing, now),
//     ...clearDraft(now),
//     lastSuperEditAt: now,
//   };
// }

// function buildRejectSet(reason) {
//   const now = new Date();
//   return {
//     status: "rejected",
//     published: false,
//     submittedAt: null,
//     rejectionReason: clean(reason),
//     rejectedAt: now,
//     correctionRequired: false,
//     correctionRequestedAt: null,
//     correctionFixedAt: null,
//     lastSuperEditAt: now,
//   };
// }

// function buildToggleSet(nextPublished) {
//   return { published: Boolean(nextPublished), lastSuperEditAt: new Date() };
// }

// function mergeDraftPatch(existing, patch) {
//   const prev =
//     existing?.draft && typeof existing.draft === "object" ? existing.draft : {};
//   return { ...prev, ...patch };
// }

// function buildProviderDraftSet(existing, patch) {
//   const now = new Date();
//   return {
//     draft: mergeDraftPatch(existing, patch),
//     hasDraft: true,
//     draftUpdatedAt: now,
//     lastProviderEditAt: now,
//   };
// }

// function buildProviderSubmitSet(existing) {
//   const now = new Date();
//   const st = readStatus(existing);
//   const isUpdateReview = st === "approved" && Boolean(existing?.approvedAt);

//   if (isUpdateReview) {
//     return {
//       submittedAt: now,
//       rejectionReason: "",
//       rejectedAt: null,
//       correctionRequired: true,
//       correctionRequestedAt: now,
//       correctionFixedAt: null,
//       lastProviderEditAt: now,
//     };
//   }

//   return {
//     status: "pending",
//     published: false,
//     submittedAt: now,
//     rejectionReason: "",
//     rejectedAt: null,
//     lastProviderEditAt: now,
//   };
// }

// function buildSuperCreatePayload(payload) {
//   const set = buildApproveSet({ ...payload, approvedAt: null });
//   return { ...payload, ...set, submittedAt: null };
// }

// module.exports = {
//   clean,
//   isSuper,
//   getProviderId,
//   normalizeBody,
//   isContentEdit,
//   pickDraftPatch,
//   mergeDraft,
//   readStatus,
//   canSubmitForReview,
//   canTogglePublished,
//   buildBaseFilters,
//   buildProviderViewQuery,
//   buildSuperQueries,
//   mapSuperView,
//   pickPaging,
//   pagedFind,
//   enrichProviders,
//   ensureCreateFields,
//   buildCreatePayload,
//   stripProviderForbidden,
//   buildApproveSet,
//   buildRejectSet,
//   buildToggleSet,
//   buildProviderDraftSet,
//   buildProviderSubmitSet,
//   buildSuperCreatePayload,
// };

// // routes/adminNews.helpers.js
// "use strict";

// const allowedCategories = ["Allgemein", "News", "Partnerverein", "Projekte"];
// const displayFields = [
//   "title",
//   "slug",
//   "excerpt",
//   "content",
//   "coverImage",
//   "category",
//   "tags",
//   "media",
// ];

// function clean(v) {
//   return String(v ?? "").trim();
// }

// function toInt(v, fallback) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function isSuper(req) {
//   return req.isSuperAdmin === true || clean(req.role) === "super";
// }

// function getProviderId(req) {
//   return clean(req.providerId);
// }

// function normCategory(val) {
//   const v = clean(val);
//   return allowedCategories.includes(v) ? v : "News";
// }

// function normTags(arr) {
//   if (!Array.isArray(arr)) return [];
//   return arr.map(clean).filter(Boolean);
// }

// function normTagsSafe(v) {
//   if (Array.isArray(v)) return normTags(v);
//   const s = clean(v);
//   if (!s) return [];
//   return s.split(",").map(clean).filter(Boolean);
// }

// function isVideoUrl(u) {
//   return /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(String(u || ""));
// }

// function isVideoMime(m) {
//   return /^video\//i.test(String(m || ""));
// }

// function normMedia(arr) {
//   if (!Array.isArray(arr)) return [];
//   return arr.map(mapMediaItem).filter((m) => Boolean(m.url));
// }

// function mapMediaItem(m) {
//   const url = clean(m?.url);
//   const isVideo =
//     m?.type === "video" || isVideoUrl(url) || isVideoMime(m?.mimetype);
//   return {
//     type: isVideo ? "video" : "image",
//     url,
//     alt: String(m?.alt || ""),
//     title: String(m?.title || ""),
//   };
// }

// function normalizeBody(raw) {
//   const body = { ...(raw || {}) };
//   if ("title" in body) body.title = clean(body.title);
//   if ("slug" in body) body.slug = clean(body.slug);
//   if ("excerpt" in body) body.excerpt = String(body.excerpt || "");
//   if ("content" in body) body.content = String(body.content || "");
//   if ("coverImage" in body) body.coverImage = String(body.coverImage || "");
//   if ("category" in body) body.category = normCategory(body.category);
//   if ("tags" in body) body.tags = normTagsSafe(body.tags);
//   if ("media" in body) body.media = normMedia(body.media);
//   if ("published" in body) body.published = Boolean(body.published);
//   if ("status" in body) body.status = clean(body.status);
//   if ("rejectionReason" in body)
//     body.rejectionReason = clean(body.rejectionReason);
//   return body;
// }

// function isContentEdit(body) {
//   return displayFields.some((k) => k in (body || {}));
// }

// function pickDraftPatch(body) {
//   const d = {};
//   for (const k of displayFields) if (k in body) d[k] = body[k];
//   return d;
// }

// function mergeDraft(doc) {
//   if (!doc?.draft) return doc;
//   const out = { ...doc };
//   for (const k of displayFields) if (k in doc.draft) out[k] = doc.draft[k];
//   return out;
// }

// function legacyStatus(it) {
//   if (clean(it?.rejectionReason)) return "rejected";
//   if (it?.approvedAt) return "approved";
//   if (it?.submittedAt) return "pending";
//   return it?.published === true ? "approved" : "pending";
// }

// function readStatus(it) {
//   const s = clean(it?.status);
//   if (s === "pending" || s === "approved" || s === "rejected") return s;
//   return legacyStatus(it);
// }

// function hasDraftChanges(it) {
//   const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
//   const l = it?.liveUpdatedAt ? new Date(it.liveUpdatedAt).getTime() : 0;
//   return Boolean(d && (!l || d > l));
// }

// function editedAfterReject(it) {
//   const d = it?.draftUpdatedAt ? new Date(it.draftUpdatedAt).getTime() : 0;
//   const r = it?.rejectedAt ? new Date(it.rejectedAt).getTime() : 0;
//   return Boolean(d && r && d > r);
// }

// function canSubmitForReview(it) {
//   const st = readStatus(it);
//   if (st === "rejected") return editedAfterReject(it);
//   if (st === "approved") return hasDraftChanges(it);
//   return hasDraftChanges(it) || Boolean(it?.hasDraft);
// }

// function canTogglePublished(it) {
//   return readStatus(it) === "approved";
// }

// function buildBaseFilters(req) {
//   const search = clean(req.query.search);
//   const category = clean(req.query.category);
//   const tag = clean(req.query.tag);
//   return buildFilters(search, category, tag);
// }

// function buildFilters(search, category, tag) {
//   const q = {};
//   if (search) q.$or = buildSearchOr(search);
//   if (category) q.category = category;
//   if (tag) q.tags = tag;
//   return q;
// }

// function buildSearchOr(search) {
//   return [
//     { title: { $regex: search, $options: "i" } },
//     { excerpt: { $regex: search, $options: "i" } },
//     { content: { $regex: search, $options: "i" } },
//   ];
// }

// function buildProviderViewQuery(view, pid, common) {
//   const base = { ...common, providerId: pid };
//   if (view === "mine_pending") return { ...base, status: "pending" };
//   if (view === "mine_approved") return { ...base, status: "approved" };
//   if (view === "mine_rejected") return { ...base, status: "rejected" };
//   return base;
// }

// function buildSuperQueries(pid, common) {
//   return {
//     mine: { ...common, providerId: pid },
//     providerPending: { ...common, providerId: { $ne: pid }, status: "pending" },
//     providerApproved: {
//       ...common,
//       providerId: { $ne: pid },
//       status: "approved",
//     },
//     providerRejected: {
//       ...common,
//       providerId: { $ne: pid },
//       status: "rejected",
//     },
//   };
// }

// function pickPaging(req) {
//   const limit = Math.min(toInt(req.query.limit, 10), 50);
//   const page = Math.max(toInt(req.query.page, 1), 1);
//   const view = clean(req.query.view);
//   return { limit, page, view };
// }

// async function pagedFind(NewsModel, q, limit, page) {
//   const skip = (page - 1) * limit;
//   const [items, total] = await Promise.all([
//     NewsModel.find(q)
//       .sort({ date: -1, _id: -1 })
//       .skip(skip)
//       .limit(limit)
//       .lean(),
//     NewsModel.countDocuments(q),
//   ]);
//   const pages = Math.max(Math.ceil(total / limit) || 1, 1);
//   return { items, total, page, pages };
// }

// async function enrichProviders(AdminUserModel, items) {
//   if (!Array.isArray(items) || !items.length) return items;
//   const ids = uniqueProviderIds(items);
//   if (!ids.length) return items;
//   const users = await loadProviders(AdminUserModel, ids);
//   return attachProviders(items, users);
// }

// function uniqueProviderIds(items) {
//   const ids = items.map((it) => clean(it?.providerId)).filter(Boolean);
//   return Array.from(new Set(ids));
// }

// function loadProviders(AdminUserModel, ids) {
//   return AdminUserModel.find({ _id: { $in: ids } })
//     .select("_id fullName email")
//     .lean();
// }

// function attachProviders(items, users) {
//   const map = new Map(users.map((u) => [clean(u._id), u]));
//   return items.map((it) => ({ ...it, provider: buildProvider(map, it) }));
// }

// function buildProvider(map, it) {
//   const pid = clean(it?.providerId);
//   const u = pid ? map.get(pid) : null;
//   if (!pid) return null;
//   if (!u) return { id: pid, fullName: "", email: "" };
//   return { id: clean(u._id), fullName: u.fullName || "", email: u.email || "" };
// }

// function buildCreatePayload(pid, body) {
//   const now = new Date();
//   return {
//     providerId: pid,
//     date: body.date,
//     title: body.title,
//     slug: body.slug,
//     excerpt: body.excerpt || "",
//     content: body.content || "",
//     coverImage: body.coverImage || "",
//     media: body.media || [],
//     category: body.category,
//     tags: body.tags || [],
//     status: "pending",
//     published: false,
//     everPublished: false,
//     approvedAt: null,
//     liveUpdatedAt: null,
//     submittedAt: now,
//     rejectionReason: "",
//     rejectedAt: null,
//     lastProviderEditAt: now,
//     lastSuperEditAt: null,
//     hasDraft: true,
//     draftUpdatedAt: now,
//     draft: pickDraftPatch(body),
//   };
// }

// function buildRejectSet(reason) {
//   const now = new Date();
//   return {
//     status: "rejected",
//     published: false,
//     submittedAt: null,
//     rejectionReason: clean(reason),
//     rejectedAt: now,
//     lastSuperEditAt: now,
//   };
// }

// function buildToggleSet(nextPublished) {
//   return { published: Boolean(nextPublished), lastSuperEditAt: new Date() };
// }

// function buildProviderSubmitSet() {
//   const now = new Date();
//   return {
//     status: "pending",
//     submittedAt: now,
//     rejectionReason: "",
//     rejectedAt: null,
//     lastProviderEditAt: now,
//   };
// }

// function buildProviderDraftSet(draft) {
//   const now = new Date();
//   return {
//     draft,
//     hasDraft: true,
//     draftUpdatedAt: now,
//     lastProviderEditAt: now,
//   };
// }

// function buildApproveSet(existing) {
//   const now = new Date();
//   const merged = mergeDraftIntoLive(existing);
//   return {
//     ...merged,
//     ...approveMeta(existing, now),
//     ...clearDraft(now),
//     lastSuperEditAt: now,
//   };
// }

// function mergeDraftIntoLive(existing) {
//   const d = existing?.draft || {};
//   const out = {};
//   for (const k of displayFields) out[k] = k in d ? d[k] : existing[k];
//   return out;
// }

// function approveMeta(existing, now) {
//   return {
//     status: "approved",
//     published: true,
//     everPublished: true,
//     submittedAt: null,
//     rejectionReason: "",
//     rejectedAt: null,
//     approvedAt: existing.approvedAt ? existing.approvedAt : now,
//     liveUpdatedAt: now,
//   };
// }

// function clearDraft(now) {
//   return {
//     hasDraft: false,
//     draftUpdatedAt: null,
//     draft: {},
//     correctionRequired: false,
//     correctionFixedAt: now,
//   };
// }

// function ensureCreateFields(body) {
//   if (!body?.title || !body?.slug) return "Title and slug are required";
//   return "";
// }

// function stripProviderForbidden(body) {
//   const blocked = [
//     "status",
//     "published",
//     "rejectionReason",
//     "rejectedAt",
//     "approvedAt",
//     "liveUpdatedAt",
//     "submittedAt",
//   ];
//   const out = { ...body };
//   for (const k of blocked) if (k in out) delete out[k];
//   return out;
// }

// module.exports = {
//   clean,
//   isSuper,
//   getProviderId,
//   normalizeBody,
//   isContentEdit,
//   pickDraftPatch,
//   mergeDraft,
//   readStatus,
//   canSubmitForReview,
//   canTogglePublished,
//   buildBaseFilters,
//   buildProviderViewQuery,
//   buildSuperQueries,
//   pickPaging,
//   pagedFind,
//   enrichProviders,
//   buildCreatePayload,
//   buildRejectSet,
//   buildToggleSet,
//   buildProviderSubmitSet,
//   buildProviderDraftSet,
//   buildApproveSet,
//   ensureCreateFields,
//   stripProviderForbidden,
// };
