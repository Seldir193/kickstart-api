

// routes/customers.js
const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const Customer = require('../models/Customer');
const Offer    = require('../models/Offer');


const archiver = require('archiver');

const {
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
} = require('../utils/pdf');

const {
  sendCancellationEmail,
  sendStornoEmail,
  sendParticipationEmail,
} = require('../utils/mailer');

const router = express.Router();

/* ======= Config ======= */
const CANCEL_ALLOWED = new Set([
  'Kindergarten',
  'Foerdertraining',
  'Athletiktraining',
  'AthleticTraining',
]);

/* ======= Owner helpers ======= */
function getProviderIdRaw(req) {
  const v = req.get('x-provider-id');
  return v ? String(v).trim() : null;
}
function getProviderObjectId(req) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) return null;
  return new Types.ObjectId(raw);
}
function requireOwner(req, res) {
  const owner = getProviderObjectId(req);
  if (!owner) {
    res.status(401).json({ ok: false, error: 'Unauthorized: invalid provider id' });
    return null;
  }
  return owner;
}
function requireId(req, res) {
  const id = String(req.params.id || '').trim();
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid customer id' });
    return null;
  }
  return id;
}

/* ======= Filter builder (customers list) ======= */
function buildFilter(query, owner) {
  const { q, newsletter } = query || {};
  const filter = { owner };
  if (newsletter === 'true') filter.newsletter = true;
  if (newsletter === 'false') filter.newsletter = false;

  if (q && String(q).trim().length) {
    const needle = String(q).trim();
    filter.$or = [
      { 'child.firstName':   { $regex: needle, $options: 'i' } },
      { 'child.lastName':    { $regex: needle, $options: 'i' } },
      { 'parent.firstName':  { $regex: needle, $options: 'i' } },
      { 'parent.lastName':   { $regex: needle, $options: 'i' } },
      { 'parent.email':      { $regex: needle, $options: 'i' } },
      { 'parent.phone':      { $regex: needle, $options: 'i' } },
      { 'child.club':        { $regex: needle, $options: 'i' } },
      { 'address.city':      { $regex: needle, $options: 'i' } },
      { 'address.street':    { $regex: needle, $options: 'i' } },
      { notes:               { $regex: needle, $options: 'i' } },
      { userId: isFinite(+needle) ? +needle : -1 },
    ];
  }
  return filter;
}

/* ======= LIST ======= */
router.get('/', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;

    const { page = 1, limit = 20, sort = 'createdAt:desc' } = req.query;
    const [sortField, sortDir] = String(sort).split(':');
    const sortSpec = { [sortField || 'createdAt']: (sortDir === 'asc' ? 1 : -1) };

    const p = Math.max(1, Number(page));
    const l = Math.max(1, Math.min(100, Number(limit)));
    const skip = (p - 1) * l;

    const filter = buildFilter(req.query, owner);

    const [items, total] = await Promise.all([
      Customer.find(filter).sort(sortSpec).skip(skip).limit(l).lean(),
      Customer.countDocuments(filter),
    ]);

    res.json({ items, total, page: p, limit: l });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= GET ONE ======= */
router.get('/:id', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const doc = await Customer.findOne({ _id: id, owner }).lean();
    if (!doc) return res.status(404).json({ error: 'Customer not found' });
    res.json(doc);
  } catch {
    res.status(400).json({ error: 'Invalid customer id' });
  }
});

