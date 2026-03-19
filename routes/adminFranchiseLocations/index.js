//routes\adminFranchiseLocations\index.js
"use strict";

const express = require("express");
const adminAuth = require("../../middleware/adminAuth");
const {
  handleGet,
  handleCreate,
  handlePatch,
  handleDelete,
} = require("./logic");

const router = express.Router();

router.get("/", adminAuth, handleGet);
router.post("/", adminAuth, handleCreate);
router.patch("/:id", adminAuth, handlePatch);
router.put("/:id", adminAuth, handlePatch);
router.delete("/:id", adminAuth, handleDelete);

module.exports = router;

// // routes/adminFranchiseLocations/index.js
// "use strict";

// const express = require("express");
// const adminAuth = require("../../middleware/adminAuth");
// const {
//   handleGet,
//   handleCreate,
//   handlePatch,
//   handleDelete,
// } = require("./logic");

// const router = express.Router();

// router.get("/", adminAuth, handleGet);
// router.post("/", adminAuth, handleCreate);
// router.patch("/:id", adminAuth, handlePatch);
// router.delete("/:id", adminAuth, handleDelete);

// module.exports = router;
