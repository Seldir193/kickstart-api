// routes/offers.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const Offer = require('../models/Offer');
const Place = require('../models/Place');

const router = express.Router();

/* ===================== Helpers ===================== */

// Allowed weekdays normalizer
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

// Provider/owner header helpers
function getProviderIdRaw(req) {
  const v = req.get('x-provider-id') || req.headers['x-provider-id'];
  return v ? String(v).trim() : null;
}
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

// Offer id helper
function requireOfferId(req, res) {
  const id = String(req.params.id || '').trim();
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid offer id' });
    return null;
  }
  return id;
}

// Validate body: either placeId OR free-text location must be provided
function validateOfferBody(b) {
  const errors = {};
  if (!b.type) errors.type = 'type is required';
  if (!b.placeId && (!b.location || !String(b.location).trim())) {
    errors.location = 'location is required when placeId is not provided';
  }
  if (b.price == null || Number(b.price) < 0) errors.price = 'price must be >= 0';
  if (!b.timeFrom) errors.timeFrom = 'timeFrom is required';
  if (!b.timeTo) errors.timeTo = 'timeTo is required';
  if (b.ageFrom != null && b.ageTo != null && Number(b.ageFrom) > Number(b.ageTo)) {
    errors.age = 'ageFrom must be <= ageTo';
  }
  return errors;
}

// Build a human-readable location string from place
function formatLocationFromPlace(p) {
  if (!p) return '';
  const parts = [];
  if (p.name) parts.push(String(p.name).trim());
  const line2 = [p.zip, p.city].filter(Boolean).join(' ');
  const addr = [p.address, line2].filter(Boolean).join(', ');
  if (addr) parts.push(addr);
  return parts.join(' — ') || (p.city || '');
}

/* ===================== Routes ===================== */

/**
 * GET /api/offers
 * - Admin (with X-Provider-Id): only own offers
 * - Public (no header): only onlineActive = true
 * Supports filters: type, location (regex contains), q, category, sub_type, legacy_type, placeId
 */