/* ======= CREATE ======= */
router.post('/', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const b = req.body || {};

    const errors = {};
    if (!b.child?.firstName) errors.childFirstName = 'required';
    if (!b.child?.lastName)  errors.childLastName  = 'required';
    if (!b.parent?.email)    errors.parentEmail    = 'required';
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const nextNo = await Customer.nextUserIdForOwner(owner);

    const doc = await Customer.create({
      owner,
      userId: nextNo,
      newsletter: !!b.newsletter,
      address: {
        street:  b.address?.street  || '',
        houseNo: b.address?.houseNo || '',
        zip:     b.address?.zip     || '',
        city:    b.address?.city    || '',
      },
      child: {
        firstName: b.child?.firstName || '',
        lastName:  b.child?.lastName  || '',
        gender:    ['weiblich','männlich'].includes(b.child?.gender) ? b.child.gender : '',
        birthDate: b.child?.birthDate ? new Date(b.child.birthDate) : null,
        club:      b.child?.club || '',
      },
      parent: {
        salutation: ['Frau','Herr'].includes(b.parent?.salutation) ? b.parent.salutation : '',
        firstName:  b.parent?.firstName || '',
        lastName:   b.parent?.lastName  || '',
        email:      b.parent?.email     || '',
        phone:      b.parent?.phone     || '',
        phone2:     b.parent?.phone2    || '',
      },
      notes:    b.notes || '',
      bookings: Array.isArray(b.bookings) ? b.bookings : [],
    });

    res.status(201).json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= UPDATE ======= */
router.put('/:id', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;
    const b = req.body || {};

    const update = {
      newsletter: !!b.newsletter,
      address: {
        street:  b.address?.street  || '',
        houseNo: b.address?.houseNo || '',
        zip:     b.address?.zip     || '',
        city:    b.address?.city    || '',
      },
      child: {
        firstName: b.child?.firstName || '',
        lastName:  b.child?.lastName  || '',
        gender:    ['weiblich','männlich'].includes(b.child?.gender) ? b.child.gender : '',
        birthDate: b.child?.birthDate ? new Date(b.child.birthDate) : null,
        club:      b.child?.club || '',
      },
      parent: {
        salutation: ['Frau','Herr'].includes(b.parent?.salutation) ? b.parent.salutation : '',
        firstName:  b.parent?.firstName || '',
        lastName:   b.parent?.lastName  || '',
        email:      b.parent?.email     || '',
        phone:      b.parent?.phone     || '',
        phone2:     b.parent?.phone2    || '',
      },
      notes: b.notes || '',
    };

    if (Array.isArray(b.bookings)) update.bookings = b.bookings;

    const doc = await Customer.findOneAndUpdate(
      { _id: id, owner },
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ error: 'Customer not found' });
    res.json(doc);
  } catch {
    res.status(400).json({ error: 'Invalid customer id' });
  }
});

/* ======= DELETE ======= */
router.delete('/:id', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const d = await Customer.deleteOne({ _id: id, owner });
    if (!d.deletedCount) return res.status(404).json({ error: 'Customer not found' });
    res.json({ ok: true, id });
  } catch {
    res.status(400).json({ error: 'Invalid customer id' });
  }
});

