//routes\franchiseLocations.js
"use strict";

const express = require("express");
const adminAuth = require("../middleware/adminAuth");
const requireProvider = require("../middleware/requireProvider");
const {
  getPublicList,
  getMine,
  createMine,
  patchMine,
  deleteMine,
  putAlias,
} = require("./franchiseLocations.logic");

const router = express.Router();

router.get("/public", getPublicList);

router.get("/", adminAuth, requireProvider, getMine);
router.post("/", adminAuth, requireProvider, createMine);
router.patch("/:id", adminAuth, requireProvider, patchMine);
router.put("/:id", adminAuth, requireProvider, putAlias);
router.delete("/:id", adminAuth, requireProvider, deleteMine);

module.exports = router;

// // routes/franchiseLocations.js
// "use strict";

// const express = require("express");
// const adminAuth = require("../middleware/adminAuth");
// const requireProvider = require("../middleware/requireProvider");
// const {
//   getPublicList,
//   getMine,
//   createMine,
//   patchMine,
//   deleteMine,
//   putAlias,
// } = require("./franchiseLocations.logic");

// const router = express.Router();

// router.get("/public", getPublicList);

// router.get("/", adminAuth, requireProvider, getMine);
// router.post("/", adminAuth, requireProvider, createMine);
// router.patch("/:id", adminAuth, requireProvider, patchMine);
// router.put("/:id", adminAuth, requireProvider, putAlias);
// router.delete("/:id", adminAuth, requireProvider, deleteMine);

// module.exports = router;

// // routes/franchiseLocations.js
// "use strict";
// const express = require("express");
// const mongoose = require("mongoose");

// const adminAuth = require("../middleware/adminAuth");
// const requireProvider = require("../middleware/requireProvider");
// const FranchiseLocation = require("../models/FranchiseLocation");

// const router = express.Router();
// const { isValidObjectId, Types } = mongoose;

// function pickStr(v) {
//   return String(v ?? "").trim();
// }

// function mapDoc(d) {
//   const ownerObj =
//     d && typeof d.owner === "object" && d.owner !== null && d.owner._id;

//   const ownerId = ownerObj ? String(d.owner._id) : String(d.owner);

//   return {
//     id: String(d._id),

//     owner: ownerId,

//     // legacy optional (nicht mehr UI-relevant)
//     ownerId,
//     ownerName: null,
//     ownerEmail: null,

//     // ✅ real name per location
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
//     rejectionReason: d.rejectionReason || "",
//     createdAt: d.createdAt,
//     updatedAt: d.updatedAt,
//   };
// }

// /**
//  * PUBLIC: Liste für WordPress/Frontend (nur approved)
//  * GET /api/franchise-locations/public
//  */
// router.get("/public", async (_req, res) => {
//   try {
//     const items = await FranchiseLocation.find({ status: "approved" })
//       .sort({ country: 1, city: 1 })
//       .lean();

//     return res.json({ ok: true, items: items.map(mapDoc) });
//   } catch (e) {
//     console.error("[GET /public franchise-locations] error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /**
//  * Provider: Meine Locations
//  * GET /api/franchise-locations
//  */
// router.get("/", adminAuth, requireProvider, async (req, res) => {
//   try {
//     const owner = new Types.ObjectId(String(req.providerId));
//     const items = await FranchiseLocation.find({ owner })
//       .sort({ createdAt: -1 })
//       .lean();
//     return res.json({ ok: true, items: items.map(mapDoc) });
//   } catch (e) {
//     console.error("[GET franchise-locations] error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// /**
//  * Provider: Erstellen
//  * POST /api/franchise-locations
//  */
// router.post("/", adminAuth, requireProvider, async (req, res) => {
//   try {
//     const owner = new Types.ObjectId(String(req.providerId));
//     const b = req.body || {};

//     const licenseeFirstName = pickStr(b.licenseeFirstName);
//     const licenseeLastName = pickStr(b.licenseeLastName);
//     if (!licenseeFirstName || !licenseeLastName) {
//       return res.status(400).json({
//         ok: false,
//         error: "licenseeFirstName and licenseeLastName are required",
//       });
//     }

//     const country = pickStr(b.country);
//     const city = pickStr(b.city);
//     if (!country || !city) {
//       return res
//         .status(400)
//         .json({ ok: false, error: "country and city are required" });
//     }

//     const doc = new FranchiseLocation({
//       owner,
//       licenseeFirstName,
//       licenseeLastName,
//       country,
//       city,
//       state: pickStr(b.state),
//       address: pickStr(b.address),
//       zip: pickStr(b.zip),
//       website: pickStr(b.website),
//       emailPublic: pickStr(b.emailPublic),
//       phonePublic: pickStr(b.phonePublic),
//       status: "pending",
//       rejectionReason: "",
//       moderatedAt: null,
//     });

