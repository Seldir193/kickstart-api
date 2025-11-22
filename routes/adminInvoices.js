
// routes/adminInvoices.js
'use strict';
const express  = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const router = express.Router();

/* ---------- Datum normalisieren (Filter) ---------- */
function normalizeFilterDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // 1) yyyy-mm-dd
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // 2) dd.mm.yyyy
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  // unbekanntes Format -> lieber ignorieren
  return null;
}

/* ---------- models: aus app.locals, sonst require() ---------- */
function getModels(req) {
  const Customer =
    req.app?.locals?.models?.Customer || require('../models/Customer');
  const Booking =
    req.app?.locals?.models?.Booking || require('../models/Booking');
  return { Customer, Booking };
}

/* ---------- tenant helper: x-provider-id ---------- */
function getProviderIdRaw(req) {
  const v = req.get('x-provider-id');
  return v ? String(v).trim() : null;
}
function requireOwner(req, res) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) {
    res
      .status(401)
      .json({ ok: false, error: 'Unauthorized: invalid provider id' });
    return null;
  }
  return new Types.ObjectId(raw);
}

/* ---------- utils ---------- */
function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function normalizeSort(s) {
  const def = { field: 'issuedAt', dir: -1 };
  if (!s) return def;
  const [field, dir] = String(s).split(':');
  const map = { asc: 1, ASC: 1, desc: -1, DESC: -1 };
  return { field: field || def.field, dir: map[dir] ?? def.dir };
}
function toDateOnlyString(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}
function toISO(d) {
  try {
    return new Date(d).toISOString();
  } catch {
    return null;
  }
}
function matchesQ(str, q) {
  if (!q) return true;
  if (!str) return false;
  return String(str).toLowerCase().includes(String(q).toLowerCase());
}

/* ---------- map one booking -> logical docs ---------- */
/**
 * Gibt bis zu drei Einträge zurück:
 * - participation: wenn invoiceNumber/invoiceDate vorhanden ODER Holiday-Programm
 * - cancellation : wenn cancellationNo/Number ODER cancelDate/cancellationDate vorhanden
 * - storno       : wenn stornoNo/Number ODER stornoDate vorhanden
 */
function docsFromBooking(customer, b) {
  const items = [];
  const baseTitle = b.offerTitle || b.offerType || 'Booking';

  const invNo   = b.invoiceNumber || b.invoiceNo || null;
  const invDate = b.invoiceDate || null;

  const cancNo   = b.cancellationNo || b.cancellationNumber || null;
  const cancDate = b.cancelDate || b.cancellationDate || null;

  const storNo   = b.stornoNo || b.stornoNumber || null;
  const storDate = b.stornoDate || null;

  // Holiday (Camp / Powertraining) am Text erkennen
  const textForType = `${b.offerTitle || ''} ${b.offerType || ''}`.toLowerCase();
  const isHoliday = /camp|feriencamp|holiday|powertraining|power training/.test(
    textForType
  );

  // Participation-Datum: bevorzugt invoiceDate, sonst createdAt, zuletzt b.date
  const issuedParticipation =
    invDate ||
    b.createdAt ||
    b.date ||
    null;

  // PARTICIPATION:
  // - normale Rechnung (invNo / invDate)
  // - oder Holiday-Programm (Camp / Powertraining) auch ohne invoiceNo
  if (invNo || invDate || isHoliday) {
    items.push({
      id: `inv:${b._id}`,
      bookingId: String(b._id),
      customerId: String(customer._id),
      type: 'participation',
      title: `${baseTitle} – Teilnahmebestätigung`,
      issuedAt: issuedParticipation ? toISO(issuedParticipation) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType: b.offerType || undefined,
      amount:
        b.priceAtBooking != null ? Number(b.priceAtBooking) : undefined,
      currency: b.currency || 'EUR',
      href: `/api/admin/bookings/${encodeURIComponent(
        b._id
      )}/documents/participation`,
    });
  }

  // CANCELLATION: bevorzugt cancelDate, sonst updatedAt/createdAt
  const issuedCancellation =
    cancDate ||
    b.updatedAt ||
    b.createdAt ||
    null;

  if (cancNo || cancDate || String(b.status).toLowerCase() === 'cancelled') {
    items.push({
      id: `can:${b._id}`,
      bookingId: String(b._id),
      customerId: String(customer._id),
      type: 'cancellation',
      title: `${baseTitle} – Kündigungsbestätigung`,
      issuedAt: issuedCancellation ? toISO(issuedCancellation) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType: b.offerType || undefined,
      href: `/api/admin/bookings/${encodeURIComponent(
        b._id
      )}/documents/cancellation`,
    });
  }

  // STORNO: bevorzugt stornoDate, sonst cancelDate
  const issuedStorno =
    storDate ||
    cancDate ||
    null;

  if (storNo || storDate) {
    items.push({
      id: `sto:${b._id}`,
      bookingId: String(b._id),
      customerId: String(customer._id),
      type: 'storno',
      title: `${baseTitle} – Storno-Rechnung`,
      issuedAt: issuedStorno ? toISO(issuedStorno) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType: b.offerType || undefined,
      amount:
        b.stornoAmount != null ? Number(b.stornoAmount) : undefined,
      currency: b.currency || 'EUR',
      href: `/api/admin/bookings/${encodeURIComponent(
        b._id
      )}/documents/storno`,
    });
  }

  console.log('[DOC_FROM_BOOKING]', {
    bookingId: b._id,
    offerTitle: b.offerTitle,
    invoiceDate: b.invoiceDate,
    createdAt: b.createdAt,
    cancelDate: b.cancelDate || null,
    stornoDate: b.stornoDate || null,
    isHoliday,
    issuedParticipation,
  });

  return items;
}

