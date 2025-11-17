
// routes/bookings.js
'use strict';

const express  = require('express');
const crypto   = require('crypto');
const mongoose = require('mongoose');

const Booking   = require('../models/Booking');
const Offer     = require('../models/Offer');
const Customer  = require('../models/Customer');
const adminAuth = require('../middleware/adminAuth');

const {
  sendBookingAckEmail,
  sendBookingProcessingEmail,
  sendBookingCancelledEmail,
  sendBookingConfirmedEmail,
   sendBookingCancelledConfirmedEmail
  
} = require('../utils/mailer');

const router = express.Router();

const ALLOWED_STATUS = ['pending','processing','confirmed','cancelled','deleted'];

function normalizeStatus(s) { return s === 'canceled' ? 'cancelled' : s; }
function escapeRegex(s) { return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }



const NON_TRIAL_PROGRAMS = ['RentACoach', 'ClubProgram', 'CoachEducation'];

function isNonTrialProgram(offer) {
  if (!offer) return false;
  const cat  = String(offer.category || '').trim();
  const type = String(offer.type || '').trim();
  const sub  = String(offer.sub_type || '').trim();
  return NON_TRIAL_PROGRAMS.includes(cat)
      || NON_TRIAL_PROGRAMS.includes(type)
      || NON_TRIAL_PROGRAMS.includes(sub);
}

