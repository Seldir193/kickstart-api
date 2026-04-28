"use strict";

const express = require("express");
const router = express.Router();
const Partner = require("../models/Partner");

function clean(value) {
  return String(value ?? "").trim();
}

function serialize(item) {
  return {
    id: String(item._id),
    name: clean(item.name),
    label: clean(item.name),
    logoUrl: clean(item.logoUrl),
    logo: clean(item.logoUrl),
    url: clean(item.url),
    sortOrder: item.sortOrder,
  };
}

router.get("/", async (_req, res) => {
  try {
    const items = await Partner.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      items: items.map(serialize),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: clean(error?.message || "Error"),
    });
  }
});

module.exports = router;
