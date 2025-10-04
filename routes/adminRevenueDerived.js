// routes/adminRevenueDerived.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const Customer = require('../models/Customer'); // rechnen auf Basis der Subdocs
const Offer    = require('../models/Offer');    // um category=Weekly zu prüfen
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
const norm = (s) => String(s || '').trim().toLowerCase();
function toNumber(n, def = 0) { const v = Number(n); return Number.isFinite(v) ? v : def; }
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function monthIndex(d) { try { const n = new Date(d).getMonth(); return Number.isFinite(n) ? n : null; } catch { return null; } }
function sameYearMonth(a, b) {
  try { const A = new Date(a), B = new Date(b); return A.getFullYear() === B.getFullYear() && A.getMonth() === B.getMonth(); }
  catch { return false; }
}
function endOfMonth(d) { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth() + 1, 0, 23, 59, 59, 999); }

/* =========================================================
   GET /api/admin/revenue-derived?year=YYYY
   Plan/ABO (nur Weekly):
   - Startmonat: Teilbetrag (falls nicht vorhanden → pro-rata aus Monatsbetrag)
   - Folgemonate: Monatsbetrag
   - Storno/Kündigung im Monat M:
       * wenn Startmonat → -Teilbetrag
       * sonst → -Monatsbetrag
   - Beträge aus Customer-Subdoc:
       first = invoiceAmount | priceFirstMonth | firstMonthAmount
       monthly = monthlyAmount | priceMonthly | priceAtBooking
   - Fallback: first via prorateForStart(startDate, monthly)
   - STRICT: Nur Offers mit category === 'Weekly' zählen!
   - Debug: ?debug=1
========================================================= */
router.get('/', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;

    const year  = Number(req.query.year) || new Date().getFullYear();
    const yFrom = new Date(`${year}-01-01T00:00:00.000Z`);
    const yTo   = new Date(`${year + 1}-01-01T00:00:00.000Z`);
    const debug = String(req.query.debug || '') === '1';
    const lines = [];

    // Kunden + Buchungs-Subdocs laden (inkl. offerId!)
    const customers = await Customer.find({ owner })
      .select([
        'bookings._id',
        'bookings.offerId',
        'bookings.date',
        'bookings.status',
        'bookings.cancelDate',
        'bookings.cancellationDate',
        'bookings.endDate',
        'bookings.stornoDate',
        'bookings.stornoAmount',
        'bookings.invoiceDate',
        'bookings.invoiceAmount',
        'bookings.priceFirstMonth',
        'bookings.firstMonthAmount',
        'bookings.monthlyAmount',
        'bookings.priceMonthly',
        'bookings.priceAtBooking',
        'bookings.offerTitle',
        'bookings.offerType',
      ].join(' '))
      .lean();

    // Alle Offer-IDs einsammeln und Offers (für category) nachladen
    const offerIdSet = new Set();
    for (const c of customers) for (const b of (c.bookings || [])) {
      const oid = b.offerId ? String(b.offerId) : null;
      if (oid && mongoose.isValidObjectId(oid)) offerIdSet.add(oid);
    }
    const offerIds = [...offerIdSet];
    const offers = offerIds.length
      ? await Offer.find({ _id: { $in: offerIds } })
          .select('_id category type sub_type legacy_type title price')
          .lean()
      : [];
    const offerById = new Map(offers.map(o => [String(o._id), o]));

    const monthly  = Array.from({ length: 12 }, () => 0);
    const countPos = Array.from({ length: 12 }, () => 0);
    const countNeg = Array.from({ length: 12 }, () => 0);

    for (const c of customers) {
      for (const b of (c.bookings || [])) {
        // ---- Weekly-Filter (STRICT) ----
        const offer = b.offerId ? offerById.get(String(b.offerId)) : null;
        if (!offer || norm(offer.category) !== 'weekly') {
          if (debug) {
            lines.push({
              type: 'SKIP',
              bookingId: String(b._id),
              reason: 'not-weekly',
              offerId: b.offerId ? String(b.offerId) : null,
              offerCategory: offer?.category ?? null,
              offerType: offer?.type ?? null,
              subType: offer?.sub_type ?? null,
            });
          }
          continue;
        }

        // --- Grunddaten ---
        const startISO = b.date || null; // Date oder ISO
        if (!startISO) continue;
        const start = new Date(startISO);
        if (!isFinite(start)) continue;

        // Betrags-Kandidaten aus Subdoc
        const firstCand =
          b.invoiceAmount ??
          b.priceFirstMonth ??
          b.firstMonthAmount;

        const monthlyCand =
          b.monthlyAmount ??
          b.priceMonthly ??
          b.priceAtBooking;

        // first ggf. pro-rata aus monthly
        let computedFirst = null;
        if (firstCand == null && monthlyCand != null) {
          const iso = (typeof startISO === 'string')
            ? startISO.slice(0, 10)
            : new Date(start).toISOString().slice(0, 10);
          const p = prorateForStart(iso, Number(monthlyCand));
          if (p && Number.isFinite(p.firstMonthPrice)) computedFirst = round2(p.firstMonthPrice);
        }

        const effectiveFirst   = (firstCand != null)   ? Number(firstCand)   : (computedFirst ?? null);
        const effectiveMonthly = (monthlyCand != null) ? Number(monthlyCand) : null;

        if (effectiveFirst == null && effectiveMonthly == null) continue;

        // Stopp-Datum (Ende / Kündigung – als Obergrenze für positive Buchungen)
        const cancelAt = b.cancelDate || b.cancellationDate || null;
        const endAt    = b.endDate || null;
        const stopAt   = cancelAt || endAt || null;

        // aktiver Zeitraum im Jahr
        const activeFrom = (start < yFrom) ? yFrom : start;
        const activeTo   = stopAt ? endOfMonth(stopAt) : new Date(`${year}-12-31T23:59:59.999Z`);

        // --- Monate des Jahres iterieren ---
        for (let m = 0; m < 12; m++) {
          const mStart = new Date(year, m, 1);
          const mEnd   = endOfMonth(mStart);

          // außerhalb Jahresaktivität?
          const overlaps = (mEnd >= activeFrom) && (mStart <= activeTo);
          if (!overlaps) continue;

          // POSITIV: Startmonat = First, sonst Monthly
          let add = 0, addSource = null;
          const isFirstMonth = sameYearMonth(mStart, start);

          if (isFirstMonth) {
            if (effectiveFirst != null) { add = toNumber(effectiveFirst, 0); addSource = (firstCand != null ? 'first' : 'computedFirst'); }
            else if (effectiveMonthly != null) { add = toNumber(effectiveMonthly, 0); addSource = 'monthly(fallback)'; }
          } else {
            if (effectiveMonthly != null) { add = toNumber(effectiveMonthly, 0); addSource = 'monthly'; }
            else if (effectiveFirst != null) { add = toNumber(effectiveFirst, 0); addSource = 'first(fallback)'; }
          }

          // nach Stop-Datum keine positiven Buchungen mehr
          if (stopAt && mStart > endOfMonth(stopAt)) { add = 0; addSource = null; }

          if (add) {
            monthly[m] = round2(monthly[m] + add);
            countPos[m] += 1;
          }

          // NEGATIV: Storno/Kündigung in diesem Monat?
          const stornoAt = b.stornoDate || null;
          const cancelHit =
            (stornoAt && sameYearMonth(stornoAt, mStart)) ||
            (!stornoAt && cancelAt && sameYearMonth(cancelAt, mStart));

          if (cancelHit) {
            let neg = 0, negMode = null;
            if (stornoAt && b.stornoAmount != null) {
              // explizit gesetzter Storno-Betrag hat Vorrang
              neg = toNumber(b.stornoAmount, 0);
              negMode = 'explicit-stornoAmount';
            } else {
              // Startmonat → Teilbetrag, sonst Monatsbetrag
              if (isFirstMonth && effectiveFirst != null) {
                neg = toNumber(effectiveFirst, 0);
                negMode = (firstCand != null ? 'first' : 'computedFirst');
              } else if (effectiveMonthly != null) {
                neg = toNumber(effectiveMonthly, 0);
                negMode = 'monthly';
              } else if (effectiveFirst != null) {
                neg = toNumber(effectiveFirst, 0);
                negMode = (firstCand != null ? 'first' : 'computedFirst');
              }
            }

            if (neg) {
              monthly[m] = round2(monthly[m] - neg);
              countNeg[m] += 1;

              if (debug) {
                lines.push({
                  type: 'NEG',
                  bookingId: String(b._id),
                  month: m,
                  reason: stornoAt ? 'storno' : 'cancellation',
                  amount: neg,
                  mode: negMode,
                });
              }
            }
          }

          if (debug && add) {
            lines.push({
              type: 'POS',
              bookingId: String(b._id),
              month: m,
              add,
              addSource,
              first: (firstCand ?? null),
              monthly: (monthlyCand ?? null),
              computedFirst: (computedFirst ?? null),
              status: b.status || '',
              stopAt: stopAt || null,
              offerCategory: offer.category || null,
            });
          }
        }
      }
    }

    const total = Number(monthly.reduce((a, b) => a + b, 0).toFixed(2));
    const payload = {
      ok: true,
      year,
      total,
      monthly,
      counts: { positive: countPos, negative: countNeg },
    };
    if (debug) payload.debug = { lines };

    res.json(payload);
  } catch (err) {
    console.error('[adminRevenueDerived] error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;