//     await doc.save();
//     return res.status(201).json({ ok: true, item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000) {
//       return res
//         .status(409)
//         .json({ ok: false, error: "Location already exists (duplicate)." });
//     }
//     console.error("[POST franchise-locations] error:", e);
//     return res.status(400).json({ ok: false, error: String(e?.message || e) });
//   }
// });

// /**
//  * Provider: Update (PATCH) — nur eigene
//  * PATCH /api/franchise-locations/:id
//  * Wenn approved und Provider ändert -> wieder pending
//  */
// router.patch("/:id", adminAuth, requireProvider, async (req, res) => {
//   const id = String(req.params.id || "").trim();
//   if (!isValidObjectId(id))
//     return res.status(400).json({ ok: false, error: "Invalid id" });

//   try {
//     const owner = new Types.ObjectId(String(req.providerId));
//     const doc = await FranchiseLocation.findOne({ _id: id, owner });
//     if (!doc) return res.status(404).json({ ok: false, error: "Not found" });

//     const b = req.body || {};

//     const before = {
//       licenseeFirstName: doc.licenseeFirstName || "",
//       licenseeLastName: doc.licenseeLastName || "",
//       country: doc.country,
//       city: doc.city,
//       state: doc.state || "",
//       address: doc.address || "",
//       zip: doc.zip || "",
//       website: doc.website || "",
//       emailPublic: doc.emailPublic || "",
//       phonePublic: doc.phonePublic || "",
//     };

//     if (b.licenseeFirstName !== undefined)
//       doc.licenseeFirstName = pickStr(b.licenseeFirstName);
//     if (b.licenseeLastName !== undefined)
//       doc.licenseeLastName = pickStr(b.licenseeLastName);

//     if (b.country !== undefined)
//       doc.country = pickStr(b.country) || doc.country;
//     if (b.city !== undefined) doc.city = pickStr(b.city) || doc.city;
//     if (b.state !== undefined) doc.state = pickStr(b.state);
//     if (b.address !== undefined) doc.address = pickStr(b.address);
//     if (b.zip !== undefined) doc.zip = pickStr(b.zip);
//     if (b.website !== undefined) doc.website = pickStr(b.website);
//     if (b.emailPublic !== undefined) doc.emailPublic = pickStr(b.emailPublic);
//     if (b.phonePublic !== undefined) doc.phonePublic = pickStr(b.phonePublic);

//     const after = {
//       licenseeFirstName: doc.licenseeFirstName || "",
//       licenseeLastName: doc.licenseeLastName || "",
//       country: doc.country,
//       city: doc.city,
//       state: doc.state || "",
//       address: doc.address || "",
//       zip: doc.zip || "",
//       website: doc.website || "",
//       emailPublic: doc.emailPublic || "",
//       phonePublic: doc.phonePublic || "",
//     };

//     const changed = JSON.stringify(before) !== JSON.stringify(after);
//     if (changed && doc.status === "approved") {
//       doc.status = "pending";
//       doc.rejectionReason = "";
//       doc.moderatedAt = null;
//     }

//     if (!doc.licenseeFirstName || !doc.licenseeLastName) {
//       return res.status(400).json({
//         ok: false,
//         error: "licenseeFirstName and licenseeLastName are required",
//       });
//     }
//     if (!doc.country || !doc.city) {
//       return res
//         .status(400)
//         .json({ ok: false, error: "country and city are required" });
//     }

//     await doc.save();
//     return res.json({ ok: true, item: mapDoc(doc) });
//   } catch (e) {
//     if (e?.code === 11000) {
//       return res
//         .status(409)
//         .json({ ok: false, error: "Location already exists (duplicate)." });
//     }
//     console.error("[PATCH franchise-locations] error:", e);
//     return res.status(400).json({ ok: false, error: String(e?.message || e) });
//   }
// });

// /**
//  * Provider: PUT alias -> PATCH
//  */
// router.put("/:id", adminAuth, requireProvider, async (req, res) => {
//   req.method = "PATCH";
//   return router.handle(req, res);
// });

// /**
//  * Provider: Löschen (sich entfernen)
//  * DELETE /api/franchise-locations/:id
//  */
// router.delete("/:id", adminAuth, requireProvider, async (req, res) => {
//   const id = String(req.params.id || "").trim();
//   if (!isValidObjectId(id))
//     return res.status(400).json({ ok: false, error: "Invalid id" });

//   try {
//     const owner = new Types.ObjectId(String(req.providerId));
//     const r = await FranchiseLocation.deleteOne({ _id: id, owner });
//     if (r.deletedCount === 0)
//       return res.status(404).json({ ok: false, error: "Not found" });
//     return res.json({ ok: true, deleted: 1 });
//   } catch (e) {
//     console.error("[DELETE franchise-locations] error:", e);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// });

// module.exports = router;
