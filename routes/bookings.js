// routes/bookings.js
'use strict';

const express  = require('express');
const crypto   = require('crypto');
const mongoose = require('mongoose');

const Booking   = require('../models/Booking');
const Offer     = require('../models/Offer');
const adminAuth = require('../middleware/adminAuth');

const { bookingPdfBuffer } = require('../utils/pdf');
const {
  sendMail,
  sendBookingAckEmail,
  sendBookingProcessingEmail,
  sendBookingCancelledEmail,
  sendBookingConfirmedEmail,
} = require('../utils/mailer');

const router = express.Router();

/* ----------------------------- Helpers ------------------------------ */
function validate(payload) {
  const errors = {};
  if (!payload.firstName?.trim()) errors.firstName = 'Required';
  if (!payload.lastName?.trim())  errors.lastName  = 'Required';
  if (!/^\S+@\S+\.\S+$/.test(payload.email || '')) errors.email = 'Invalid email';
  const age = Number(payload.age);
  if (!age || age < 5 || age > 19) errors.age = 'Age 5–19';
  if (!payload.date) errors.date = 'Pick a date'; // yyyy-mm-dd
  if (!['U8','U10','U12','U14','U16','U18'].includes(payload.level)) errors.level = 'Invalid level';
  return errors;
}

const ALLOWED_STATUS = ['pending','processing','confirmed','cancelled','deleted'];

const fmtDE = (isoDate) => {
  const [y,m,d] = String(isoDate || '').split('-').map(n => parseInt(n,10));
  if (!y || !m || !d) return String(isoDate || '');
  return `${String(d).padStart(2,'0')}.${String(m).padStart(2,'0')}.${y}`;
};

// Provider aus Header
function getProviderId(req) {
  const v = req.get('x-provider-id');
  return v ? String(v).trim() : null;
}
function requireProvider(req, res) {
  const pid = getProviderId(req);
  if (!pid) {
    res.status(401).json({ ok: false, error: 'Unauthorized: missing provider' });
    return null;
  }
  return pid;
}

// Misc helpers
function escapeRegex(s) { return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Pro-rata für ersten Monat (anteilig ab Startdatum) */
function prorateForStart(dateISO, monthlyPrice) {
  const d = new Date(dateISO + 'T00:00:00');
  if (isNaN(d.getTime()) || typeof monthlyPrice !== 'number' || !isFinite(monthlyPrice)) {
    return { daysInMonth: null, daysRemaining: null, factor: null, firstMonthPrice: null, monthlyPrice: monthlyPrice ?? null };
  }
  const y = d.getFullYear();
  const m = d.getMonth(); // 0..11
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startDay = d.getDate();
  const daysRemaining = daysInMonth - startDay + 1; // inkl. Starttag
  const factor = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
  const firstMonthPrice = Math.round(monthlyPrice * factor * 100) / 100;
  return { daysInMonth, daysRemaining, factor, firstMonthPrice, monthlyPrice };
}

/** Einheitliche Statusform (UI schickt z.T. "canceled") */
const normalizeStatus = (s) => (s === 'canceled' ? 'cancelled' : s);

/* ------------------------------ Routes ------------------------------ */

/** PUBLIC/ADMIN: Create booking (sendet Eingangsbestätigung via MJML) */
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
      .select('_id owner title type location onlineActive price')
      .lean();
    if (!offer) return res.status(400).json({ ok: false, error: 'Offer not found' });
    if (offer.onlineActive === false) return res.status(400).json({ ok: false, error: 'Offer not bookable' });

    const pidHeader = getProviderId(req);
    if (pidHeader && String(offer.owner) !== pidHeader) {
      return res.status(403).json({ ok: false, error: 'Offer does not belong to this provider' });
    }

    // DUPLICATE-Check (First/Last exakt, case-insensitive) für dieses Angebot
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

    // Pro-rata berechnen (falls Preis am Angebot)
    const monthlyPrice = typeof offer.price === 'number' ? offer.price : null;
    const pro = (monthlyPrice != null)
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

    // Eingangsbestätigung (MJML)
    try {
      await sendBookingAckEmail({ to: created.email, offer, booking: created, pro });
    } catch (mailErr) {
      console.warn('[bookings] ack email failed:', mailErr?.message || mailErr);
    }

    return res.status(201).json({ ok: true, booking: created, prorate: pro });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});

/** ADMIN: List bookings (scoped) */
router.get('/', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const { status, q, date, page = 1, limit = 200 } = req.query;

    const filter = { owner: providerId };
    if (status && ALLOWED_STATUS.includes(String(status))) filter.status = String(status);
    if (date) filter.date = String(date);

    if (q && String(q).trim().length >= 2) {
      const needle = String(q).trim();
      filter.$or = [
        { firstName: { $regex: needle, $options: 'i' } },
        { lastName:  { $regex: needle, $options: 'i' } },
        { email:     { $regex: needle, $options: 'i' } },
        { message:   { $regex: needle, $options: 'i' } },
      ];
    }

    const p = Math.max(1, Number(page));
    const l = Math.max(1, Math.min(500, Number(limit)));
    const skip = (p - 1) * l;

    const [items, total] = await Promise.all([
      Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
      Booking.countDocuments(filter),
    ]);

    return res.json({ ok: true, bookings: items, total });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});















/** ADMIN: Change status (scoped) – sendet MJML Mails bei Übergängen */
router.patch('/:id/status', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const rawStatus = String(req.body?.status || '').trim();
    const status = normalizeStatus(rawStatus);
    const forceMail = String(req.query.force || '') === '1';

    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'Invalid status' });
    }

    const prev = await Booking.findOne({ _id: req.params.id, owner: providerId });
    if (!prev) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: providerId },
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });

    let mailSentProcessing = false;
    let mailSentCancelled  = false;

   
 // In Bearbeitung → MJML
    if (status === 'processing' && (prev.status !== 'processing' || forceMail)) {
      try {
        await sendBookingProcessingEmail({ to: updated.email, booking: updated });
        mailSentProcessing = true;
      } catch (e) {
        console.error('[BOOKINGS] processing-mail FAILED:', e?.message || e);
      }
    }

    // Abgesagt/Storno → MJML
    if (status === 'cancelled' && (prev.status !== 'cancelled' || forceMail)) {
      try {
        if (!updated.email) {
          console.error('[BOOKINGS] cancelled: missing recipient email');
        } else {
          await sendBookingCancelledEmail({ to: updated.email, booking: updated });
          mailSentCancelled = true;
        }
      } catch (e) {
        console.error('[BOOKINGS] cancellation-mail FAILED:', e?.message || e);
      }
    }

    // Für 'confirmed' keine Mail hier – das macht /:id/confirm mit PDF
    return res.json({ ok: true, booking: updated, mailSentProcessing, mailSentCancelled });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, code: 'SERVER', error: 'Server error' });
  }
});










/** ADMIN: Soft delete (scoped) */
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, owner: providerId },
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

/** ADMIN: Confirm + send PDF (scoped, idempotent, ?resend=1) */
router.post('/:id/confirm', adminAuth, async (req, res) => {
  try {
    const providerId = requireProvider(req, res);
    if (!providerId) return;

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking id' });
    }

    const booking = await Booking.findOne({ _id: id, owner: providerId });
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

    try {
      const pdf = await bookingPdfBuffer(booking);
      await sendBookingConfirmedEmail({ to: booking.email, booking, pdfBuffer: pdf });
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

module.exports = router;
















