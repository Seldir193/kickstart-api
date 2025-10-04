// routes/adminInvoices.js
'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const router = express.Router();

/* ---------- models: aus app.locals, sonst require() ---------- */
function getModels(req) {
  const Customer = req.app?.locals?.models?.Customer || require('../models/Customer');
  // Booking wird hier nicht zwingend benötigt, aber wir lassen es wie gehabt verfügbar
  const Booking  = req.app?.locals?.models?.Booking  || require('../models/Booking');
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
    res.status(401).json({ ok: false, error: 'Unauthorized: invalid provider id' });
    return null;
  }
  return new Types.ObjectId(raw);
}


/* ---------- utils ---------- */
function parseBool(v, def = false) { if (v == null) return def; const s = String(v).toLowerCase(); return s === '1' || s === 'true' || s === 'yes'; }
function clamp(n, min, max) { n = Number(n); if (!Number.isFinite(n)) return min; return Math.max(min, Math.min(max, n)); }
function normalizeSort(s) {
  const def = { field: 'issuedAt', dir: -1 };
  if (!s) return def;
  const [field, dir] = String(s).split(':');
  const map = { asc: 1, ASC: 1, desc: -1, DESC: -1 };
  return { field: field || def.field, dir: map[dir] ?? def.dir };
}
function toDateOnlyString(d) {
  try { return new Date(d).toISOString().slice(0, 10); } catch { return null; }
}
function toISO(d) {
  try { return new Date(d).toISOString(); } catch { return null; }
}
function matchesQ(str, q) {
  if (!q) return true;
  if (!str) return false;
  return String(str).toLowerCase().includes(String(q).toLowerCase());
}

/* ---------- map one booking -> one or more logical docs ---------- */
/**
 * Gibt bis zu drei Einträge zurück:
 * - participation: wenn invoiceNumber/invoiceDate (oder legacy invoiceNo) vorhanden
 * - cancellation : wenn cancellationNo/Number ODER cancelDate/cancellationDate vorhanden
 * - storno       : wenn stornoNo/Number ODER stornoDate vorhanden
 *
 * item = {
 *   id, bookingId, customerId, type, title, issuedAt,
 *   offerTitle, offerType, amount?, currency?, href
 * }
 */
function docsFromBooking(customer, b) {
  const items = [];
  const baseTitle = b.offerTitle || b.offerType || 'Booking';

  const invNo   = b.invoiceNumber || b.invoiceNo || null;
  const invDate = b.invoiceDate   || null;

  const cancNo   = b.cancellationNo || b.cancellationNumber || null;
  const cancDate = b.cancelDate || b.cancellationDate || null;

  const storNo   = b.stornoNo || b.stornoNumber || null;
  const storDate = b.stornoDate || null;

  // PARTICIPATION (wenn eine Art Rechnung existiert/gesetzt wurde)
  if (invNo || invDate) {
    items.push({
      id: `inv:${b._id}`,
      bookingId: String(b._id),
      customerId: String(customer._id),
      type: 'participation',
      title: `${baseTitle} – Teilnahmebestätigung`,
      issuedAt: invDate ? toISO(invDate) : (b.createdAt ? toISO(b.createdAt) : undefined),
      offerTitle: b.offerTitle || undefined,
      offerType:  b.offerType  || undefined,
      amount: (b.priceAtBooking != null) ? Number(b.priceAtBooking) : undefined,
      currency: b.currency || 'EUR',
      //href: `/api/admin/customers/${encodeURIComponent(customer._id)}/bookings/${encodeURIComponent(b._id)}/documents/participation`,
      href: `/api/admin/bookings/${encodeURIComponent(b._id)}/documents/participation`,
    });
  }

  // CANCELLATION (fix: beachte cancelDate ODER cancellationDate, sowie No/Number)
  if (cancNo || cancDate || String(b.status).toLowerCase() === 'cancelled') {
    const issued = cancDate || b.updatedAt || b.createdAt;
    items.push({
      id: `can:${b._id}`,
      bookingId: String(b._id),
      customerId: String(customer._id),
      type: 'cancellation',
      title: `${baseTitle} – Kündigungsbestätigung`,
      issuedAt: issued ? toISO(issued) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType:  b.offerType  || undefined,
      //href: `/api/admin/customers/${encodeURIComponent(customer._id)}/bookings/${encodeURIComponent(b._id)}/documents/cancellation`,
      href: `/api/admin/bookings/${encodeURIComponent(b._id)}/documents/cancellation`,
    });
  }

  // STORNO (nur wenn stornoNo/Date vorhanden – so vermeidest du „leere“ Stornos)
  if (storNo || storDate) {
    items.push({
      id: `sto:${b._id}`,
      bookingId: String(b._id),
      customerId: String(customer._id),
      type: 'storno',
      title: `${baseTitle} – Storno-Rechnung`,
      issuedAt: storDate ? toISO(storDate) : (cancDate ? toISO(cancDate) : undefined),
      offerTitle: b.offerTitle || undefined,
      offerType:  b.offerType  || undefined,
      amount: (b.stornoAmount != null) ? Number(b.stornoAmount) : undefined,
      currency: b.currency || 'EUR',
      //href: `/api/admin/customers/${encodeURIComponent(customer._id)}/bookings/${encodeURIComponent(b._id)}/documents/storno`,
      href: `/api/admin/bookings/${encodeURIComponent(b._id)}/documents/storno`,
    });
  }

  return items;
}

