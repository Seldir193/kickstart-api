// routes/coaches.js
const express = require('express');
const Coach = require('../models/Coach');
const router = express.Router();

// GET /api/coaches?q=&page=&limit=
router.get('/', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const q     = (req.query.q || '').trim();

  const filter = {};
  if (q.length >= 2) {
    filter.$or = [
      { name:      { $regex: q, $options: 'i' } },
      { firstName: { $regex: q, $options: 'i' } },
      { lastName:  { $regex: q, $options: 'i' } },
      { position:  { $regex: q, $options: 'i' } },
    ];
  }

  const total = await Coach.countDocuments(filter);
  const items = await Coach.find(filter)
    .sort({ lastName: 1, firstName: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.json({ items, total, page, limit });
});

// GET /api/coaches/:slug
router.get('/:slug', async (req, res) => {
  const c = await Coach.findOne({ slug: req.params.slug.toLowerCase() }).lean();
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// POST /api/coaches
router.post('/', async (req, res) => {
  const body = req.body || {};
  const slug = (body.slug || `${(body.firstName||'').trim()} ${(body.lastName||'').trim()}` || body.name || '')
    .toLowerCase().trim().replace(/\s+/g, '-');

  if (!slug) return res.status(400).json({ error: 'Missing slug/name' });

  const doc = await Coach.create({ ...body, slug });
  res.status(201).json(doc);
});

// PATCH /api/coaches/:slug
router.patch('/:slug', async (req, res) => {
  const updates = { ...req.body };
  if (updates.slug) delete updates.slug; // slug bleibt Key
  const doc = await Coach.findOneAndUpdate(
    { slug: req.params.slug.toLowerCase() },
    updates,
    { new: true, runValidators: true }
  ).lean();
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

// DELETE /api/coaches/:slug
router.delete('/:slug', async (req, res) => {
  const r = await Coach.deleteOne({ slug: req.params.slug.toLowerCase() });
  if (r.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