function resolveOwner(req) {
  const fromHeader = req.get('x-provider-id');
  const fallback   = process.env.DEFAULT_OWNER_ID;
  const id = (fromHeader || fallback || '').trim();
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function prorateForStart(dateISO, monthlyPrice) {
  const d = new Date(dateISO + 'T00:00:00');
  if (isNaN(d.getTime()) || typeof monthlyPrice !== 'number' || !isFinite(monthlyPrice)) {
    return { daysInMonth: null, daysRemaining: null, factor: null, firstMonthPrice: null, monthlyPrice: monthlyPrice ?? null };
  }
  const y = d.getFullYear();
  const m = d.getMonth();
  const daysInMonth   = new Date(y, m + 1, 0).getDate();
  const startDay      = d.getDate();
  const daysRemaining = daysInMonth - startDay + 1;
  const factor        = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
  const firstMonthPrice = Math.round(monthlyPrice * factor * 100) / 100;
  return { daysInMonth, daysRemaining, factor, firstMonthPrice, monthlyPrice };
}

function validate(payload) {
  const errors = {};
  if (!payload.firstName?.trim()) errors.firstName = 'Required';
  if (!payload.lastName?.trim())  errors.lastName  = 'Required';
  if (!/^\S+@\S+\.\S+$/.test(payload.email || '')) errors.email = 'Invalid email';
  const age = Number(payload.age);
  if (!age || age < 5 || age > 19) errors.age = 'Age 5–19';
  if (!payload.date) errors.date = 'Pick a date';
  if (!['U8','U10','U12','U14','U16','U18'].includes(payload.level)) errors.level = 'Invalid level';
  return errors;
}

function buildFilter(query, ownerId) {
  const { q, status, date } = query || {};
  const filter = { owner: ownerId };

  if (status && status !== 'all' && ALLOWED_STATUS.includes(String(status))) {
    filter.status = String(status);
  }
  if (date) filter.date = String(date);

  if (q && String(q).trim()) {
    const needle = String(q).trim();
    filter.$or = [
      { firstName:        { $regex: needle, $options: 'i' } },
      { lastName:         { $regex: needle, $options: 'i' } },
      { email:            { $regex: needle, $options: 'i' } },
      { level:            { $regex: needle, $options: 'i' } },
      { message:          { $regex: needle, $options: 'i' } },
      { confirmationCode: { $regex: needle, $options: 'i' } },
    ];
  }
  return filter;
}

/* ---------- Customer-Helper ---------- */
async function upsertCustomerForBooking({ ownerId, offer, bookingDoc, payload }) {
  const emailLower = String(payload.email || '').trim().toLowerCase();

  let customer = await Customer.findOne({
    owner: ownerId,
    $or: [
      { emailLower },
      { email: emailLower },
      { 'parent.email': emailLower },
    ],
  });

  const bookingDate = new Date(String(payload.date) + 'T00:00:00');
  const venue = typeof offer?.location === 'string'
    ? offer.location
    : (offer?.location?.name || offer?.location?.title || '');

  const bookingRef = {
    bookingId:   bookingDoc._id,
    offerId:     offer._id,
    offerTitle:  String(offer.title || ''),
    offerType:   String(offer.type || ''),
    venue,
    date:        isNaN(bookingDate.getTime()) ? null : bookingDate,
    status:      'active',
    priceAtBooking: typeof offer.price === 'number' ? offer.price : null,
  };

  if (!customer) {
    await Customer.syncCounterWithExisting(ownerId);
    const nextUserId = await Customer.nextUserIdForOwner(ownerId);

    customer = await Customer.create({
      owner: ownerId,
      userId: nextUserId,
      email: emailLower,
      emailLower,
      newsletter: false,
      parent: { email: emailLower },
      child:  { firstName: String(payload.firstName||''), lastName: String(payload.lastName||'') },
      notes:  (payload.message || '').toString(),
      bookings: [bookingRef],
      marketingStatus: null,
    });
    return customer;
  }

  if (customer.userId == null) {
    await Customer.assignUserIdIfMissing(customer);
  }

  const already = customer.bookings?.some(b =>
    String(b.offerId) === String(offer._id) &&
    String(b.bookingId) === String(bookingDoc._id)
  );
  if (!already) customer.bookings.push(bookingRef);

  if (!customer.emailLower) customer.emailLower = emailLower;
  if (!customer.email)      customer.email = emailLower;
  if (!customer.parent)     customer.parent = {};
  if (!customer.parent.email) customer.parent.email = emailLower;

  await customer.save();
  return customer;
}

/* ------------------------------ Routes ------------------------------ */

// Create booking
router.post('/', async (req, res) => {
  try {
    const errors = validate(req.body);
    if (Object.keys(errors).length) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', errors });
    }
    if (!req.body.offerId) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'offerId is required' });
    }

    const offer = await Offer.findById(String(req.body.offerId))
      .select('_id owner title type category sub_type location onlineActive price')
      .lean();
    if (!offer) return res.status(400).json({ ok: false, error: 'Offer not found' });
    if (offer.onlineActive === false) return res.status(400).json({ ok: false, error: 'Offer not bookable' });

    const pidHeader = (req.get('x-provider-id') || '').trim();
    if (pidHeader && String(offer.owner) !== pidHeader) {
      return res.status(403).json({ ok: false, error: 'Offer does not belong to this provider' });
    }

    const isNonTrial = isNonTrialProgram(offer);

    const first = String(req.body.firstName || '').trim();
    const last  = String(req.body.lastName  || '').trim();
    if (first && last) {
      const exists = await Booking.findOne({
        offerId:  offer._id,
        firstName:{ $regex: `^${escapeRegex(first)}$`, $options: 'i' },
        lastName: { $regex: `^${escapeRegex(last)}$`,  $options: 'i' },
        status:   { $ne: 'deleted' },
      }).lean();
      if (exists) {
        return res.status(409).json({
          ok: false,
          code: 'DUPLICATE',
          errors: {
            firstName: 'A booking with this first/last name already exists for this offer.',
            lastName:  'Please use different names or contact us.',
          },
        });
      }
    }

    const isWeekly =
      offer?.category === 'Weekly' ||
      offer?.type === 'Foerdertraining' ||
      offer?.type === 'Kindergarten';
    const monthlyPrice = (isWeekly && typeof offer.price === 'number') ? offer.price : null;
    const pro = (isWeekly && monthlyPrice != null)
      ? prorateForStart(req.body.date, monthlyPrice)
      : { daysInMonth: null, daysRemaining: null, factor: null, firstMonthPrice: null, monthlyPrice: null };

    const created = await Booking.create({
      owner:   offer.owner,
      offerId: offer._id,
      firstName: first,
      lastName:  last,
      email:     String(req.body.email).trim().toLowerCase(),
      age:       Number(req.body.age),
      date:      String(req.body.date),
      level:     String(req.body.level),
      message:   req.body.message ? String(req.body.message) : '',
      status:    'pending',
      adminNote: req.body.adminNote || '',
    });

    // ⬇️ Kunde upserten + fortlaufende userId vergeben + Buchung referenzieren
    try {
      await upsertCustomerForBooking({
        ownerId: offer.owner,
        offer,
        bookingDoc: created,
        payload: req.body,
      });
    } catch (custErr) {
      console.error('[bookings] customer upsert failed:', custErr?.message || custErr);
    }

    try {
      await sendBookingAckEmail({ to: created.email, offer, booking: created, pro, isNonTrial, });
    } catch (mailErr) {
      console.warn('[bookings] ack email failed:', mailErr?.message || mailErr);
    }

    return res.status(201).json({ ok: true, booking: created, prorate: pro });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

