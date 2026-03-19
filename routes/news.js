// routes/news.js
"use strict";

const express = require("express");
const router = express.Router();
const News = require("../models/News");

const allowedCategories = ["Allgemein", "News", "Partnerverein", "Projekte"];

function clean(v) {
  return String(v ?? "").trim();
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isPublishedOnly(req) {
  return String(req.query.published) !== "false";
}

function buildSearchClause(search) {
  if (!search) return null;
  return {
    $or: [
      { title: { $regex: search, $options: "i" } },
      { excerpt: { $regex: search, $options: "i" } },
      { content: { $regex: search, $options: "i" } },
    ],
  };
}

function buildTaxonomyMatch(publishedOnly) {
  if (!publishedOnly) return {};
  return {
    $or: [
      { status: "approved", published: true },
      { status: { $exists: false }, published: { $ne: false } },
      { status: null, published: { $ne: false } },
      { status: "", published: { $ne: false } },
    ],
  };
}

function buildListQuery(params) {
  const q = {};
  if (params.publishedOnly) Object.assign(q, buildTaxonomyMatch(true));
  const searchClause = buildSearchClause(params.search);
  if (searchClause) Object.assign(q, searchClause);
  if (params.category) q.category = params.category;
  if (params.tag) q.tags = params.tag;
  return q;
}

function parseListParams(req) {
  const limit = Math.min(toInt(req.query.limit, 10), 50);
  const page = Math.max(toInt(req.query.page, 1), 1);
  const search = clean(req.query.search);
  const category = clean(req.query.category);
  const tag = clean(req.query.tag);
  return {
    limit,
    page,
    search,
    category,
    tag,
    publishedOnly: isPublishedOnly(req),
  };
}

async function pagedFind(q, limit, page) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    News.find(q).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    News.countDocuments(q),
  ]);
  const pages = Math.max(Math.ceil(total / limit) || 1, 1);
  return { items, total, page, pages };
}

async function loadTaxonomy(match) {
  const [catsAgg, tagsAgg] = await Promise.all([
    News.aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ["$category", ""] }, count: { $sum: 1 } } },
    ]),
    News.aggregate([
      { $match: match },
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 200 },
    ]),
  ]);
  return { catsAgg, tagsAgg };
}

function buildCategories(catsAgg) {
  const catsMap = new Map(
    catsAgg.map((c) => [clean(c._id), Number(c.count || 0)]),
  );
  const categories = allowedCategories.map((name) => ({
    name,
    count: catsMap.get(name) || 0,
  }));
  for (const name of allowedCategories) catsMap.delete(name);
  const rest = [...catsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, count] of rest) if (name) categories.push({ name, count });
  return categories;
}

function buildTags(tagsAgg) {
  return tagsAgg.map((t) => ({
    name: clean(t._id),
    count: Number(t.count || 0),
  }));
}

function buildSlugQuery(slug) {
  return {
    slug,
    $or: [
      { status: "approved", published: true },
      { status: { $exists: false }, published: { $ne: false } },
      { status: null, published: { $ne: false } },
      { status: "", published: { $ne: false } },
    ],
  };
}

router.get("/", async (req, res) => {
  try {
    const params = parseListParams(req);
    const q = buildListQuery(params);
    const data = await pagedFind(q, params.limit, params.page);
    return res.json({ ok: true, ...data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: clean(e.message) });
  }
});

router.get("/taxonomy", async (req, res) => {
  try {
    const match = buildTaxonomyMatch(isPublishedOnly(req));
    const { catsAgg, tagsAgg } = await loadTaxonomy(match);
    const categories = buildCategories(catsAgg);
    const tags = buildTags(tagsAgg);
    return res.json({ ok: true, categories, tags });
  } catch (e) {
    return res.status(500).json({ ok: false, error: clean(e.message) });
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const slug = clean(req.params.slug);
    const item = await News.findOne(buildSlugQuery(slug)).lean();
    if (!item) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ ok: false, error: clean(e.message) });
  }
});

module.exports = router;

// // routes/news.js
// "use strict";

// const express = require("express");
// const router = express.Router();
// const News = require("../models/News");

// const allowedCategories = ["Allgemein", "News", "Partnerverein", "Projekte"];

// function toInt(v, fallback) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function clean(v) {
//   return String(v ?? "").trim();
// }

// function isPublishedOnly(req) {
//   return String(req.query.published) !== "false";
// }

