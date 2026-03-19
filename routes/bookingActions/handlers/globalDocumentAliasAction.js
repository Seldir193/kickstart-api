//routes/bookingActions/handlers/globalDocumentAliasAction.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../models/Customer");
const { requireOwner } = require("../helpers/provider");

async function globalDocumentAliasAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const bid = String(req.params.bid || "").trim();
    const t = String(req.params.type || "").toLowerCase();

    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: "Invalid booking id" });
    }

    const ALLOWED = new Set([
      "participation",
      "cancellation",
      "storno",
      "contract",
      "credit-note",
    ]);

    if (!ALLOWED.has(t)) {
      return res.status(400).json({ error: "Invalid document type" });
    }

    if (t === "credit-note") {
      return res.redirect(302, `/api/admin/bookings/${bid}/credit-note.pdf`);
    }

    const customer = await Customer.findOne({
      owner,
      "bookings.bookingId": bid,
    }).lean();

    if (!customer) {
      return res.status(404).json({ error: "Customer not found for booking" });
    }

    return res.redirect(
      302,
      `/api/admin/customers/${customer._id}/bookings/${bid}/${t}.pdf`,
    );
  } catch (err) {
    console.error("[alias-documents] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { globalDocumentAliasAction };

// //routes\bookingActions\handlers\globalDocumentAliasAction.js
// const mongoose = require("mongoose");

// const Customer = require("../../../models/Customer");
// const { requireOwner } = require("../helpers/provider");

// async function globalDocumentAliasAction(req, res) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;
//     const { bid, type } = req.params;

//     if (!mongoose.isValidObjectId(bid)) {
//       return res.status(400).json({ error: "Invalid booking id" });
//     }

//     const ALLOWED = new Set([
//       "participation",
//       "cancellation",
//       "storno",
//       "contract",
//       "credit-note",
//     ]);

//     const t = String(type || "").toLowerCase();
//     if (!ALLOWED.has(t)) {
//       return res.status(400).json({ error: "Invalid document type" });
//     }

//     if (t === "credit-note") {
//       return res.redirect(302, `/api/admin/bookings/${bid}/credit-note.pdf`);
//     }

//     const customer = await Customer.findOne({ owner, "bookings._id": bid });
//     if (!customer)
//       return res.status(404).json({ error: "Customer not found for booking" });

//     const redirectPath = `/api/admin/customers/${customer._id}/bookings/${bid}/${t}.pdf`;
//     return res.redirect(302, redirectPath);
//   } catch (err) {
//     console.error("[alias-documents] error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { globalDocumentAliasAction };