// GET /api/offers
router.get('/', async (req, res) => {
  try {
    const {
      type,
      location,               // optional: still supported as regex on Offer.location
      city,                   // NEW: city filter from Places OR location text
      q,
      page = 1,
      limit = 10,
      category,
      sub_type,
      legacy_type,
      placeId,
      onlineActive            // optional explicit filter for admin lists
    } = req.query;

    const pidRaw = getProviderIdRaw(req);
    const base = {};
    if (pidRaw) {
      const owner = getProviderObjectId(req);
      if (!owner) return res.status(401).json({ ok: false, error: 'Unauthorized: invalid provider id' });
      base.owner = owner;
      if (onlineActive === 'true') base.onlineActive = true;
      if (onlineActive === 'false') base.onlineActive = false;
    } else {
      base.onlineActive = true;
    }

    if (type)        base.type        = String(type);
    if (legacy_type) base.legacy_type = String(legacy_type);
    if (category)    base.category    = String(category);
    if (sub_type)    base.sub_type    = String(sub_type);

    if (location) {
      const needle = String(location).trim();
      if (needle) base.location = { $regex: needle, $options: 'i' };
    }

    if (placeId && mongoose.isValidObjectId(String(placeId))) {
      base.placeId = new Types.ObjectId(String(placeId));
    }

    const and = [];

    // Full-text search (q)
    if (q && String(q).trim().length >= 2) {
      const needle = String(q).trim();
      and.push({
        $or: [
          { title:    { $regex: needle, $options: 'i' } },
          { info:     { $regex: needle, $options: 'i' } },
          { location: { $regex: needle, $options: 'i' } },
          { type:     { $regex: needle, $options: 'i' } },
          { sub_type: { $regex: needle, $options: 'i' } },
          { category: { $regex: needle, $options: 'i' } },
        ]
      });
    }

    // NEW: city filter ⇒ match by (a) Offer.location contains city OR (b) Offer.placeId in places with that city
    if (city) {
      const needle = String(city).trim();
      if (needle) {
        let placeIds = [];
        try {
          const placeFilter = { city: { $regex: needle, $options: 'i' } };
          if (pidRaw) placeFilter.owner = base.owner; // tenant scope
          placeIds = await Place.find(placeFilter).distinct('_id');
        } catch (_) { /* ignore */ }

        and.push({
          $or: [
            { location: { $regex: needle, $options: 'i' } },
            { placeId: { $in: placeIds } }
          ]
        });
      }
    }

    const filter = and.length ? { ...base, $and: and } : base;

    const p = Math.max(1, Number(page));
    const l = Math.max(1, Math.min(100, Number(limit)));
    const skip = (p - 1) * l;

    const [items, total] = await Promise.all([
      Offer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
      Offer.countDocuments(filter),
    ]);

    return res.json({ items, total, page: p, limit: l });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});


/**
 * GET /api/offers/:id
 * - Admin: must match owner
 * - Public: any offer (no onlineActive filter)
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
 * Body: supports placeId (preferred) OR legacy free-text location
 */
router.post('/', async (req, res) => {
  try {
    const owner = requireProviderObjectId(req, res);
    if (!owner) return;

    const b = req.body || {};
    const errors = validateOfferBody(b);
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    // Optional placeId validation + derive location
    let placeDoc = null;
    let placeId = null;
    if (b.placeId) {
      if (!mongoose.isValidObjectId(String(b.placeId))) {
        return res.status(400).json({ error: 'Invalid placeId' });
      }
      placeDoc = await Place.findOne({ _id: b.placeId, owner }).lean();
      if (!placeDoc) return res.status(400).json({ error: 'Invalid placeId' });
      placeId = placeDoc._id;
    }

    const locationStr = placeDoc
      ? formatLocationFromPlace(placeDoc)
      : String(b.location || '').trim();

    const title = [String(b.type), locationStr].filter(Boolean).join(' • ');

    const doc = await Offer.create({
      owner,
      placeId, // may be null
      type: String(b.type),
      location: locationStr, // ensure always set
      price: Number(b.price),
      days: sanitizeDays(b.days),
      timeFrom: String(b.timeFrom),
      timeTo: String(b.timeTo),
      ageFrom: b.ageFrom === '' || b.ageFrom == null ? undefined : Number(b.ageFrom),
      ageTo: b.ageTo === '' || b.ageTo == null ? undefined : Number(b.ageTo),
      info: b.info ? String(b.info) : '',
      onlineActive: b.onlineActive === false ? false : true,
      title,

      coachName: b.coachName ? String(b.coachName).trim() : '',
      coachEmail: b.coachEmail ? String(b.coachEmail).trim() : '',
      coachImage: b.coachImage ? String(b.coachImage).trim() : '',

      category: b.category ? String(b.category).trim() : '',
      sub_type: b.sub_type ? String(b.sub_type).trim() : '',
      legacy_type: b.legacy_type ? String(b.legacy_type).trim() : b.type,
    });

    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/offers/:id
 * - Admin only (X-Provider-Id required)
 * - Updates own offer only
 * - Accepts placeId to attach/detach place; location derived from place if present
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

    // Resolve place (optional)
    let placeDoc = null;
    let incomingPlaceIdDefined = false;
    if ('placeId' in b) {
      incomingPlaceIdDefined = true;
      if (b.placeId) {
        if (!mongoose.isValidObjectId(String(b.placeId))) {
          return res.status(400).json({ error: 'Invalid placeId' });
        }
        placeDoc = await Place.findOne({ _id: b.placeId, owner }).lean();
        if (!placeDoc) return res.status(400).json({ error: 'Invalid placeId' });
      }
    }

    // Find current doc
    const current = await Offer.findOne({ _id: id, owner });
    if (!current) return res.status(404).json({ error: 'Offer not found' });

    // Decide final placeId + location string
    let finalPlaceId = current.placeId;
    let finalLocation = String(current.location || '').trim();

    if (incomingPlaceIdDefined) {
      if (placeDoc) {
        finalPlaceId = placeDoc._id;
        finalLocation = formatLocationFromPlace(placeDoc);
      } else {
        // Explicitly cleared placeId (null/empty/undefined in body)
        finalPlaceId = undefined;
        finalLocation = String(b.location || finalLocation).trim();
      }
    } else if (b.location) {
      // location provided without touching placeId
      finalLocation = String(b.location).trim();
    }

    const update = {
      type: String(b.type),
      location: finalLocation,
      price: Number(b.price),
      days: sanitizeDays(b.days),
      timeFrom: String(b.timeFrom),
      timeTo: String(b.timeTo),
      ageFrom: b.ageFrom === '' || b.ageFrom == null ? undefined : Number(b.ageFrom),
      ageTo: b.ageTo === '' || b.ageTo == null ? undefined : Number(b.ageTo),
      info: b.info ? String(b.info) : '',
      onlineActive: !!b.onlineActive,
      title: [String(b.type), finalLocation].filter(Boolean).join(' • '),

      coachName: b.coachName ? String(b.coachName).trim() : '',
      coachEmail: b.coachEmail ? String(b.coachEmail).trim() : '',
      coachImage: b.coachImage ? String(b.coachImage).trim() : '',

      category: b.category ? String(b.category).trim() : '',
      sub_type: b.sub_type ? String(b.sub_type).trim() : '',
      legacy_type: b.legacy_type ? String(b.legacy_type).trim() : b.type,
    };

    // Build atomic update with optional unset
    const updateOps = { $set: update };
    if (incomingPlaceIdDefined) {
      if (finalPlaceId) {
        updateOps.$set.placeId = finalPlaceId;
        if (updateOps.$unset) delete updateOps.$unset.placeId;
      } else {
        updateOps.$unset = Object.assign({}, updateOps.$unset, { placeId: '' });
      }
    }

    const doc = await Offer.findOneAndUpdate(
      { _id: id, owner },
      updateOps,
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ error: 'Offer not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid offer id' });
  }
});