// function buildSearchClause(search) {
//   if (!search) return null;
//   return {
//     $or: [
//       { title: { $regex: search, $options: "i" } },
//       { excerpt: { $regex: search, $options: "i" } },
//       { content: { $regex: search, $options: "i" } },
//     ],
//   };
// }

// function buildPublicGate() {
//   return {
//     $or: [
//       { status: "approved", published: true },
//       { status: { $exists: false }, published: { $ne: false } },
//       { status: null, published: { $ne: false } },
//       { status: "", published: { $ne: false } },
//     ],
//   };
// }

// function buildTaxonomyMatch(publishedOnly) {
//   if (!publishedOnly) return {};
//   return buildPublicGate();
// }

// function buildListQuery(params) {
//   const q = {};
//   if (params.publishedOnly) Object.assign(q, buildPublicGate());

//   const searchClause = buildSearchClause(params.search);
//   if (searchClause) Object.assign(q, searchClause);

//   if (params.category) q.category = params.category;
//   if (params.tag) q.tags = params.tag;

//   return q;
// }

// function parseListParams(req) {
//   const limit = Math.min(toInt(req.query.limit, 10), 50);
//   const page = Math.max(toInt(req.query.page, 1), 1);
//   const search = clean(req.query.search);
//   const category = clean(req.query.category);
//   const tag = clean(req.query.tag);

//   return {
//     limit,
//     page,
//     search,
//     category,
//     tag,
//     publishedOnly: isPublishedOnly(req),
//   };
// }

// async function pagedFind(q, limit, page) {
//   const skip = (page - 1) * limit;

//   const [items, total] = await Promise.all([
//     News.find(q).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
//     News.countDocuments(q),
//   ]);

//   const pages = Math.max(Math.ceil(total / limit) || 1, 1);
//   return { items, total, page, pages };
// }

// async function loadTaxonomy(match) {
//   const [catsAgg, tagsAgg] = await Promise.all([
//     News.aggregate([
//       { $match: match },
//       { $group: { _id: { $ifNull: ["$category", ""] }, count: { $sum: 1 } } },
//     ]),
//     News.aggregate([
//       { $match: match },
//       { $unwind: "$tags" },
//       { $group: { _id: "$tags", count: { $sum: 1 } } },
//       { $sort: { count: -1, _id: 1 } },
//       { $limit: 200 },
//     ]),
//   ]);

//   return { catsAgg, tagsAgg };
// }

// function buildCategories(catsAgg) {
//   const catsMap = new Map(
//     catsAgg.map((c) => [clean(c._id), Number(c.count || 0)]),
//   );
//   const categories = allowedCategories.map((name) => ({
//     name,
//     count: catsMap.get(name) || 0,
//   }));

//   for (const name of allowedCategories) catsMap.delete(name);

//   const rest = [...catsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
//   for (const [name, count] of rest) if (name) categories.push({ name, count });

//   return categories;
// }

// function buildTags(tagsAgg) {
//   return tagsAgg.map((t) => ({
//     name: clean(t._id),
//     count: Number(t.count || 0),
//   }));
// }

// function buildSlugQuery(slug, publishedOnly) {
//   if (!publishedOnly) return { slug };
//   return { slug, ...buildPublicGate() };
// }

// router.get("/", async (req, res) => {
//   try {
//     const params = parseListParams(req);
//     const q = buildListQuery(params);
//     const data = await pagedFind(q, params.limit, params.page);
//     return res.json({ ok: true, ...data });
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: clean(e.message) });
//   }
// });

// router.get("/taxonomy", async (req, res) => {
//   try {
//     const match = buildTaxonomyMatch(isPublishedOnly(req));
//     const { catsAgg, tagsAgg } = await loadTaxonomy(match);
//     const categories = buildCategories(catsAgg);
//     const tags = buildTags(tagsAgg);
//     return res.json({ ok: true, categories, tags });
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: clean(e.message) });
//   }
// });

// router.get("/:slug", async (req, res) => {
//   try {
//     const slug = clean(req.params.slug);
//     const item = await News.findOne(buildSlugQuery(slug, true)).lean();
//     if (!item) return res.status(404).json({ ok: false, error: "Not found" });
//     return res.json({ ok: true, item });
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: clean(e.message) });
//   }
// });

// module.exports = router;

// "use strict";

// const express = require("express");
// const router = express.Router();
// const News = require("../models/News");

// const allowedCategories = ["Allgemein", "News", "Partnerverein", "Projekte"];

// function toInt(v, fallback) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function clean(v) {
//   return String(v ?? "").trim();
// }

