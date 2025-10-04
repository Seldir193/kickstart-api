// routes/adminRevenue.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;
const Booking = require('../models/Booking');
const Customer = require('../models/Customer');   // Subdoc-Fallback
const Offer    = require('../models/Offer');      // zur Abo/Einmalkurs-Erkennung
const { prorateForStart } = require('../utils/billing');

const router = express.Router();

/* ---------- tenant helper ---------- */
function getProviderIdRaw(req) {
  const v = req.get('x-provider-id');
  return v ? String(v).trim() : null;
}
function requireOwner(req, res) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) {
    res.status(401).json({ ok: false, error: 'Unauthorized: invalid provider id' });
    return null;
  }
  return new Types.ObjectId(raw);
}

/* ---------- helpers ---------- */
function monthIndex(d) {
  try { const n = new Date(d).getMonth(); return Number.isFinite(n) ? n : null; }
  catch { return null; }
}
function sameYearMonth(a, b) {
  try {
    const A = new Date(a), B = new Date(b);
    return A.getFullYear() === B.getFullYear() && A.getMonth() === B.getMonth();
  } catch { return false; }
}
function toNumber(n, def = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : def;
}
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function norm(s) { return String(s || '').trim().toLowerCase(); }

/** Abo-Logik:
 *  - category === 'Weekly' → Abo
 *  - type in ['Foerdertraining','Kindergarten'] → Abo (Fallback für alte Daten)
 *  - sub_type 'powertraining' → KEIN Abo (Einmal)
 *  - type in ['Camp','PersonalTraining'] → KEIN Abo (Einmal)
 *  - Default: wenn nichts bekannt → KEIN Abo (sicherer für Kurse)
 */
function norm(s) { return String(s || '').trim().toLowerCase(); }

/** Bestimmt, ob eine Buchung ein Abo (Teilbetrag + Monatsbetrag) ist.
 *  Priorität: category > type/legacy_type (Fallback).
 */
function isAbo(offer, subdoc) {
  // 1) Kategorie aus Offer (Quelle der Wahrheit)
  const cat = norm(offer?.category || subdoc?.category);
  if (cat) {
    if (cat === 'weekly') return true; // Weekly Courses → Abo

    // Alles andere sind Einmalangebote
    const ONE_OFF_CATS = new Set(['holiday', 'individual', 'clubprograms', 'rentacoach']);
    if (ONE_OFF_CATS.has(cat)) return false;
  }

  // 2) Fallback, falls category fehlt (ältere Daten)
  const t = norm(offer?.legacy_type || offer?.type || subdoc?.offerType);
  if (t === 'foerdertraining' || t === 'kindergarten') return true; // Abo
  // Camp, PersonalTraining, AthleticTraining etc. → Einmal
  return false;
}


