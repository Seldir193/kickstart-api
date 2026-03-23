"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const BillingDocument = require("../../../../models/BillingDocument");

async function downloadBillingInvoice(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const customerId = requireId(req, res);
    if (!customerId) return;

    const documentId = String(req.params.documentId || "").trim();

    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ error: "Invalid document id" });
    }

    const customer = await Customer.findOne({ _id: customerId, owner }).lean();

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const bookingIds = (
      Array.isArray(customer.bookings) ? customer.bookings : []
    )
      .map((b) => String(b?.bookingId || b?._id || ""))
      .filter((v) => v && mongoose.isValidObjectId(v));

    const doc = await BillingDocument.findOne({
      _id: documentId,
      owner: String(owner),
      kind: "invoice",
      bookingId: { $in: bookingIds },
      voidedAt: null,
    }).lean();

    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }

    res.setHeader("Content-Type", doc.mimeType || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(doc.fileName || "invoice.pdf").replace(/"/g, "")}"`,
    );

    return res.sendFile(doc.filePath);
  } catch (err) {
    console.error("[customers] billing invoice download error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { downloadBillingInvoice };