// List
router.get('/', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) {
      return res.status(500).json({ ok:false, error:'DEFAULT_OWNER_ID missing/invalid' });
    }

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip  = (page - 1) * limit;

    const filter = buildFilter(req.query, ownerId);

    const matchForCounts = { owner: ownerId };
    if (filter.$or) matchForCounts.$or = filter.$or;

    const [items, total, grouped] = await Promise.all([
      Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Booking.countDocuments(filter),
      Booking.aggregate([{ $match: matchForCounts }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    const counts = { pending:0, processing:0, confirmed:0, cancelled:0, deleted:0 };
    for (const g of grouped) {
      const key = (g._id || 'pending');
      if (counts[key] !== undefined) counts[key] = g.n;
    }

    return res.json({
      ok: true,
      items,
      bookings: items,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      counts,
    });
  } catch (err) {
    console.error('[admin/bookings] list failed:', err);
    return res.status(500).json({ ok:false, error:'List failed' });
  }
});

// Status ändern
router.patch('/:id/status', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) return res.status(500).json({ ok:false, error:'DEFAULT_OWNER_ID missing/invalid' });

    const rawStatus = String(req.body?.status || '').trim();
    const status = normalizeStatus(rawStatus);
    const forceMail = String(req.query.force || '') === '1';

    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'Invalid status' });
    }

    const prev = await Booking.findOne({ _id: req.params.id, owner: ownerId });
    if (!prev) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: ownerId },
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

  






    let mailSentProcessing = false;
    let mailSentCancelled  = false;

    if (status === 'processing' && (prev.status !== 'processing' || forceMail)) {
      try {
        // Offer laden, um Programmnamen zu kennen
        const offer = updated.offerId
          ? await Offer.findOne({ _id: updated.offerId, owner: ownerId }).lean()
          : null;

        const isNonTrial = isNonTrialProgram(offer);

        await sendBookingProcessingEmail({
          to: updated.email,
          booking: updated,
          offer,
          isNonTrial,
        });

        mailSentProcessing = true;
      } catch (e) {
        console.error('[BOOKINGS] processing-mail FAILED:', e?.message || e);
      }
    }



    if (status === 'cancelled' && (prev.status !== 'cancelled' || forceMail)) {
      try {
        if (updated.email) {
          await sendBookingCancelledEmail({ to: updated.email, booking: updated });
          mailSentCancelled = true;
        } else {
          console.error('[BOOKINGS] cancelled: missing recipient email');
        }
      } catch (e) { console.error('[BOOKINGS] cancellation-mail FAILED:', e?.message || e); }
    }

    return res.json({ ok: true, booking: updated, mailSentProcessing, mailSentCancelled });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

// Soft delete
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) return res.status(500).json({ ok:false, error:'DEFAULT_OWNER_ID missing/invalid' });

    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: ownerId },
      { status: 'deleted' },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
    return res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

// Confirm
router.post('/:id/confirm', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) return res.status(500).json({ ok:false, error:'DEFAULT_OWNER_ID missing/invalid' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) return res.status(404).json({ ok:false, error:'Not found' });

    const forceResend = String(req.query.resend || '') === '1';
    const alreadyConfirmed = booking.status === 'confirmed';

    if (!booking.confirmationCode) {
      booking.confirmationCode = 'KS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    }
    if (!alreadyConfirmed) {
      booking.status = 'confirmed';
      booking.confirmedAt = new Date();
      await booking.save();
    }

    if (alreadyConfirmed && !forceResend) {
      return res.json({ ok: true, booking, info: 'already confirmed (no email sent)' });
    }

    const offer = booking.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;


 const isNonTrial = isNonTrialProgram(offer);
    try {
      await sendBookingConfirmedEmail({ to: booking.email, booking, offer,isNonTrial });
      return res.json({ ok: true, booking, mailSent: true });
    } catch (mailErr) {
      console.error('[bookings:confirm] mail/pdf failed:', mailErr?.message || mailErr);
      return res.status(200).json({ ok: true, booking, mailSent: false, error: 'mail_failed' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});





















// routes/bookings.js  — NEU
router.post('/:id/cancel-confirmed', adminAuth, async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    if (!ownerId) return res.status(500).json({ ok:false, error:'DEFAULT_OWNER_ID missing/invalid' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok:false, error:'Invalid booking id' });
    }

    const booking = await Booking.findOne({ _id: id, owner: ownerId });
    if (!booking) return res.status(404).json({ ok:false, error:'Not found' });

    // Nur erlaubt, wenn aktuell 'confirmed'
    if (booking.status !== 'confirmed') {
      return res.status(409).json({ ok:false, code:'NOT_CONFIRMED', error:'Only confirmed bookings can be cancelled via this route' });
    }

    // Status -> cancelled
    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    await booking.save();

    const offer = booking.offerId
      ? await Offer.findOne({ _id: booking.offerId, owner: ownerId }).lean()
      : null;

      const isNonTrial = isNonTrialProgram(offer);
    try {
      await sendBookingCancelledConfirmedEmail({ to: booking.email, booking, offer,isNonTrial });
      return res.json({ ok:true, booking, mailSent:true });
    } catch (e) {
      console.error('[bookings:cancel-confirmed] mail failed:', e?.message || e);
      return res.status(200).json({ ok:true, booking, mailSent:false, error:'mail_failed' });
    }
  } catch (err) {
    console.error('[bookings:cancel-confirmed] error:', err);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});




module.exports = router;















