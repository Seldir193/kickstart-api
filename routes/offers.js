































// routes/offers.js
const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;
const Offer = require('../models/Offer');

const router = express.Router();

/* ===================== Helpers ===================== */

// gültige Wochentage normalisieren
const ALLOWED_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
function sanitizeDays(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const s = String(v).trim().toLowerCase();
    if (ALLOWED_DAYS.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// Owner aus Header lesen (raw)
function getProviderIdRaw(req) {
  const v = req.get('x-provider-id');
  return v ? String(v).trim() : null;
}

// Owner als ObjectId validieren/casten
function getProviderObjectId(req) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) return null;
  return new Types.ObjectId(raw);
}
function requireProviderObjectId(req, res) {
  const oid = getProviderObjectId(req);
  if (!oid) {
    res.status(401).json({ ok: false, error: 'Unauthorized: invalid provider id' });
    return null;
  }
  return oid;
}

// OfferId prüfen
function requireOfferId(req, res) {
  const id = String(req.params.id || '').trim();
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid offer id' });
    return null;
  }
  return id;
}

// Payload prüfen (Minimalvalidierung wie bisher)
function validateOfferBody(b) {
  const errors = {};
  if (!b.type) errors.type = 'type is required';
  if (!b.location || !String(b.location).trim()) errors.location = 'location is required';
  if (b.price == null || Number(b.price) < 0) errors.price = 'price must be >= 0';
  if (!b.timeFrom) errors.timeFrom = 'timeFrom is required';
  if (!b.timeTo) errors.timeTo = 'timeTo is required';
  if (b.ageFrom != null && b.ageTo != null && Number(b.ageFrom) > Number(b.ageTo)) {
    errors.age = 'ageFrom must be <= ageTo';
  }
  return errors;
}

/* ===================== Routes ===================== */

/**
 * GET /api/offers
 * - Admin (mit X-Provider-Id): nur eigene Offers (kein onlineActive-Filter)
 * - Public (ohne Header): nur onlineActive=true
 * Query: ?type=&location=&q=&page=&limit=
 */
router.get('/', async (req, res) => {
  try {
    const { type, location, q, page = 1, limit = 10 } = req.query;

    const pidRaw = getProviderIdRaw(req);
    const filter = {};
    if (pidRaw) {
      const owner = getProviderObjectId(req);
      if (!owner) return res.status(401).json({ ok: false, error: 'Unauthorized: invalid provider id' });
      filter.owner = owner;
    } else {
      filter.onlineActive = true;
    }

    if (type) filter.type = String(type);
    if (location) filter.location = String(location);

    if (q && String(q).trim().length >= 2) {
      const needle = String(q).trim();
      filter.$or = [
        { title:    { $regex: needle, $options: 'i' } },
        { info:     { $regex: needle, $options: 'i' } },
        { location: { $regex: needle, $options: 'i' } },
        { type:     { $regex: needle, $options: 'i' } },
      ];
    }

    const p = Math.max(1, Number(page));
    const l = Math.max(1, Math.min(100, Number(limit)));
    const skip = (p - 1) * l;

    const [items, total] = await Promise.all([
      Offer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
      Offer.countDocuments(filter),
    ]);

    return res.json({ items, total });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/offers/:id
 * - Admin: nur eigenes Offer (owner=Provider)
 * - Public: beliebiges Offer (ohne onlineActive-Filter, Buchung möglich)
 */
router.get('/:id', async (req, res) => {
  try {
    const id = requireOfferId(req, res);
    if (!id) return;

    const pidRaw = getProviderIdRaw(req);
    const doc = pidRaw
      ? await Offer.findOne({ _id: id, owner: getProviderObjectId(req) }).lean()
      : await Offer.findById(id).lean();

    if (!doc) return res.status(404).json({ error: 'Offer not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid offer id' });
  }
});

/**
 * POST /api/offers
 * - Admin only (X-Provider-Id required)
 * Body: { type, location, price, days, timeFrom, timeTo, ageFrom?, ageTo?, info?, onlineActive?, coachName?, coachEmail?, coachImage? }
 */
router.post('/', async (req, res) => {
  try {
    const owner = requireProviderObjectId(req, res);
    if (!owner) return;

    const b = req.body || {};
    const errors = validateOfferBody(b);
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const title = [String(b.type), String(b.location).trim()].filter(Boolean).join(' • ');

    const doc = await Offer.create({
      owner,
      type: String(b.type),
      location: String(b.location).trim(),
      price: Number(b.price),
      days: sanitizeDays(b.days),
      timeFrom: String(b.timeFrom),
      timeTo: String(b.timeTo),
      ageFrom: b.ageFrom === '' || b.ageFrom == null ? undefined : Number(b.ageFrom),
      ageTo:   b.ageTo   === '' || b.ageTo   == null ? undefined : Number(b.ageTo),
      info: b.info ? String(b.info) : '',
      onlineActive: b.onlineActive === false ? false : true,
      title,

      coachName:  b.coachName ? String(b.coachName).trim() : '',
      coachEmail: b.coachEmail ? String(b.coachEmail).trim() : '',
      coachImage: b.coachImage ? String(b.coachImage).trim() : '',
    });

    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/offers/:id
 * - Admin only (X-Provider-Id required)
 * - Update ist nur erlaubt für {_id, owner}
 */
router.put('/:id', async (req, res) => {
  try {
    const owner = requireProviderObjectId(req, res);
    if (!owner) return;

    const id = requireOfferId(req, res);
    if (!id) return;

    const b = req.body || {};
    const errors = validateOfferBody(b);
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const update = {
      type: String(b.type),
      location: String(b.location).trim(),
      price: Number(b.price),
      days: sanitizeDays(b.days),
      timeFrom: String(b.timeFrom),
      timeTo: String(b.timeTo),
      ageFrom: b.ageFrom === '' || b.ageFrom == null ? undefined : Number(b.ageFrom),
      ageTo:   b.ageTo   === '' || b.ageTo   == null ? undefined : Number(b.ageTo),
      info: b.info ? String(b.info) : '',
      onlineActive: !!b.onlineActive,
      title: [String(b.type), String(b.location).trim()].filter(Boolean).join(' • '),

      coachName:  b.coachName ? String(b.coachName).trim() : '',
      coachEmail: b.coachEmail ? String(b.coachEmail).trim() : '',
      coachImage: b.coachImage ? String(b.coachImage).trim() : '',
    };

    const doc = await Offer.findOneAndUpdate(
      { _id: id, owner },
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ error: 'Offer not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid offer id' });
  }
});

/**
 * DELETE /api/offers/:id
 * - Admin only (X-Provider-Id required)
 * - Löscht nur, wenn {_id, owner} passt
 */
router.delete('/:id', async (req, res) => {
  try {
    const owner = requireProviderObjectId(req, res);
    if (!owner) return;

    const id = requireOfferId(req, res);
    if (!id) return;

    const d = await Offer.deleteOne({ _id: id, owner });
    if (!d.deletedCount) return res.status(404).json({ error: 'Offer not found' });
    return res.json({ ok: true, id });
  } catch (err) {
    return res.status(400).json({ error: 'Invalid offer id' });
  }
});

module.exports = router;