/* =========================================================
   GET /api/admin/invoices
   Query:
     page, limit
     type=participation,cancellation,storno
     q=search
     from=yyyy-mm-dd
     to=yyyy-mm-dd
     sort=issuedAt:desc|asc|title:asc ...
   Returns: { ok, items, total, page, limit }
========================================================= */
router.get('/', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;

    const { Customer } = getModels(req);

    const page  = clamp(req.query.page, 1, 10_000);
    const limit = clamp(req.query.limit, 1, 200);
    const skip  = (page - 1) * limit;

    const typeStr = String(req.query.type || '').trim();
    const typeSet = new Set(
      typeStr
        ? typeStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : ['participation', 'cancellation', 'storno']
    );

    const q    = String(req.query.q    || '').trim();
    const from = String(req.query.from || '').trim(); // yyyy-mm-dd
    const to   = String(req.query.to   || '').trim();
    const sort = normalizeSort(req.query.sort);

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
      for (const b of (c.bookings || [])) {
        const docs = docsFromBooking(c, b);
        for (const r of docs) {
          if (!typeSet.has(r.type)) continue;

          // Freitext: parent/child/offer/title/bookingId/email
          const blob = [
            c.parent?.firstName, c.parent?.lastName, c.parent?.email,
            c.child?.firstName,  c.child?.lastName,
            r.title, r.offerTitle, r.offerType,
            r.bookingId,
          ].filter(Boolean).join(' ');
          if (!matchesQ(blob, q)) continue;

          // Date range
          const d = r.issuedAt ? toDateOnlyString(r.issuedAt) : null;
          if (from && d && d < from) continue;
          if (to   && d && d > to)   continue;

          all.push(r);
        }
      }
    }

    // Sort
    all.sort((a,b) => {
      const fa = a[sort.field] ?? '';
      const fb = b[sort.field] ?? '';
      if (fa === fb) return 0;
      return fa > fb ? sort.dir : -sort.dir;
    });

    const total = all.length;
    const items = all.slice(skip, skip + limit);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    console.error('[adminInvoices] GET / error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* =========================================================
   GET /api/admin/invoices/csv
   gleiche Query-Params; erzeugt CSV der *aktuellen* Liste
========================================================= */
router.get('/csv', async (req, res) => {
  try {
    // Wir rufen unsere eigene JSON-Liste auf, um exakt dieselbe Filterung/Paging zu haben
    const origin = `${req.protocol}://${req.get('host')}`;
    const qs = req.originalUrl.split('?')[1] || '';
    const provider = getProviderIdRaw(req) || '';

    const r = await fetch(`${origin}/api/admin/invoices?${qs}`, {
      headers: { ...(provider ? { 'x-provider-id': provider } : {}) },
    });
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: 'Upstream list failed' });
    }
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];

    const header = ['type', 'issuedAt', 'title', 'offerType', 'offerTitle', 'amount', 'currency', 'bookingId', 'customerId'];
    const csv = [
      header.join(','),
      ...items.map((it) => {
        const row = {
          type: it.type || '',
          issuedAt: it.issuedAt ? toDateOnlyString(it.issuedAt) : '',
          title: it.title || '',
          offerType: it.offerType || '',
          offerTitle: it.offerTitle || '',
          amount: (it.amount != null) ? String(it.amount) : '',
          currency: it.currency || '',
          bookingId: it.bookingId || '',
          customerId: it.customerId || '',
        };
        return header.map(k => {
          const v = row[k] == null ? '' : String(row[k]);
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',');
      })
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error('[adminInvoices] GET /csv error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});















/* =========================================================
   GET /api/admin/invoices/zip
   -> ZIP mit PDFs (participation/cancellation/storno) + invoices.csv
   Wichtig: wir bauen die PDF-URLs DIREKT aus customerId+bookingId,
   nicht über den Alias, um 404 bei nicht-eingebetteten Bookings zu vermeiden.
========================================================= */
router.get('/zip', async (req, res) => {
  try {
    const archiver = require('archiver');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    // 1) Liste der Items holen – gleiche Query wie auf der Seite
    const origin   = `${req.protocol}://${req.get('host')}`;
    const qs       = req.originalUrl.split('?')[1] || '';
    const provider = req.get('x-provider-id') || '';

    const listResp = await fetch(`${origin}/api/admin/invoices?${qs}`, {
      headers: { ...(provider ? { 'x-provider-id': provider } : {}) },
    });
    if (!listResp.ok) {
      throw new Error(`List fetch failed: HTTP ${listResp.status}`);
    }
    const listData = await listResp.json();
    const items = Array.isArray(listData?.items) ? listData.items : [];

    // 2) CSV beilegen (aus Items)
    const header = ['type','issuedAt','title','offerType','offerTitle','amount','currency','bookingId','customerId'];
    const csv = [
      header.join(','),
      ...items.map((it) => {
        const row = {
          type: it.type || '',
          issuedAt: it.issuedAt ? new Date(it.issuedAt).toISOString().slice(0,10) : '',
          title: it.title || '',
          offerType: it.offerType || '',
          offerTitle: it.offerTitle || '',
          amount: (it.amount != null) ? String(it.amount) : '',
          currency: it.currency || '',
          bookingId: it.bookingId || '',
          customerId: it.customerId || '',
        };
        return header.map((k) => {
          const v = row[k] == null ? '' : String(row[k]);
          return /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v;
        }).join(',');
      }),
    ].join('\n');
    archive.append(Buffer.from(csv, 'utf8'), { name: 'invoices.csv' });

    // 3) PDFs direkt holen (ohne Alias) und in ZIP legen
    const typeToPdf = (t) =>
      t === 'cancellation' ? 'cancellation'
    : t === 'storno'       ? 'storno'
    :                        'participation';

    for (const it of items) {
      try {
        // prefer direkter PDF-URL, fallback auf Alias wenn customerId fehlt
        let pdfUrl = '';
        if (it.customerId && it.bookingId) {
          pdfUrl = `${origin}/api/admin/customers/${encodeURIComponent(it.customerId)}` +
                   `/bookings/${encodeURIComponent(it.bookingId)}/${typeToPdf(it.type)}.pdf`;
        } else if (it.href) {
          // Fallback: Alias (kann 404 liefern, wenn Booking nicht eingebettet ist)
          pdfUrl = `${origin}${it.href}`;
        } else {
          throw new Error('missing customerId/bookingId and href');
        }

        const r = await fetch(pdfUrl, {
          headers: { ...(provider ? { 'x-provider-id': provider } : {}) },
          redirect: 'follow',
        });

        if (!r.ok) {
          const msg = `Fetch failed (${r.status}) for ${pdfUrl}`;
          archive.append(Buffer.from(msg, 'utf8'), {
            name: `error-${(it.bookingId || 'unknown')}.txt`,
          });
          continue;
        }

        const ct  = (r.headers.get('content-type') || '').toLowerCase();
        const buf = Buffer.from(await r.arrayBuffer());

        const safeTitle = (it.title || `${it.type}-${it.bookingId}` || 'document')
          .replace(/[\\/:*?"<>|]+/g, '_')
          .slice(0, 80);

        const ext = ct.includes('pdf') ? '.pdf' : '.bin';
        archive.append(buf, { name: `${safeTitle}${ext}` });
      } catch (e) {
        const msg = `Error fetching booking ${it.bookingId}: ${(e && e.message) || e}`;
        archive.append(Buffer.from(msg, 'utf8'), {
          name: `error-${(it.bookingId || 'unknown')}.txt`,
        });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('[adminInvoices] GET /zip error:', err);
    res.status(500).json({ ok:false, error: 'Server error' });
  }
});

















module.exports = router;













