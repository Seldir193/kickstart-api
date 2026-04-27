"use strict";

const express = require("express");
const router = express.Router();
const Feedback = require("../models/Feedback");
const adminAuth = require("../middleware/adminAuth");

const categories = ["parents", "players", "coaches", "partners"];

function clean(value) {
  return String(value ?? "").trim();
}

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function ok(res, payload) {
  return send(res, 200, { ok: true, ...payload });
}

function fail(res, status, error) {
  return send(res, status, { ok: false, error });
}

function wrap(handler) {
  return (req, res) =>
    Promise.resolve(handler(req, res)).catch((error) =>
      fail(res, 500, clean(error?.message || "Error")),
    );
}

function requireSuper(req, res, next) {
  if (req.isSuperAdmin === true) return next();
  return fail(res, 403, "Forbidden");
}

function toBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLocalized(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    de: clean(input.de),
    en: clean(input.en),
    tr: clean(input.tr),
  };
}

function normalizeBody(body) {
  return {
    category: clean(body.category),
    imageUrl: clean(body.imageUrl),
    quote: normalizeLocalized(body.quote),
    author: clean(body.author),
    meta: normalizeLocalized(body.meta),
    isActive: toBool(body.isActive, true),
    sortOrder: toNumber(body.sortOrder, 100),
  };
}

function validateBody(body) {
  if (!categories.includes(body.category)) return "Invalid category";
  if (!body.quote.de && !body.quote.en && !body.quote.tr)
    return "Quote required";
  if (!body.author) return "Author required";
  return "";
}

function buildQuery(req) {
  const query = {};
  const category = clean(req.query.category);
  const active = clean(req.query.isActive);

  if (categories.includes(category)) query.category = category;
  if (active === "true") query.isActive = true;
  if (active === "false") query.isActive = false;

  return query;
}

router.get(
  "/",
  adminAuth,
  requireSuper,
  wrap(async (req, res) => {
    const query = buildQuery(req);
    const items = await Feedback.find(query)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return ok(res, { items });
  }),
);

router.post(
  "/",
  adminAuth,
  requireSuper,
  wrap(async (req, res) => {
    const body = normalizeBody(req.body || {});
    const error = validateBody(body);

    if (error) return fail(res, 400, error);

    const created = await Feedback.create({
      ...body,
      createdBy: req.providerId || null,
      updatedBy: req.providerId || null,
    });

    return send(res, 201, { ok: true, item: created });
  }),
);

router.patch(
  "/:id",
  adminAuth,
  requireSuper,
  wrap(async (req, res) => {
    const body = normalizeBody(req.body || {});
    const error = validateBody(body);

    if (error) return fail(res, 400, error);

    const updated = await Feedback.findByIdAndUpdate(
      req.params.id,
      { ...body, updatedBy: req.providerId || null },
      { new: true },
    );

    if (!updated) return fail(res, 404, "Not found");
    return ok(res, { item: updated });
  }),
);

router.delete(
  "/:id",
  adminAuth,
  requireSuper,
  wrap(async (req, res) => {
    const deleted = await Feedback.findByIdAndDelete(req.params.id);

    if (!deleted) return fail(res, 404, "Not found");
    return ok(res, {});
  }),
);

module.exports = router;