/* ---------- Zentrale Listen-Funktion ---------- */
/**
 * Baut die Liste der Rechnungs-Dokumente.
 * Wird sowohl von GET '/' als auch von GET '/csv' verwendet,
 * damit Filter/Datum/Limit immer identisch sind.
 */
async function buildInvoiceList({ owner, Customer, query }) {
  const page = clamp(query.page, 1, 10_000);
  const limit = clamp(query.limit, 1, 200);
  const skip = (page - 1) * limit;

  const typeStr = String(query.type || '').trim();
  const typeSet = new Set(
    typeStr
      ? typeStr
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : ['participation', 'cancellation', 'storno']
  );

  const q = String(query.q || '').trim();

  // Datum aus Query normalisieren
  const fromStr = normalizeFilterDate(query.from);
  const toStr   = normalizeFilterDate(query.to);

  // Inklusive Tagesgrenzen (lokale Suche, unabhängig von Zeitzone)
  const fromDate = fromStr ? new Date(`${fromStr}T00:00:00`) : null;
  const toDate   = toStr   ? new Date(`${toStr}T23:59:59.999`) : null;

  const sort = normalizeSort(query.sort);

  // Minimalfelder laden
  const customers = await Customer.find(
    { owner },
    {
      'parent.firstName': 1,
      'parent.lastName': 1,
      'parent.email': 1,
      'child.firstName': 1,
      'child.lastName': 1,
      bookings: 1,
    }
  ).lean();

  let all = [];
  for (const c of customers) {
    for (const b of c.bookings || []) {
      const docs = docsFromBooking(c, b);
      for (const r of docs) {
        if (!typeSet.has(r.type)) continue;

        // Freitext
        const blob = [
          c.parent?.firstName,
          c.parent?.lastName,
          c.parent?.email,
          c.child?.firstName,
          c.child?.lastName,
          r.title,
          r.offerTitle,
          r.offerType,
          r.bookingId,
        ]
          .filter(Boolean)
          .join(' ');
        if (!matchesQ(blob, q)) continue;

        // Date-Range (inklusive)
        if (r.issuedAt && (fromDate || toDate)) {
          const t = new Date(r.issuedAt).getTime();
          if (!Number.isNaN(t)) {
            if (fromDate && t < fromDate.getTime()) continue;
            if (toDate && t > toDate.getTime()) continue;
          }
        }

        all.push(r);
      }
    }
  }

  // Sortierung
  all.sort((a, b) => {
    const fa = a[sort.field] ?? '';
    const fb = b[sort.field] ?? '';
    if (fa === fb) return 0;
    return fa > fb ? sort.dir : -sort.dir;
  });

  const total = all.length;
  const items = all.slice(skip, skip + limit);

  return { items, total, page, limit };
}

