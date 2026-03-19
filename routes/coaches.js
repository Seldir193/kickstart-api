// routes/coaches.js
const express = require("express");
const Coach = require("../models/Coach");
const router = express.Router();

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

function publicFilter() {
  return {
    published: { $ne: false },
    $or: [
      { status: "approved" },
      { approvedAt: { $ne: null } },
      { status: { $exists: false } },
      { status: null },
      { status: "" },
    ],
  };
}

// GET /api/coaches?q=&page=&limit=
router.get("/", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const q = (req.query.q || "").trim();

  const filter = publicFilter();

  if (q.length >= 2) {
    filter.$and = [
      {
        $or: [
          { name: { $regex: q, $options: "i" } },
          { firstName: { $regex: q, $options: "i" } },
          { lastName: { $regex: q, $options: "i" } },
          { position: { $regex: q, $options: "i" } },
        ],
      },
    ];
  }

  const total = await Coach.countDocuments(filter);
  const items = await Coach.find(filter)
    .sort({ lastName: 1, firstName: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.json({ items, total, page, limit });
});

// GET /api/coaches/:slug
router.get("/:slug", async (req, res) => {
  const slug = String(req.params.slug || "")
    .toLowerCase()
    .trim();

  const c = await Coach.findOne({
    slug,
    ...publicFilter(),
  }).lean();

  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});

module.exports = router;

// // routes/coaches.js
// const express = require("express");
// const Coach = require("../models/Coach");
// const router = express.Router();

// // GET /api/coaches?q=&page=&limit=
// router.get("/", async (req, res) => {
//   const page = Math.max(1, parseInt(req.query.page, 10) || 1);
//   const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12));
//   const q = (req.query.q || "").trim();

//   const filter = { published: { $ne: false } }; // ✅ nur published + legacy

//   if (q.length >= 2) {
//     filter.$or = [
//       { name: { $regex: q, $options: "i" } },
//       { firstName: { $regex: q, $options: "i" } },
//       { lastName: { $regex: q, $options: "i" } },
//       { position: { $regex: q, $options: "i" } },
//     ];
//   }

//   const total = await Coach.countDocuments(filter);
//   const items = await Coach.find(filter)
//     .sort({ lastName: 1, firstName: 1 })
//     .skip((page - 1) * limit)
//     .limit(limit)
//     .lean();

//   res.json({ items, total, page, limit });
// });

// // GET /api/coaches/:slug
// router.get("/:slug", async (req, res) => {
//   const c = await Coach.findOne({
//     slug: req.params.slug.toLowerCase(),
//     published: { $ne: false },
//   }).lean();
//   if (!c) return res.status(404).json({ error: "Not found" });
//   res.json(c);
// });

// module.exports = router;
