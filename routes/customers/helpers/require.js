// routes/customers/helpers/require.js
"use strict";

const mongoose = require("mongoose");
const { Types } = mongoose;

function isSuperadmin(req) {
  return (
    req.user?.role === "superadmin" ||
    req.user?.isSuperadmin === true ||
    req.user?.isSuperAdmin === true
  );
}

function requireOwner(req, res) {
  if (isSuperadmin(req)) return null;

  const v = req.get("x-provider-id");
  if (!v || !mongoose.isValidObjectId(v)) {
    res
      .status(401)
      .json({ ok: false, error: "Unauthorized: missing/invalid provider" });
    return null;
  }
  return new Types.ObjectId(v);
}

function requireId(req, res) {
  const id = String(req.params.id || "").trim();
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ ok: false, error: "Invalid id" });
    return null;
  }
  return id;
}

module.exports = { requireOwner, requireId };

// //routes\customers\helpers\require.js
// "use strict";

// const mongoose = require("mongoose");
// const { Types } = mongoose;

// function requireOwner(req, res) {
//   const v = req.get("x-provider-id");
//   if (!v || !mongoose.isValidObjectId(v)) {
//     res
//       .status(401)
//       .json({ ok: false, error: "Unauthorized: missing/invalid provider" });
//     return null;
//   }
//   return new Types.ObjectId(v);
// }

// function requireId(req, res) {
//   const id = String(req.params.id || "").trim();
//   if (!mongoose.isValidObjectId(id)) {
//     res.status(400).json({ ok: false, error: "Invalid id" });
//     return null;
//   }
//   return id;
// }

// module.exports = { requireOwner, requireId };