/* =========================================================
   GET /api/admin/invoices
========================================================= */
router.get('/', async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const { Customer } = getModels(req);

    const { items, total, page, limit } = await buildInvoiceList({
      owner,
      Customer,
      query: req.query,
    });

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    console.error('[adminInvoices] GET / error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* =========================================================
   GET /api/admin/invoices/csv
   -> CSV der *aktuellen* Liste (gleiche Filter wie GET /)
========================================================= */
router.get('/csv', async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const { Customer } = getModels(req);

    // Genau gleiche Liste wie in GET '/'
    const { items } = await buildInvoiceList({
      owner,
      Customer,
      query: req.query,
    });

    const header = [
      'type',
      'issuedAt',
      'title',
      'offerType',
      'offerTitle',
      'amount',
      'currency',
      'bookingId',
      'customerId',
    ];

    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmtDate = (val) => {
      if (!val) return '';
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 10);
    };

    const lines = [
      header.join(','),
      ...items.map((it) => {
        const row = {
          type: it.type || '',
          issuedAt: fmtDate(it.issuedAt),
          title: it.title || '',
          offerType: it.offerType || '',
          offerTitle: it.offerTitle || '',
          amount: it.amount != null ? String(it.amount) : '',
          currency: it.currency || '',
          bookingId: it.bookingId || '',
          customerId: it.customerId || '',
        };
        return header.map((k) => esc(row[k])).join(',');
      }),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.status(200).send(lines.join('\n'));
  } catch (err) {
    console.error('[adminInvoices] GET /csv error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* =========================================================
   GET /api/admin/invoices/zip
   -> ZIP mit PDFs + invoices.csv
========================================================= */
router.get('/zip', async (req, res) => {
  try {
    const archiver = require('archiver');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.zip"' );

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      throw err;
    });
    archive.pipe(res);

    const origin   = `${req.protocol}://${req.get('host')}`;
    const provider = req.get('x-provider-id') || '';

    // Query-Params mit großem Limit für ZIP
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query || {})) {
      if (value == null) continue;
      params.set(key, String(value));
    }
    params.set('page', '1');
    params.set('limit', '10000');
    const qs = params.toString();

    const listResp = await fetch(`${origin}/api/admin/invoices?${qs}`, {
      headers: provider ? { 'x-provider-id': provider } : {},
    });
    if (!listResp.ok) {
      throw new Error(`List fetch failed: HTTP ${listResp.status}`);
    }
    const listData = await listResp.json();
    const items = Array.isArray(listData?.items) ? listData.items : [];

    // CSV in ZIP
    const header = [
      'type',
      'issuedAt',
      'title',
      'offerType',
      'offerTitle',
      'amount',
      'currency',
      'bookingId',
      'customerId',
    ];
    const csv = [
      header.join(','),
      ...items.map((it) => {
        const row = {
          type: it.type || '',
          issuedAt: it.issuedAt
            ? new Date(it.issuedAt).toISOString().slice(0, 10)
            : '',
          title: it.title || '',
          offerType: it.offerType || '',
          offerTitle: it.offerTitle || '',
          amount: it.amount != null ? String(it.amount) : '',
          currency: it.currency || '',
          bookingId: it.bookingId || '',
          customerId: it.customerId || '',
        };
        return header
          .map((k) => {
            const v = row[k] == null ? '' : String(row[k]);
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          })
          .join(',');
      }),
    ].join('\n');
    archive.append(Buffer.from(csv, 'utf8'), { name: 'invoices.csv' });

    // PDFs in ZIP
    const typeToPdf = (t) =>
      t === 'cancellation'
        ? 'cancellation'
        : t === 'storno'
        ? 'storno'
        : 'participation';

    for (const it of items) {
      try {
        let pdfUrl = '';
        if (it.customerId && it.bookingId) {
          pdfUrl =
            `${origin}/api/admin/customers/${encodeURIComponent(
              it.customerId
            )}/bookings/${encodeURIComponent(it.bookingId)}/` +
            `${typeToPdf(it.type)}.pdf`;
        } else if (it.href) {
          pdfUrl = `${origin}${it.href}`;
        } else {
          throw new Error('missing customerId/bookingId and href');
        }

        const r = await fetch(pdfUrl, {
          headers: provider ? { 'x-provider-id': provider } : {},
          redirect: 'follow',
        });

        if (!r.ok) {
          const msg = `Fetch failed (${r.status}) for ${pdfUrl}`;
          archive.append(Buffer.from(msg, 'utf8'), {
            name: `error-${it.bookingId || 'unknown'}.txt`,
          });
          continue;
        }

        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const buf = Buffer.from(await r.arrayBuffer());

        const safeTitle = (it.title || `${it.type}-${it.bookingId}` || 'document')
          .replace(/[\\/:*?"<>|]+/g, '_')
          .slice(0, 80);

        const ext = ct.includes('pdf') ? '.pdf' : '.bin';
        archive.append(buf, { name: `${safeTitle}${ext}` });
      } catch (e) {
        const msg = `Error fetching booking ${it.bookingId}: ${
          (e && e.message) || e
        }`;
        archive.append(Buffer.from(msg, 'utf8'), {
          name: `error-${it.bookingId || 'unknown'}.txt`,
        });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('[adminInvoices] GET /zip error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