// PATCH /api/offers/:id  (partial update)
router.patch('/:id', async (req, res) => {
  try {
    const owner = requireProviderObjectId(req, res);
    if (!owner) return;

    const id = requireOfferId(req, res);
    if (!id) return;

    const b = req.body || {};
    // Whitelist: nur diese Felder dürfen geändert werden
    const ALLOWED = [
      'type','category','sub_type','legacy_type',
      'placeId','location',
      'price','days','timeFrom','timeTo','ageFrom','ageTo',
      'info','onlineActive',
      'coachName','coachEmail','coachImage'
    ];

    const update = {};
    for (const k of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(b, k)) update[k] = b[k];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No changes' });
    }

    // Bestehendes Dokument laden
    const current = await Offer.findOne({ _id: id, owner });
    if (!current) return res.status(404).json({ error: 'Offer not found' });

    // placeId/Location-Logik wie in PUT, aber optional
    const ops = { $set: {}, $unset: {} };
    let finalLocation = String(current.location || '').trim();

    // 1) placeId kommt mit?
    if ('placeId' in update) {
      const raw = update.placeId;
      if (raw) {
        if (!mongoose.isValidObjectId(String(raw))) {
          return res.status(400).json({ error: 'Invalid placeId' });
        }
        const placeDoc = await Place.findOne({ _id: raw, owner }).lean();
        if (!placeDoc) return res.status(400).json({ error: 'Invalid placeId' });
        ops.$set.placeId = placeDoc._id;
        finalLocation = formatLocationFromPlace(placeDoc);
        ops.$set.location = finalLocation;
      } else {
        // placeId explizit entfernen
        ops.$unset.placeId = '';
        // Falls der Client KEINE location mitschickt, behalten wir die alte (kein Zwang)
        if (!('location' in update)) ops.$set.location = finalLocation;
      }
    }

    // 2) freie location kommt mit?
    if ('location' in update) {
      const loc = String(update.location || '').trim();
      if (loc) {
        ops.$set.location = loc;
        finalLocation = loc;
      } else {
        // leere location ignorieren (nicht löschen)
        delete ops.$set.location;
      }
    }

    // 3) sonstige Felder normalisieren & setzen
    if ('type' in update)        ops.$set.type    = String(update.type);
    if ('price' in update)       ops.$set.price   = Number(update.price);
    if ('days' in update)        ops.$set.days    = sanitizeDays(update.days);
    if ('timeFrom' in update)    ops.$set.timeFrom = String(update.timeFrom || '');
    if ('timeTo' in update)      ops.$set.timeTo   = String(update.timeTo || '');
    if ('ageFrom' in update)     ops.$set.ageFrom  = update.ageFrom === '' || update.ageFrom == null ? undefined : Number(update.ageFrom);
    if ('ageTo' in update)       ops.$set.ageTo    = update.ageTo   === '' || update.ageTo   == null ? undefined : Number(update.ageTo);
    if ('info' in update)        ops.$set.info     = update.info ? String(update.info) : '';
    if ('onlineActive' in update)ops.$set.onlineActive = !!update.onlineActive;

    if ('coachName' in update)   ops.$set.coachName  = String(update.coachName || '').trim();
    if ('coachEmail' in update)  ops.$set.coachEmail = String(update.coachEmail || '').trim();
    if ('coachImage' in update)  ops.$set.coachImage = String(update.coachImage || '').trim();

    if ('category' in update)    ops.$set.category   = String(update.category || '').trim();
    if ('sub_type' in update)    ops.$set.sub_type   = String(update.sub_type || '').trim();
    if ('legacy_type' in update) ops.$set.legacy_type= String(update.legacy_type || '').trim();

    // Titel ggf. neu bauen, wenn Typ oder Standort mitkam
    if ('type' in update || 'placeId' in update || 'location' in update) {
      const t = String(('type' in update ? update.type : current.type) || '');
      const loc = finalLocation || String(current.location || '');
      ops.$set.title = [t, loc].filter(Boolean).join(' • ');
    }

    // leeren $unset entfernen
    if (Object.keys(ops.$unset).length === 0) delete ops.$unset;

    const doc = await Offer.findOneAndUpdate(
      { _id: id, owner },
      ops,
      { new: true, runValidators: true }
    ).lean();

    return res.json(doc);
  } catch (err) {
    console.error('[offers:patch] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


/**
 * DELETE /api/offers/:id
 * - Admin only (X-Provider-Id required)
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


