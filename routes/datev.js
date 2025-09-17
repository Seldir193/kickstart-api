// routes/datev.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const archiver = require('archiver');

const Customer = require('../models/Customer');
const Offer    = require('../models/Offer');

const router = express.Router();

/* ===== Owner helpers ===== */
function getProviderIdRaw(req) {
  const v = req.get('x-provider-id');
  return v ? String(v).trim() : null;
}
function getProviderObjectId(req) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}
function requireOwner(req, res) {
  const owner = getProviderObjectId(req);
  if (!owner) {
    res.status(401).json({ ok: false, error: 'Unauthorized: invalid provider id' });
    return null;
  }
  return owner;
}

/* ===== Helpers ===== */
function parseISODate(d) {
  if (!d) return null;
  const t = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isNaN(t.getTime()) ? null : t;
}
function yyyymmdd(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function fmtDE(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
}
function isInside(date, from, to) {
  if (!date) return false;
  const dt = new Date(date);
  if (Number.isNaN(dt.getTime())) return false;
  if (from && dt < from) return false;
  if (to && dt > to) return false;
  return true;
}

/* Kursname nur Name (ohne Adresse) */
function courseOnly(raw = '') {
  let s = String(raw || '').trim();
  s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];
  const commaDigit = s.search(/,\s*\d/);
  if (commaDigit > 0) s = s.slice(0, commaDigit);
  const dashAddr = s.search(/\s-\s*\d/);
  if (dashAddr > 0) s = s.slice(0, dashAddr);
  return s.trim();
}
/* Buchungstext kurz/sauber */
function cleanText(s = '') {
  const raw = String(s || '')
    .replace(/[;\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return raw.slice(0, 60);
}

/* Beträge bestimmen */
function pickAmountInvoice(b, offer) {
  const cand = [b?.firstMonthAmount, b?.monthlyAmount, b?.priceAtBooking, offer?.price];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function pickAmountStorno(b, offer) {
  const cand = [b?.stornoAmount, b?.priceAtBooking, offer?.price];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/* ===== OPOS Export (simple, wie „vorher“) =====
   GET /api/admin/datev/export?from=YYYY-MM-DD&to=YYYY-MM-DD
*/
router.get('/export', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;

    const from = parseISODate(req.query.from);
    const to   = parseISODate(req.query.to);

    // §19 UStG (Kleinunternehmer) – OPOS
    const AR_ACCOUNT   = Number(process.env.DATEV_AR_ACCOUNT || 10000); // Forderungen
    const REV_ACCOUNT  = Number(process.env.DATEV_REVENUE_ACCOUNT || 8195); // Erlöse §19
    const CURRENCY     = (process.env.DATEV_CURRENCY || 'EUR').toUpperCase();
    const EXPORT_NAME  = process.env.DATEV_EXPORT_NAME || 'Münchner Fussball Schule NRW';

    // Kunden & Bookings laden
    const customers = await Customer.find({ owner })
      .select('_id userId parent child address bookings')
      .lean();

    // Offers lookup (robust: mehrere offerId-Varianten)
    const offerIds = [];
    for (const c of customers) {
      for (const b of (c.bookings || [])) {
        for (const key of ['offerId','offer_id','offer','offerRef']) {
          const v = b?.[key];
          if (v && mongoose.isValidObjectId(String(v))) offerIds.push(String(v));
        }
      }
    }
    const unique = [...new Set(offerIds)];
    const offers = unique.length
      ? await Offer.find({ _id: { $in: unique } })
          .select('_id title type sub_type location price')
          .lean()
      : [];
    const offerById = new Map(offers.map(o => [String(o._id), o]));

    // Zeilen sammeln
    const readable = []; // Kontrollliste
    const extfRows = []; // EXTF-Körper
    const stats = { invOk:0, invSkip:0, stOk:0, stSkip:0 };

    for (const c of customers) {
      for (const b of (c.bookings || [])) {
        // Offer finden
        let off = null;
        for (const key of ['offerId','offer_id','offer','offerRef']) {
          const v = b?.[key];
          if (v && mongoose.isValidObjectId(String(v))) {
            off = offerById.get(String(v));
            if (off) break;
          }
        }

        const course = courseOnly(b.offerTitle || b.offerType || off?.sub_type || off?.title || 'Kurs');

        // ===== Rechnung
        const invNo  = (b?.invoiceNumber || b?.invoiceNo || '').toString().trim();
        const invDt  = b?.invoiceDate || b?.date || b?.createdAt || null;
        const invAmt = pickAmountInvoice(b, off);

        if (invNo && invDt && isInside(invDt, from, to) && Number.isFinite(invAmt) && invAmt > 0) {
          const text = cleanText(`Teilnahme – ${course}`);
          // Soll an Erlöse
          const rowReadable = {
            Umsatz: fmtDE(invAmt),
            SH: 'S',
            WKZ: CURRENCY,
            Konto: AR_ACCOUNT,
            Gegenkonto: REV_ACCOUNT,
            BU: 0,
            Belegdatum: yyyymmdd(invDt),
            Belegnummer: invNo,
            Buchungstext: text,
            Beleglink: ''
          };
          readable.push(rowReadable);
          extfRows.push([
            rowReadable.Umsatz, rowReadable.SH, rowReadable.WKZ,
            rowReadable.Konto, rowReadable.Gegenkonto, rowReadable.BU,
            rowReadable.Belegdatum, rowReadable.Belegnummer, rowReadable.Buchungstext, ''
          ].join(';'));
          stats.invOk++;
        } else {
          stats.invSkip++;
        }

        // ===== Gutschrift / Storno
        const stNo  = (b?.stornoNo || b?.stornoNumber || '').toString().trim();
        const stDt  = b?.stornoDate || b?.cancelDate || b?.cancellationDate || b?.invoiceDate || b?.date || b?.createdAt || null;
        const stAmt = pickAmountStorno(b, off);

        if (stNo && stDt && isInside(stDt, from, to) && Number.isFinite(stAmt) && stAmt > 0) {
          const text = cleanText(`Gutschrift – ${course}`);
          // Erlöse (Soll) an Forderungen
          const rowReadable = {
            Umsatz: fmtDE(stAmt),
            SH: 'S',
            WKZ: CURRENCY,
            Konto: REV_ACCOUNT,
            Gegenkonto: AR_ACCOUNT,
            BU: 0,
            Belegdatum: yyyymmdd(stDt),
            Belegnummer: stNo,
            Buchungstext: text,
            Beleglink: ''
          };
          readable.push(rowReadable);
          extfRows.push([
            rowReadable.Umsatz, rowReadable.SH, rowReadable.WKZ,
            rowReadable.Konto, rowReadable.Gegenkonto, rowReadable.BU,
            rowReadable.Belegdatum, rowReadable.Belegnummer, rowReadable.Buchungstext, ''
          ].join(';'));
          stats.stOk++;
        } else {
          stats.stSkip++;
        }
      }
    }

    // ZIP streamen (ohne Belege/PDFs — wie vorher)
    res.setHeader('Content-Type', 'application/zip');
    const ts = new Date();
    const y = ts.getFullYear(), m = String(ts.getMonth()+1).padStart(2,'0'), d = String(ts.getDate()).padStart(2,'0');
    res.setHeader('Content-Disposition', `attachment; filename="datev-export-${y}${m}${d}.zip"`);

    const archive = archiver('zip', { zlib: { level: 3 } });
    archive.on('error', () => { try { res.status(500).end(); } catch {} });
    archive.pipe(res);

    // 1) Kontrollliste
    const readableHeader = 'Umsatz;SH;WKZ;Konto;Gegenkonto;BU;Belegdatum;Belegnummer;Buchungstext;Beleglink\n';
    const readableBody = readable.map(r =>
      [r.Umsatz, r.SH, r.WKZ, r.Konto, r.Gegenkonto, r.BU, r.Belegdatum, r.Belegnummer, r.Buchungstext, r.Beleglink].join(';')
    ).join('\n');
    archive.append(Buffer.from(readableHeader + readableBody, 'utf8'), { name: 'buchungen_readable.csv' });

    // 2) EXTF Stapel
    const TS = `${y}${m}${d}${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}000`;
    const extfHead = `EXTF;700;21;Buchungsstapel;13;${TS};;${EXPORT_NAME};1;${CURRENCY}\n`;
    const extfBody = extfRows.join('\n');
    archive.append(Buffer.from(extfHead + extfBody, 'utf8'), { name: 'buchungen_extf.csv' });

    await archive.finalize();

    console.log('[DATEV/OPOS simple] stats', stats, 'rows:', extfRows.length);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error', detail: String(err?.message || err) });
  }
});

module.exports = router;

