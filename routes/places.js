// routes/places.js
'use strict';
const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const Place  = require('../models/Place');
const Offer  = require('../models/Offer'); // for delete protection

// helper: provider scope from header
function ownerId(req) {
  const v = req.get('X-Provider-Id') || req.headers['x-provider-id'];
  if (!v) return null;
  try { return new mongoose.Types.ObjectId(String(v)); } catch { return null; }
}
const { isValidObjectId, Types } = mongoose;

// GET /api/places
router.get('/', async (req, res) => {
  const owner = ownerId(req);
  if (!owner) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const q     = (req.query.q || '').toString().trim().toLowerCase();
  const page  = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '10', 10)));

  const filter = { owner };
  if (q) {
    filter.$or = [
      { name:    { $regex: q, $options: 'i' } },
      { city:    { $regex: q, $options: 'i' } },
      { zip:     { $regex: q, $options: 'i' } },
      { address: { $regex: q, $options: 'i' } },
    ];
  }
  // optional direct filters:
  ['name','zip','city'].forEach(k => {
    if (req.query[k]) filter[k] = { $regex: String(req.query[k]), $options: 'i' };
  });

  const total = await Place.countDocuments(filter);
  const items = await Place.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.json({ ok: true, items, total, page, limit });
});

// POST /api/places






router.post('/', async (req, res) => {
  const owner = ownerId(req);
  if (!owner) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const zip  = String(body.zip  || '').trim();
    const city = String(body.city || '').trim();
    if (!name || !zip || !city) {
      return res.status(400).json({ ok: false, error: 'name, zip and city are required' });
    }

    const doc = new Place({
      owner,
      name,
      address: String(body.address || '').trim(),
      zip,
      city,
      lat: body.lat,
      lng: body.lng,
      publicId: body.publicId,
    });

    await doc.validate(); // computes canonicalKey & publicId
    await doc.save();
    res.status(201).json({ ok: true, item: doc });
  } catch (err) {
    // keeps duplicate as 409
    if (err && err.code === 11000) {
      return res.status(409).json({ ok: false, error: 'Place already exists (same name/ZIP/city).' });
    }
    console.error('POST /api/places failed:', err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});



// PUT /api/places/:id
router.put('/:id', async (req, res) => {
  const owner = ownerId(req);
  if (!owner) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const id = req.params.id;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, error: 'Invalid place id' });

  try {
    const body = req.body || {};
    const p = await Place.findOne({ _id: id, owner });
    if (!p) return res.status(404).json({ ok: false, error: 'Not found' });

    p.name    = (body.name ?? p.name)?.trim?.() ?? p.name;
    p.address = (body.address ?? p.address)?.trim?.() ?? p.address;
    p.zip     = (body.zip ?? p.zip)?.trim?.() ?? p.zip;
    p.city    = (body.city ?? p.city)?.trim?.() ?? p.city;
    if (body.lat !== undefined) p.lat = (body.lat === '' || body.lat == null) ? undefined : Number(body.lat);
    if (body.lng !== undefined) p.lng = (body.lng === '' || body.lng == null) ? undefined : Number(body.lng);
    if (body.publicId != null) p.publicId = body.publicId;

    await p.validate(); // recompute canonicalKey
    await p.save();
    res.json({ ok: true, item: p });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ ok: false, error: 'Place already exists (same name/ZIP/city).' });
    }
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// DELETE /api/places/:id
router.delete('/:id', async (req, res) => {
  const owner = ownerId(req);
  if (!owner) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const id = req.params.id;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, error: 'Invalid place id' });

  // BLOCK delete if any offer references this place
  const used = await Offer.countDocuments({ owner, placeId: new Types.ObjectId(id) });
  if (used > 0) {
    return res.status(409).json({ ok: false, error: `Place is used by ${used} offer(s).` });
  }

  const r = await Place.deleteOne({ _id: id, owner });
  if (r.deletedCount === 0) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, deleted: 1 });
});

module.exports = router;
