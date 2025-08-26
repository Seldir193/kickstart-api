








// routes/offers.js
const express = require('express');
const router = express.Router();
const Offer = require('../models/Offer');

/** Normalize/sanitize days array */
const ALLOWED_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
function sanitizeDays(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const s = String(v).toLowerCase();
    if (ALLOWED_DAYS.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * GET /api/offers
 * Query: ?type=&location=&q=&page=&limit=
 * Returns only onlineActive=true
 */
router.get('/', async (req, res) => {
  try {
    const { type, location, q, page = 1, limit = 10 } = req.query;

    const filter = { onlineActive: true };
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

    res.json({ items, total });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/offers/:id
 * Return single offer (no onlineActive filter, so booking works even if toggled later)
 */
router.get('/:id', async (req, res) => {
  try {
    const doc = await Offer.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Offer not found' });
    res.json(doc);
  } catch (e) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

/**
 * POST /api/offers
 * Body: { type, location, price, days, timeFrom, timeTo, ageFrom?, ageTo?, info?, onlineActive? }
 */
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const errors = {};
    if (!b.type) errors.type = 'type is required';
    if (!b.location || !String(b.location).trim()) errors.location = 'location is required';
    if (b.price == null || Number(b.price) < 0) errors.price = 'price must be >= 0';
    if (!b.timeFrom) errors.timeFrom = 'timeFrom is required';
    if (!b.timeTo) errors.timeTo = 'timeTo is required';
    if (b.ageFrom != null && b.ageTo != null && Number(b.ageFrom) > Number(b.ageTo)) {
      errors.age = 'ageFrom must be <= ageTo';
    }
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const title = [String(b.type), String(b.location).trim()].filter(Boolean).join(' • ');

    const doc = await Offer.create({
      type: String(b.type),
      location: String(b.location).trim(),
      price: Number(b.price),
      days: sanitizeDays(b.days),
      timeFrom: String(b.timeFrom),
      timeTo: String(b.timeTo),
      ageFrom: b.ageFrom === '' || b.ageFrom == null ? undefined : Number(b.ageFrom),
      ageTo:   b.ageTo   === '' || b.ageTo   == null ? undefined : Number(b.ageTo),
      info: b.info ? String(b.info) : '',
      onlineActive: b.onlineActive === false ? false : true, // default true
      title,
    });

    res.status(201).json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/offers/:id
 */
router.put('/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const errors = {};
    if (!b.type) errors.type = 'type is required';
    if (!b.location || !String(b.location).trim()) errors.location = 'location is required';
    if (b.price == null || Number(b.price) < 0) errors.price = 'price must be >= 0';
    if (!b.timeFrom) errors.timeFrom = 'timeFrom is required';
    if (!b.timeTo) errors.timeTo = 'timeTo is required';
    if (b.ageFrom != null && b.ageTo != null && Number(b.ageFrom) > Number(b.ageTo)) {
      errors.age = 'ageFrom must be <= ageTo';
    }
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
    };

    const doc = await Offer.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ error: 'Offer not found' });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

/**
 * DELETE /api/offers/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const d = await Offer.findByIdAndDelete(req.params.id);
    if (!d) return res.status(404).json({ error: 'Offer not found' });
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

module.exports = router;