// function isPublishedOnly(req) {
//   return String(req.query.published) !== "false";
// }

// function buildSearchClause(search) {
//   if (!search) return null;
//   return {
//     $or: [
//       { title: { $regex: search, $options: "i" } },
//       { excerpt: { $regex: search, $options: "i" } },
//       { content: { $regex: search, $options: "i" } },
//     ],
//   };
// }

// function buildTaxonomyMatch(publishedOnly) {
//   if (!publishedOnly) return {};
//   return {
//     $or: [
//       { status: "approved", published: true },
//       { status: { $exists: false }, published: { $ne: false } },
//       { status: null, published: { $ne: false } },
//       { status: "", published: { $ne: false } },
//     ],
//   };
// }

// function buildListQuery(params) {
//   const q = {};
//   if (params.publishedOnly) Object.assign(q, buildTaxonomyMatch(true));
//   const searchClause = buildSearchClause(params.search);
//   if (searchClause) Object.assign(q, searchClause);
//   if (params.category) q.category = params.category;
//   if (params.tag) q.tags = params.tag;
//   return q;
// }

// function parseListParams(req) {
//   const limit = Math.min(toInt(req.query.limit, 10), 50);
//   const page = Math.max(toInt(req.query.page, 1), 1);
//   const search = clean(req.query.search);
//   const category = clean(req.query.category);
//   const tag = clean(req.query.tag);
//   return {
//     limit,
//     page,
//     search,
//     category,
//     tag,
//     publishedOnly: isPublishedOnly(req),
//   };
// }

// async function pagedFind(q, limit, page) {
//   const skip = (page - 1) * limit;
//   const [items, total] = await Promise.all([
//     News.find(q).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
//     News.countDocuments(q),
//   ]);
//   const pages = Math.max(Math.ceil(total / limit) || 1, 1);
//   return { items, total, page, pages };
// }

// async function loadTaxonomy(match) {
//   const [catsAgg, tagsAgg] = await Promise.all([
//     News.aggregate([
//       { $match: match },
//       { $group: { _id: { $ifNull: ["$category", ""] }, count: { $sum: 1 } } },
//     ]),
//     News.aggregate([
//       { $match: match },
//       { $unwind: "$tags" },
//       { $group: { _id: "$tags", count: { $sum: 1 } } },
//       { $sort: { count: -1, _id: 1 } },
//       { $limit: 200 },
//     ]),
//   ]);
//   return { catsAgg, tagsAgg };
// }

// function buildCategories(catsAgg) {
//   const catsMap = new Map(
//     catsAgg.map((c) => [clean(c._id), Number(c.count || 0)]),
//   );
//   const categories = allowedCategories.map((name) => ({
//     name,
//     count: catsMap.get(name) || 0,
//   }));
//   for (const name of allowedCategories) catsMap.delete(name);
//   const rest = [...catsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
//   for (const [name, count] of rest) if (name) categories.push({ name, count });
//   return categories;
// }

// function buildTags(tagsAgg) {
//   return tagsAgg.map((t) => ({
//     name: clean(t._id),
//     count: Number(t.count || 0),
//   }));
// }

// function buildSlugQuery(slug) {
//   return {
//     slug,
//     $or: [
//       { status: "approved", published: true },
//       { status: { $exists: false }, published: { $ne: false } },
//       { status: null, published: { $ne: false } },
//       { status: "", published: { $ne: false } },
//     ],
//   };
// }

// router.get("/", async (req, res) => {
//   try {
//     const params = parseListParams(req);
//     const q = buildListQuery(params);
//     const data = await pagedFind(q, params.limit, params.page);
//     return res.json({ ok: true, ...data });
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: clean(e.message) });
//   }
// });

// router.get("/taxonomy", async (req, res) => {
//   try {
//     const match = buildTaxonomyMatch(isPublishedOnly(req));
//     const { catsAgg, tagsAgg } = await loadTaxonomy(match);
//     const categories = buildCategories(catsAgg);
//     const tags = buildTags(tagsAgg);
//     return res.json({ ok: true, categories, tags });
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: clean(e.message) });
//   }
// });

// router.get("/:slug", async (req, res) => {
//   try {
//     const slug = clean(req.params.slug);
//     const item = await News.findOne(buildSlugQuery(slug)).lean();
//     if (!item) return res.status(404).json({ ok: false, error: "Not found" });
//     return res.json({ ok: true, item });
//   } catch (e) {
//     return res.status(500).json({ ok: false, error: clean(e.message) });
//   }
// });

// module.exports = router;