/* ======= CUSTOMER CANCEL (entire customer) + email ======= */
router.post('/:id/cancel', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const { date, reason } = req.body || {};
    const cancelAt = date ? new Date(date) : new Date();

    const customer = await Customer.findOneAndUpdate(
      { _id: id, owner },
      {
        $set: {
          canceledAt: new Date(),
          cancellationDate: cancelAt,
          cancellationReason: String(reason || ''),
        },
      },
      { new: true }
    );

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (customer.parent?.email) {
      const pdf = await buildCancellationPdf({ customer, date: cancelAt, reason });
      await sendCancellationEmail({
        to: customer.parent.email,
        customer,
        date: cancelAt,
        reason,
        pdfBuffer: pdf,
      });
    }

    res.json({ ok: true, customer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= BOOKING ADD ======= */
router.post('/:id/bookings', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const { offerId, date } = req.body || {};
    if (!offerId || !mongoose.isValidObjectId(offerId)) {
      return res.status(400).json({ error: 'Invalid offerId' });
    }

    const offer = await Offer.findById(offerId).lean();
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    const booking = {
      _id: new Types.ObjectId(),
      offerId: offer._id,
      offerTitle: offer.title,
      offerType: offer.type || '',
      date: date ? new Date(date) : new Date(),
      status: 'active',
      createdAt: new Date(),
    };

    const doc = await Customer.findOneAndUpdate(
      { _id: id, owner },
      { $push: { bookings: booking } },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Customer not found' });
    res.status(201).json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= BOOKING CANCEL (single booking) + email (cancellation PDF) ======= */
router.post('/:id/bookings/:bid/cancel', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const { date, reason } = req.body || {};
    const cancelAt = date ? new Date(date) : new Date();

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const offer = await Offer.findById(booking.offerId).lean();
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    if (!CANCEL_ALLOWED.has(offer.type)) {
      return res.status(400).json({ error: 'This offer type cannot be cancelled' });
    }

    booking.status = 'cancelled';
    booking.cancelDate = cancelAt;
    booking.cancelReason = String(reason || '');

    await customer.save();

    if (customer.parent?.email) {
      const pdf = await buildCancellationPdf({ customer, booking, date: cancelAt, reason });
      await sendCancellationEmail({
        to: customer.parent.email,
        customer,
        booking,
        date: cancelAt,
        reason,
        pdfBuffer: pdf,
      });
    }

    res.json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= STORNO: Email with storno PDF ======= */
router.post('/:id/bookings/:bid/email/storno', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;
    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const { amount = 0, currency = 'EUR' } = req.body || {};

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (!customer.parent?.email) {
      return res.status(400).json({ error: 'Customer has no email' });
    }

    const pdf = await buildStornoPdf({ customer, booking, amount: Number(amount) || 0, currency });
    await sendStornoEmail({
      to: customer.parent.email,
      customer,
      booking,
      pdfBuffer: pdf,
      amount: Number(amount) || 0,
      currency,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

















/* ======= EMAIL: participation confirmation (detaillierte Fehler) ======= */
router.post('/:id/bookings/:bid/email/confirmation', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    // optionale Felder (falls du sie später mitschickst – stören nicht)
    const {
      invoiceNo,
      monthlyAmount,
      firstMonthAmount,
      venue,
      invoiceDate,
    } = req.body || {};

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (!customer.parent?.email) {
      return res.status(400).json({ error: 'Customer has no email' });
    }

    let pdf;
    try {
      pdf = await buildParticipationPdf({
        customer,
        booking,
        invoiceNo,
        monthlyAmount,
        firstMonthAmount,
        venue,
        invoiceDate,
      });
    } catch (e) {
      console.error('buildParticipationPdf failed:', e);
      return res.status(500).json({ error: 'PDF_BUILD_FAILED', detail: String(e?.message || e) });
    }

    try {
      await sendParticipationEmail({
        to: customer.parent.email,
        customer,
        booking,
        pdfBuffer: pdf,
      });
    } catch (e) {
      console.error('sendParticipationEmail failed:', e);
      return res.status(502).json({ error: 'MAIL_SEND_FAILED', detail: String(e?.message || e) });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
});





/* ======= DOCUMENT PDFs (used by Next proxy) ======= */
router.post('/:id/bookings/:bid/documents/participation', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = (customer.bookings || []).find(b => String(b._id) === bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const pdf = await buildParticipationPdf({ customer, booking });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Teilnahmebestaetigung.pdf"');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});












router.post('/:id/bookings/:bid/documents/cancellation', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = (customer.bookings || []).find(b => String(b._id) === bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const date = booking.cancelDate || new Date();
    const reason = booking.cancelReason || '';

    const pdf = await buildCancellationPdf({ customer, booking, date, reason });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Kuendigungsbestaetigung.pdf"');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/bookings/:bid/documents/storno', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const { amount = 0, currency = 'EUR' } = req.body || {};

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = (customer.bookings || []).find(b => String(b._id) === bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const pdf = await buildStornoPdf({ customer, booking, amount: Number(amount) || 0, currency });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Storno-Rechnung.pdf"');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= STORNO: mark booking cancelled (no email) ======= */
router.post('/:id/bookings/:bid/storno', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) return res.status(404).json({ ok: false, error: 'Customer not found' });

    const booking = customer.bookings.id(bid);
    if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found' });

    if (booking.status === 'cancelled') {
      return res.status(409).json({ ok: false, code: 'ALREADY_CANCELLED' });
    }

    booking.status = 'cancelled';
    booking.cancelDate = new Date();
    if (req.body && req.body.note != null) {
      booking.cancelReason = String(req.body.note || '');
    }

    await customer.save();

    return res.json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ===================================================================== */
/* ======================= DOCUMENTS: PAGINATION ======================== */
/* ===================================================================== */

function toNorm(s = '') {
  return String(s)
    .replace(/[Ää]/g, 'ae')
    .replace(/[Öö]/g, 'oe')
    .replace(/[Üü]/g, 'ue')
    .replace(/ß/g, 'ss')
    .toLowerCase();
}
function docMatchesType(doc, typeSet) {
  if (!typeSet || !typeSet.size) return true;
  return typeSet.has(doc.type);
}
function docMatchesQuery(doc, q) {
  if (!q) return true;
  const n = toNorm(q);
  const hay = toNorm([doc.title, doc.type, doc.offerTitle, doc.offerType].filter(Boolean).join(' '));
  return hay.includes(n);
}
function parseDate(d) {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t.getTime()) ? null : t;
}

/**
 * GET /api/customers/:id/documents
 * Query:
 *   page=1&limit=50
 *   type=participation,cancellation,storno
 *   from=YYYY-MM-DD&to=YYYY-MM-DD
 *   q=search
 *   sort=issuedAt:desc
 */
router.get('/:id/documents', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));

    const typeParam = String(req.query.type || '').trim();
    const typeSet = new Set(
      typeParam
        ? typeParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : []
    );

    const from = parseDate(req.query.from);
    const to   = parseDate(req.query.to);
    const q    = String(req.query.q || '').trim();

    const sortStr = String(req.query.sort || 'issuedAt:desc');
    const [sortField, sortDir] = sortStr.split(':');
    const sortKey = (sortField || 'issuedAt');
    const sortMul = (sortDir === 'asc' ? 1 : -1);

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Build docs derived from bookings
    const docs = [];
    for (const b of (customer.bookings || [])) {
      const baseTitle = `${b.offerTitle || b.offerType || 'Angebot'}`;
      const bid = String(b._id);
      const common = { bookingId: bid, offerTitle: b.offerTitle, offerType: b.offerType, status: b.status };

      // participation (always)
      docs.push({
        id: `${bid}:participation`,
        type: 'participation',
        title: `Teilnahmebestätigung – ${baseTitle}`,
        issuedAt: b.date || b.createdAt,
        href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/participation`,
        ...common,
      });

      if (b.status === 'cancelled') {
        const issued = b.cancelDate || b.updatedAt || b.createdAt;
        docs.push({
          id: `${bid}:cancellation`,
          type: 'cancellation',
          title: `Kündigungsbestätigung – ${baseTitle}`,
          issuedAt: issued,
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/cancellation`,
          ...common,
        });
        docs.push({
          id: `${bid}:storno`,
          type: 'storno',
          title: `Storno-Rechnung – ${baseTitle}`,
          issuedAt: issued,
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/storno`,
          ...common,
        });
      }
    }

    // Filter
    let filtered = docs.filter(d => docMatchesType(d, typeSet) && docMatchesQuery(d, q));
    if (from) filtered = filtered.filter(d => new Date(d.issuedAt) >= from);
    if (to)   filtered = filtered.filter(d => new Date(d.issuedAt) <= to);

    // Sort
    filtered.sort((a, b) => {
      const av = new Date(a[sortKey] || 0).getTime();
      const bv = new Date(b[sortKey] || 0).getTime();
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * sortMul;
    });

    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/customers/:id/documents.csv
 * Same filters as JSON; streams CSV.
 */
router.get('/:id/documents.csv', async (req, res) => {
  try {
    // reuse JSON route to build & filter, but without slicing -> export all that match filters
    req.query.page = '1';
    req.query.limit = '1000000'; // effectively all
    // call our own function by duplicating logic (simplest for clarity)

    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const typeParam = String(req.query.type || '').trim();
    const typeSet = new Set(
      typeParam
        ? typeParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : []
    );
    const from = parseDate(req.query.from);
    const to   = parseDate(req.query.to);
    const q    = String(req.query.q || '').trim();

    const sortStr = String(req.query.sort || 'issuedAt:desc');
    const [sortField, sortDir] = sortStr.split(':');
    const sortKey = (sortField || 'issuedAt');
    const sortMul = (sortDir === 'asc' ? 1 : -1);

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const docs = [];
    for (const b of (customer.bookings || [])) {
      const baseTitle = `${b.offerTitle || b.offerType || 'Angebot'}`;
      const bid = String(b._id);
      const common = { bookingId: bid, offerTitle: b.offerTitle, offerType: b.offerType, status: b.status };

      docs.push({
        id: `${bid}:participation`,
        type: 'participation',
        title: `Teilnahmebestätigung – ${baseTitle}`,
        issuedAt: b.date || b.createdAt,
        href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/participation`,
        ...common,
      });
      if (b.status === 'cancelled') {
        const issued = b.cancelDate || b.updatedAt || b.createdAt;
        docs.push({
          id: `${bid}:cancellation`,
          type: 'cancellation',
          title: `Kündigungsbestätigung – ${baseTitle}`,
          issuedAt: issued,
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/cancellation`,
          ...common,
        });
        docs.push({
          id: `${bid}:storno`,
          type: 'storno',
          title: `Storno-Rechnung – ${baseTitle}`,
          issuedAt: issued,
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/storno`,
          ...common,
        });
      }
    }

    let filtered = docs.filter(d => docMatchesType(d, typeSet) && docMatchesQuery(d, q));
    if (from) filtered = filtered.filter(d => new Date(d.issuedAt) >= from);
    if (to)   filtered = filtered.filter(d => new Date(d.issuedAt) <= to);

    filtered.sort((a, b) => {
      const av = new Date(a[sortKey] || 0).getTime();
      const bv = new Date(b[sortKey] || 0).getTime();
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * sortMul;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customer-${id}-documents.csv"`);

    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const headers = ['id','bookingId','type','title','issuedAt','status','offerTitle','offerType','href'];
    res.write(headers.join(',') + '\n');
    for (const d of filtered) {
      const row = [
        d.id,
        d.bookingId,
        d.type,
        d.title,
        d.issuedAt ? new Date(d.issuedAt).toISOString() : '',
        d.status || '',
        d.offerTitle || '',
        d.offerType || '',
        d.href || '',
      ].map(esc).join(',');
      res.write(row + '\n');
    }
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});








/**
 * GET /api/customers/:id/documents.zip
 * Gleiche Filter wie JSON/CSV; erzeugt ein ZIP mit PDFs (participation, cancellation, storno).
 */
router.get('/:id/documents.zip', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    // Filter übernehmen wie bei /documents
    const typeParam = String(req.query.type || '').trim();
    const typeSet = new Set(
      typeParam ? typeParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : []
    );
    const from = parseDate(req.query.from);
    const to   = parseDate(req.query.to);
    const q    = String(req.query.q || '').trim();

    const sortStr = String(req.query.sort || 'issuedAt:desc');
    const [sortField, sortDir] = sortStr.split(':');
    const sortKey = (sortField || 'issuedAt');
    const sortMul = (sortDir === 'asc' ? 1 : -1);

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Dokumentliste wie bei /documents generieren
    let docs = [];
    for (const b of (customer.bookings || [])) {
      const baseTitle = `${b.offerTitle || b.offerType || 'Angebot'}`;
      const bid = String(b._id);
      const common = { bookingId: bid, offerTitle: b.offerTitle, offerType: b.offerType, status: b.status };

      docs.push({
        id: `${bid}:participation`,
        type: 'participation',
        title: `Teilnahmebestätigung – ${baseTitle}`,
        issuedAt: b.date || b.createdAt,
        ...common,
      });

      if (b.status === 'cancelled') {
        const issued = b.cancelDate || b.updatedAt || b.createdAt;
        docs.push({
          id: `${bid}:cancellation`,
          type: 'cancellation',
          title: `Kündigungsbestätigung – ${baseTitle}`,
          issuedAt: issued,
          ...common,
        });
        docs.push({
          id: `${bid}:storno`,
          type: 'storno',
          title: `Storno-Rechnung – ${baseTitle}`,
          issuedAt: issued,
          ...common,
        });
      }
    }

    // Filter anwenden
    docs = docs.filter(d => docMatchesType(d, typeSet) && docMatchesQuery(d, q));
    if (from) docs = docs.filter(d => new Date(d.issuedAt) >= from);
    if (to)   docs = docs.filter(d => new Date(d.issuedAt) <= to);

    // Sortieren
    docs.sort((a, b) => {
      const av = new Date(a[sortKey] || 0).getTime();
      const bv = new Date(b[sortKey] || 0).getTime();
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * sortMul;
    });

    // ZIP-Stream
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="customer-${id}-documents.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error(err);
      try { res.status(500).end(); } catch {}
    });
    archive.pipe(res);

    // PDFs erzeugen und hinzufügen
    const safe = (s) => String(s || '').replace(/[^\w.\- äöüÄÖÜß]/g, '_').slice(0, 120);

    for (const d of docs) {
      const booking = (customer.bookings || []).find(b => String(b._id) === d.bookingId);
      if (!booking) continue;

      let buf;
      if (d.type === 'participation') {
        buf = await buildParticipationPdf({ customer, booking });
      } else if (d.type === 'cancellation') {
        const date = booking.cancelDate || new Date();
        const reason = booking.cancelReason || '';
        buf = await buildCancellationPdf({ customer, booking, date, reason });
      } else if (d.type === 'storno') {
        buf = await buildStornoPdf({ customer, booking, amount: 0, currency: 'EUR' });
      } else {
        continue;
      }

      const dateStr = d.issuedAt ? new Date(d.issuedAt).toISOString().slice(0,10) : 'undated';
      const name = `${dateStr} - ${safe(d.title)}.pdf`;
      archive.append(buf, { name });
    }

    await archive.finalize();
  } catch (err) {
    console.error(err);
    try { res.status(500).json({ error: 'Server error' }); } catch {}
  }
});







module.exports = router;















































