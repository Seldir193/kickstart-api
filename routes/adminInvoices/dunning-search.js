//routes\adminInvoices\dunning-search.js
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const { Types } = mongoose;

const BillingDocument = require("../../models/BillingDocument");

const router = express.Router();

function getProviderIdRaw(req) {
  const v = req.get("x-provider-id");
  return v ? String(v).trim() : null;
}

function requireOwner(req, res) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) {
    res
      .status(401)
      .json({ ok: false, error: "Unauthorized: invalid provider id" });
    return null;
  }
  return new Types.ObjectId(raw);
}

function safeResolve(baseDir, relPath) {
  const abs = path.resolve(baseDir, relPath || "");
  if (!abs.startsWith(baseDir)) return null;
  return abs;
}

router.get("/dunning-documents/search", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    const stage = String(req.query.stage || "").trim();
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const filter = {
      owner: String(owner),
      kind: "dunning",
    };

    if (stage) filter.stage = stage;

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { fileName: rx },
        { invoiceNo: rx },
        { customerNo: rx },
        { subject: rx },
        { offerTitle: rx },
        { searchText: rx },
      ];
    }

    const items = await BillingDocument.find(filter)
      .sort({ sentAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("[adminInvoices] GET /dunning-documents/search error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.get("/dunning-documents/:id/download", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = String(req.params.id || "").trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid id" });
    }

    const doc = await BillingDocument.findOne({
      _id: new Types.ObjectId(id),
      owner: String(owner),
      kind: "dunning",
    }).lean();

    if (!doc) {
      return res.status(404).json({ ok: false, error: "Document not found" });
    }

    const baseDir = process.env.DOCS_DIR
      ? path.resolve(process.cwd(), process.env.DOCS_DIR)
      : path.resolve(process.cwd(), "uploads", "documents");

    const absPath = safeResolve(baseDir, doc.filePath);
    if (!absPath) {
      return res.status(400).json({ ok: false, error: "Invalid file path" });
    }

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ ok: false, error: "File missing" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(doc.fileName || "document.pdf").replace(/"/g, "")}"`,
    );

    return fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    console.error(
      "[adminInvoices] GET /dunning-documents/:id/download error:",
      err,
    );
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/dunning-documents/:id/void", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = String(req.params.id || "").trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid id" });
    }

    const body = req.body || {};
    const reason = String(body.reason || body.voidedReason || "").trim();
    const sendEmail = Boolean(body.sendEmail);

    const doc = await BillingDocument.findOne({
      _id: new Types.ObjectId(id),
      owner: String(owner),
      kind: "dunning",
    });

    if (!doc) {
      return res.status(404).json({ ok: false, error: "Document not found" });
    }

    if (doc.voidedAt) {
      return res.status(409).json({ ok: false, error: "Already voided" });
    }

    doc.voidedAt = new Date();
    doc.voidedReason = reason;
    doc.voidedBy = String(owner);
    await doc.save();

    // optional customer mail: keep minimal, call if mailer provides it
    if (sendEmail) {
      const mailer = require("../../utils/mailer");
      if (typeof mailer.sendDunningVoidedEmail !== "function") {
        return res.status(500).json({
          ok: false,
          error: "Mailer missing: sendDunningVoidedEmail",
        });
      }

      await mailer.sendDunningVoidedEmail({
        owner,
        billingDocument: doc.toObject ? doc.toObject() : doc,
        reason,
      });
    }

    return res.json({
      ok: true,
      id: String(doc._id),
      voidedAt: doc.voidedAt,
      voidedReason: doc.voidedReason,
    });
  } catch (err) {
    console.error(
      "[adminInvoices] POST /dunning-documents/:id/void error:",
      err,
    );
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
