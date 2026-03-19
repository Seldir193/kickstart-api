"use strict";

const Customer = require("../../../models/Customer");
const { syncCustomerNewsletter } = require("../../../services/marketingSync");

function coerceBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

async function patchNewsletter(req, res) {
  try {
    const id = req.params.id || req.params.cid;
    const want = coerceBool(req.body?.newsletter);

    const providerId =
      req.headers["x-provider-id"] || req.user?.providerId || null;

    const filter = providerId ? { _id: id, providerId } : { _id: id };

    const doc = await Customer.findOne(filter);
    if (!doc)
      return res.status(404).json({ ok: false, error: "Customer not found" });

    doc.newsletter = want;
    if (want && !doc.marketingConsentAt) {
      doc.marketingConsentAt = new Date();
    }

    const email = String(req.body?.email || "").trim();

    const r = await syncCustomerNewsletter(doc, want, {
      mutate: true,
      email: email || undefined,
    });

    if (r?.ok === false) {
      return res
        .status(400)
        .json({ ok: false, error: r.error || "Sync failed" });
    }

    await doc.save();

    const fresh = await Customer.findById(doc._id).lean();
    return res.json({ ok: true, customer: fresh });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Newsletter update failed",
    });
  }
}

module.exports = { patchNewsletter };

// //routes\customers\handlers\patchNewsletter.js
// "use strict";

// const Customer = require("../../../models/Customer");

// async function patchNewsletter(req, res, syncCustomerNewsletter) {
//   try {
//     const { id } = req.params;
//     const want = !!req.body?.newsletter;

//     const providerId =
//       req.headers["x-provider-id"] || req.user?.providerId || null;

//     const filter = providerId ? { _id: id, providerId } : { _id: id };

//     const doc = await Customer.findOne(filter);
//     if (!doc)
//       return res.status(404).json({ ok: false, error: "Customer not found" });

//     doc.newsletter = want;
//     if (want && !doc.marketingConsentAt) {
//       doc.marketingConsentAt = new Date();
//     }

//     const r = await syncCustomerNewsletter(doc, want, { mutate: true });
//     if (r?.ok === false) {
//       return res
//         .status(400)
//         .json({ ok: false, error: r.error || "Sync failed" });
//     }

//     await doc.save();

//     const fresh = await Customer.findById(doc._id).lean();
//     res.json({ ok: true, customer: fresh });
//   } catch (err) {
//     console.error("PATCH /customers/:id/newsletter failed:", err);
//     res.status(500).json({ ok: false, error: "Newsletter update failed" });
//   }
// }

// module.exports = { patchNewsletter };