/* =========================================================
   GET /api/admin/revenue?year=YYYY  (IST)
   - Abo: Startmonat = Teilbetrag, sonst Monatsbetrag
   - Einmalkurs (Camp/Powertraining/PersonalTraining): im Rechnungsmonat Einmalpreis (priceAtBooking / offer.price)
   - Negativ (Storno/Kündigung): analog – Abo minus Teil-/Monatsbetrag, Einmalkurs minus Einmalpreis
   - Subdoc-Fallback + (nur bei Abo) berechneter Teilbetrag via prorateForStart
   - ?debug=1 → Quellen/Gründe
========================================================= */
router.get('/', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;

    const year  = Number(req.query.year) || new Date().getFullYear();
    const from  = new Date(`${year}-01-01T00:00:00.000Z`);
    const to    = new Date(`${year + 1}-01-01T00:00:00.000Z`);
    const debug = String(req.query.debug || '') === '1';
    const lines = [];

    // Kandidaten: etwas Relevantes im Jahr
    const bookings = await Booking.find({
      owner,
      $or: [
        { invoiceDate:      { $gte: from, $lt: to } },
        { stornoDate:       { $gte: from, $lt: to } },
        { cancellationDate: { $gte: from, $lt: to } },
      ]
    }).lean();

    // Offer-Map für Klassifizierung
    const offerIds = [...new Set(bookings.map(b => String(b.offerId || '')).filter(mongoose.isValidObjectId))];
    const offers = offerIds.length
      ? await Offer.find({ _id: { $in: offerIds } }).select('_id type sub_type category price location title').lean()
      : [];
    const offerById = new Map(offers.map(o => [String(o._id), o]));

    // Subdoc-Fallback vorbereiten
    const needFromSubdoc = new Set();
    for (const b of bookings) {
      const hasFirst =
        b.invoiceAmount != null || b.priceFirstMonth != null || b.firstMonthAmount != null;
      const hasMonthly =
        b.monthlyAmount != null || b.priceMonthly != null || b.priceAtBooking != null;
      if (!hasFirst || !hasMonthly || !b.date) needFromSubdoc.add(String(b._id));
    }
    const subdocMap = new Map();
    if (needFromSubdoc.size) {
      const ids = Array.from(needFromSubdoc, id => new Types.ObjectId(id));
      const rows = await Customer.aggregate([
        { $match: { owner } },
        { $unwind: '$bookings' },
        { $match: { 'bookings._id': { $in: ids } } },
        {
          $project: {
            _id: 0,
            bid: '$bookings._id',
            startDate: '$bookings.date',
            offerType: '$bookings.offerType',
            // first candidates
            invoiceAmount: '$bookings.invoiceAmount',
            priceFirstMonth: '$bookings.priceFirstMonth',
            firstMonthAmount: '$bookings.firstMonthAmount',
            // monthly/one-off candidates
            monthlyAmount: '$bookings.monthlyAmount',
            priceMonthly: '$bookings.priceMonthly',
            priceAtBooking: '$bookings.priceAtBooking',
          }
        }
      ]);
      for (const r of rows) {
        subdocMap.set(String(r.bid), {
          startDate: r.startDate || null,
          offerType: r.offerType || '',
          first:
            r.invoiceAmount ??
            r.priceFirstMonth ??
            r.firstMonthAmount,
          monthlyOrOneOff:
            r.monthlyAmount ??
            r.priceMonthly ??
            r.priceAtBooking,
          priceAtBooking: r.priceAtBooking ?? null,
        });
      }
    }

    const monthly  = Array.from({ length: 12 }, () => 0);
    const countPos = Array.from({ length: 12 }, () => 0);
    const countNeg = Array.from({ length: 12 }, () => 0);

    for (const b of bookings) {
      const idStr = String(b._id);
      const sub = subdocMap.get(idStr);
      const offer = offerById.get(String(b.offerId || '')) || null;

      // Startdatum
      let startISO = b.date || sub?.startDate || null;

      // Abo vs Einmal
      const abo = isAbo(offer, { offerType: sub?.offerType });

      // Kandidaten
      let firstCand =
        abo
          ? (b.invoiceAmount ?? b.priceFirstMonth ?? b.firstMonthAmount ?? sub?.first)
          : null; // bei Einmal nicht benutzen

      let monthlyCand =
        abo
          ? (b.monthlyAmount ?? b.priceMonthly ?? b.priceAtBooking ?? sub?.monthlyOrOneOff)
          : null;

      // Einmalpreis
      const oneOffPrice =
        !abo
          ? (b.priceAtBooking ?? sub?.priceAtBooking ?? offer?.price ?? null)
          : null;

      // bei Abo: ggf. Teilbetrag berechnen
      let computedFirst = null;
      if (abo && firstCand == null && startISO && monthlyCand != null) {
        const iso = (typeof startISO === 'string')
          ? startISO.slice(0, 10)
          : new Date(startISO).toISOString().slice(0, 10);
        const p = prorateForStart(iso, Number(monthlyCand));
        if (p && Number.isFinite(p.firstMonthPrice)) computedFirst = round2(p.firstMonthPrice);
      }

      const effectiveFirst   = abo ? ((firstCand != null) ? Number(firstCand) : (computedFirst ?? null)) : null;
      const effectiveMonthly = abo ? ((monthlyCand != null) ? Number(monthlyCand) : null) : null;
      const effectiveOneOff  = !abo ? toNumber(oneOffPrice, 0) : null;

      /* ===== POSITIV ===== */
      let add = 0, addMonth = null, addSource = null;

      if (b.invoiceDate) {
        const mi = monthIndex(b.invoiceDate);
        if (mi != null) {
          if (abo) {
            const isStartMonth = startISO && sameYearMonth(b.invoiceDate, startISO);
            if (isStartMonth && effectiveFirst != null) {
              add = toNumber(effectiveFirst, 0); addSource = (firstCand != null ? 'first' : 'computedFirst');
            } else {
              add = toNumber(effectiveMonthly, 0); addSource = 'monthly';
              if (!add && effectiveFirst != null) { add = toNumber(effectiveFirst, 0); addSource = (firstCand != null ? 'first' : 'computedFirst'); }
            }
          } else {
            // EINMAL: nur im Rechnungsmonat den Einmalpreis
            add = effectiveOneOff || 0;
            addSource = 'oneOff(priceAtBooking/offer)';
          }

          if (add) {
            monthly[mi] = round2(monthly[mi] + add);
            countPos[mi] += 1;
            addMonth = mi;
          }
        }
      }

      /* ===== NEGATIV (Storno/Kündigung) ===== */
      const negDate   = b.stornoDate || b.cancellationDate || null;
      const negReason = b.stornoDate ? 'storno' : (b.cancellationDate ? 'cancellation' : null);

      let subNum = 0, subMonth = null, subMode = null;
      if (negDate) {
        const sm = monthIndex(negDate);
        if (sm != null) {
          if (negReason === 'storno' && b.stornoAmount != null) {
            subNum = toNumber(b.stornoAmount, 0);
            subMode = 'explicit';
          } else if (abo) {
            const treatAsStart =
              (startISO && sameYearMonth(negDate, startISO)) ||
              (b.invoiceDate && sameYearMonth(negDate, b.invoiceDate));
            if (treatAsStart && effectiveFirst != null) {
              subNum = toNumber(effectiveFirst, 0);
              subMode = (firstCand != null ? 'first' : 'computedFirst');
            } else if (effectiveMonthly != null) {
              subNum = toNumber(effectiveMonthly, 0);
              subMode = 'monthly';
            } else if (effectiveFirst != null) {
              subNum = toNumber(effectiveFirst, 0);
              subMode = (firstCand != null ? 'first' : 'computedFirst');
            }
          } else {
            // EINMAL
            subNum = effectiveOneOff || 0;
            subMode = 'oneOff(priceAtBooking/offer)';
          }

          if (subNum) {
            monthly[sm] = round2(monthly[sm] - subNum);
            countNeg[sm] += 1;
            subMonth = sm;
          }
        }
      }

      if (debug) {
        lines.push({
          bookingId: idStr,
          offerId: offer?._id ? String(offer._id) : undefined,
          offerType: offer?.type || sub?.offerType || undefined,
          offerSubType: offer?.sub_type || undefined,
          offerCategory: offer?.category || undefined,
          isAbo: abo,
          startDate: startISO || null,
          invoiceDate: b.invoiceDate || null,
          stornoDate: b.stornoDate || null,
          cancellationDate: b.cancellationDate || null,
          oneOffPrice: (!abo ? effectiveOneOff : undefined),
          firstCandidate: (abo ? (firstCand ?? null) : undefined),
          monthlyCandidate: (abo ? (monthlyCand ?? null) : undefined),
          computedFirst: (abo ? (computedFirst ?? null) : undefined),
          add, addMonth, addSource,
          sub: subNum, subMonth, subMode,
          delta: Number(((add || 0) - (subNum || 0)).toFixed(2)),
        });
      }
    }

    const total = Number(monthly.reduce((a, b) => a + b, 0).toFixed(2));
    const payload = {
      ok: true,
      year,
      total,
      monthly,
      counts: {
        positive: countPos,
        negative: countNeg, // (storno + cancellation)
      },
    };
    if (debug) payload.debug = { lines };

    res.json(payload);
  } catch (err) {
    console.error('[adminRevenue] error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
