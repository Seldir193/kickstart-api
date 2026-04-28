"use strict";

const express = require("express");
const router = express.Router();
const Partner = require("../models/Partner");
const adminAuth = require("../middleware/adminAuth");

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
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

function normalizeBody(body) {
  const name = clean(body.name || body.label);

  return {
    name,
    normalizedName: normalizeName(name),
    logoUrl: clean(body.logoUrl || body.logo || body.src),
    url: clean(body.url),
    isActive: toBool(body.isActive, true),
    sortOrder: toNumber(body.sortOrder, 100),
  };
}

function validateBody(body) {
  if (!body.name) return "Name required";
  if (!body.logoUrl) return "Logo required";
  return "";
}

function buildQuery(req) {
  const query = {};
  const active = clean(req.query.isActive);

  if (active === "true") query.isActive = true;
  if (active === "false") query.isActive = false;

  return query;
}

async function findDuplicate(body, excludeId = "") {
  const query = { normalizedName: body.normalizedName };
  if (excludeId) query._id = { $ne: excludeId };
  return Partner.findOne(query).select("_id").lean();
}

async function validateUniqueName(body, excludeId = "") {
  const duplicate = await findDuplicate(body, excludeId);
  return duplicate ? "Partner already exists" : "";
}

router.get(
  "/",
  adminAuth,
  requireSuper,
  wrap(async (req, res) => {
    const items = await Partner.find(buildQuery(req))
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
    const error = validateBody(body) || (await validateUniqueName(body));

    if (error) return fail(res, error.includes("exists") ? 409 : 400, error);

    const item = await Partner.create({
      ...body,
      createdBy: req.providerId || null,
      updatedBy: req.providerId || null,
    });

    return send(res, 201, { ok: true, item });
  }),
);

router.patch(
  "/:id",
  adminAuth,
  requireSuper,
  wrap(async (req, res) => {
    const body = normalizeBody(req.body || {});
    const error =
      validateBody(body) || (await validateUniqueName(body, req.params.id));

    if (error) return fail(res, error.includes("exists") ? 409 : 400, error);

    const item = await Partner.findByIdAndUpdate(
      req.params.id,
      { ...body, updatedBy: req.providerId || null },
      { new: true },
    );

    if (!item) return fail(res, 404, "Not found");
    return ok(res, { item });
  }),
);

router.delete(
  "/:id",
  adminAuth,
  requireSuper,
  wrap(async (req, res) => {
    const deleted = await Partner.findByIdAndDelete(req.params.id);

    if (!deleted) return fail(res, 404, "Not found");
    return ok(res, {});
  }),
);

module.exports = router;
