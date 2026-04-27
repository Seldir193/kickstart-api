"use strict";

const express = require("express");
const router = express.Router();
const Feedback = require("../models/Feedback");

const languages = ["de", "en", "tr"];
const labels = {
  parents: { de: "Eltern", en: "Parents", tr: "Veliler" },
  players: { de: "Spieler", en: "Players", tr: "Oyuncular" },
  coaches: { de: "Trainer", en: "Coaches", tr: "Antrenörler" },
  partners: { de: "Partner", en: "Partners", tr: "Partnerler" },
};

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeLanguage(value) {
  const language = clean(value).toLowerCase();
  return languages.includes(language) ? language : "de";
}

function localized(value, language) {
  if (!value || typeof value !== "object") return "";
  return clean(value[language] || value.de || value.en || value.tr);
}

function serialize(item, language) {
  return {
    id: String(item._id),
    category: item.category,
    label: labels[item.category]?.[language] || item.category,
    img: item.imageUrl || "",
    quote: localized(item.quote, language),
    author: clean(item.author),
    meta: localized(item.meta, language),
    sortOrder: item.sortOrder,
  };
}

router.get("/", async (req, res) => {
  try {
    const language = normalizeLanguage(req.query.lang);
    const items = await Feedback.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      items: items.map((item) => serialize(item, language)),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: clean(error?.message || "Error"),
    });
  }
});

module.exports = router;
