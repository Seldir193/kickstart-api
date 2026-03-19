// routes/customers/handlers/listCustomers.js
"use strict";

const Customer = require("../../../models/Customer");
const { buildFilter } = require("../helpers/buildFilter");

function isSuperadmin(req) {
  return (
    req.user?.role === "superadmin" ||
    req.user?.isSuperadmin === true ||
    req.user?.isSuperAdmin === true
  );
}

async function listCustomers(req, res, requireOwner) {
  try {
    const owner = requireOwner(req, res);
    if (owner === null && !isSuperadmin(req)) return;

    const { page = 1, limit = 20, sort = "createdAt:desc" } = req.query;
    const [sortField, sortDir] = String(sort).split(":");
    const sortSpec = { [sortField || "createdAt"]: sortDir === "asc" ? 1 : -1 };

    const p = Math.max(1, Number(page));
    const l = Math.max(1, Math.min(100, Number(limit)));
    const skip = (p - 1) * l;

    const filter = buildFilter(req.query, owner);

    const [items, total] = await Promise.all([
      Customer.find(filter).sort(sortSpec).skip(skip).limit(l).lean(),
      Customer.countDocuments(filter),
    ]);

    res.json({ items, total, page: p, limit: l });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { listCustomers };

// //routes\customers\handlers\listCustomers.js
// "use strict";

// const Customer = require("../../../models/Customer");
// const { buildFilter } = require("../helpers/buildFilter");

// async function listCustomers(req, res, requireOwner) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const { page = 1, limit = 20, sort = "createdAt:desc" } = req.query;
//     const [sortField, sortDir] = String(sort).split(":");
//     const sortSpec = { [sortField || "createdAt"]: sortDir === "asc" ? 1 : -1 };

//     const p = Math.max(1, Number(page));
//     const l = Math.max(1, Math.min(100, Number(limit)));
//     const skip = (p - 1) * l;

//     const filter = buildFilter(req.query, owner);

//     const [items, total] = await Promise.all([
//       Customer.find(filter).sort(sortSpec).skip(skip).limit(l).lean(),
//       Customer.countDocuments(filter),
//     ]);

//     res.json({ items, total, page: p, limit: l });
//   } catch (err) {
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { listCustomers };
