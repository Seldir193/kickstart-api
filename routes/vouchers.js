"use strict";

const express = require("express");
const adminAuth = require("../middleware/adminAuth");
const Voucher = require("../models/Voucher");
const requireProvider = require("../middleware/requireProvider");

const router = express.Router();

function safeText(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// function providerIdFrom(req) {
//   return safeText(
//     req.get("x-provider-id") || req.body?.owner || req.query?.owner,
//   );
// }

function providerIdFrom(req) {
  return safeText(
    req.providerId ||
      req.get("x-provider-id") ||
      req.body?.owner ||
      req.query?.owner,
  );
}

router.get("/", adminAuth, requireProvider, async (req, res) => {
  try {
    const owner = providerIdFrom(req);
    if (!owner) {
      return res.status(400).json({ ok: false, error: "Missing provider id" });
    }

    const items = await Voucher.find({ owner }).sort({ createdAt: -1 }).lean();

    return res.json({ ok: true, vouchers: items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/", adminAuth, requireProvider, async (req, res) => {
  try {
    console.log("[vouchers POST] req.body", req.body);
    const owner = providerIdFrom(req);
    const code = safeText(req.body?.code).toUpperCase();
    const amount = Number(req.body?.amount);
    const active = req.body?.active !== false;

    if (!owner) {
      return res.status(400).json({ ok: false, error: "Missing provider id" });
    }

    if (!code) {
      return res.status(400).json({ ok: false, error: "Code is required" });
    }

    if (!Number.isFinite(amount) || amount < 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Amount must be a valid number" });
    }

    const voucher = await Voucher.create({
      owner,
      code,
      amount,
      active,
    });

    return res.status(201).json({ ok: true, voucher });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        error: "Voucher code already exists for this provider",
      });
    }

    console.error(err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.patch("/:id", adminAuth, requireProvider, async (req, res) => {
  try {
    const patch = {};
    if (req.body?.code != null)
      patch.code = safeText(req.body.code).toUpperCase();
    if (req.body?.amount != null) patch.amount = Number(req.body.amount);
    if (req.body?.active != null) patch.active = req.body.active === true;

    if (
      patch.amount != null &&
      (!Number.isFinite(patch.amount) || patch.amount < 0)
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "Amount must be a valid number" });
    }

    // const voucher = await Voucher.findByIdAndUpdate(req.params.id, patch, {
    //   new: true,
    //   runValidators: true,
    // });

    const owner = providerIdFrom(req);
    if (!owner) {
      return res.status(400).json({ ok: false, error: "Missing provider id" });
    }

    const voucher = await Voucher.findOneAndUpdate(
      { _id: req.params.id, owner },
      patch,
      { new: true, runValidators: true },
    );

    if (!voucher) {
      return res.status(404).json({ ok: false, error: "Voucher not found" });
    }

    return res.json({ ok: true, voucher });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        error: "Voucher code already exists for this provider",
      });
    }

    console.error(err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.delete("/:id", adminAuth, requireProvider, async (req, res) => {
  try {
    //const voucher = await Voucher.findByIdAndDelete(req.params.id);
    const owner = providerIdFrom(req);
    if (!owner) {
      return res.status(400).json({ ok: false, error: "Missing provider id" });
    }

    const voucher = await Voucher.findOneAndDelete({
      _id: req.params.id,
      owner,
    });
    if (!voucher) {
      return res.status(404).json({ ok: false, error: "Voucher not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
