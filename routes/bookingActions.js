
// routes/bookingActions.js
const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const Customer = require('../models/Customer');
const Offer    = require('../models/Offer');

const { buildCancellationPdf, buildStornoPdf } = require('../utils/pdf');
const { sendCancellationEmail, sendStornoEmail } = require('../utils/mailer');
const { prorateForStart, nextPeriodStart, fmtAmount, normCurrency } = require('../utils/billing');


// ... deine bestehenden requires
const { buildParticipationPdfHTML, buildCancellationPdfHTML, buildStornoPdfHTML } = require('../utils/pdfHtml');



const router = express.Router();











/* -------- Provider/Owner helpers (Header: x-provider-id) -------- */
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
function requireIds(req, res) {
  const cid = String(req.params.cid || '').trim();
  const bid = String(req.params.bid || '').trim();
  if (!mongoose.isValidObjectId(cid)) { res.status(400).json({ error: 'Invalid customer id' }); return null; }
  if (!mongoose.isValidObjectId(bid)) { res.status(400).json({ error: 'Invalid booking id' }); return null; }
  return { cid, bid };
}

/* ===================== CANCEL ===================== */
router.post('/:cid/bookings/:bid/cancel', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const ids = requireIds(req, res); if (!ids) return;

    const { date, reason } = req.body || {};
    const cancelAt = date ? new Date(date) : new Date();

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Optional: nur bestimmte Typen erlauben (falls gewünscht)
    // const offer = await Offer.findById(booking.offerId).lean();
    // if (!offer) return res.status(404).json({ error: 'Offer not found' });
    // const CANCEL_ALLOWED = new Set(['Kindergarten', 'Foerdertraining']);
    // if (!CANCEL_ALLOWED.has(offer.type)) return res.status(400).json({ error: 'This offer type cannot be cancelled' });

    booking.status = 'cancelled';
    booking.cancelDate = cancelAt;
    booking.cancelReason = String(reason || '');

    await customer.save();

    (async () => {
      try {
        const pdf = await buildCancellationPdf({
          parentFirst: customer.parent?.firstName,
          parentLast:  customer.parent?.lastName,
          childFirst:  customer.child?.firstName,
          childLast:   customer.child?.lastName,
          cancelled:   { date: cancelAt, reason },
        });

        await sendCancellationEmail({
          customer: customer.toObject ? customer.toObject() : customer,
          booking: {
            _id: booking._id,
            offerTitle: booking.offerTitle,
            offerType: booking.offerType,
            date: booking.date,
          },
          pdfBuffer: pdf,
          effectiveDateISO: date,
        });
      } catch (e) {
        console.warn('[cancel] email/pdf failed:', e?.message || e);
      }
    })();

    res.json({ ok: true, booking });
  } catch (err) {
    console.error('[cancel] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
















/* ===================== STORNO ===================== */
router.post('/:cid/bookings/:bid/storno', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const ids = requireIds(req, res); if (!ids) return;

    const { note } = req.body || {};

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    booking.status = 'cancelled';
    booking.cancelDate = new Date();
    booking.cancelReason = note ? `storno: ${note}` : 'storno';

    await customer.save();

    (async () => {
      try {
        const pdf = await buildStornoPdf({
          customer: {
            parentFirst: customer.parent?.firstName,
            parentLast:  customer.parent?.lastName,
            childFirst:  customer.child?.firstName,
            childLast:   customer.child?.lastName,
          },
          booking: {
            _id: booking._id,
            offerTitle: booking.offerTitle,
            type: booking.offerType,
            date: booking.date,
          },
          note,
        });

        await sendStornoEmail({
          customer: customer.toObject ? customer.toObject() : customer,
          booking: {
            _id: booking._id,
            offerTitle: booking.offerTitle,
            offerType: booking.offerType,
            date: booking.date,
          },
          pdfBuffer: pdf,
          note,
        });
      } catch (e) {
        console.warn('[storno] email/pdf failed:', e?.message || e);
      }
    })();

    res.json({ ok: true, booking });
  } catch (err) {
    console.error('[storno] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});




















/* ========= PARTICIPATION PDF ========= */
router.get('/:cid/bookings/:bid/participation.pdf', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const ids = requireIds(req, res); if (!ids) return;

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;

    const buf = await buildParticipationPdfHTML({
      customer: customer.toObject ? customer.toObject() : customer,
      booking : booking.toObject ? booking.toObject() : booking,
      offer,
      // optionale Felder aus Booking nutzen, falls vorhanden:
      invoiceNo:   booking.invoiceNo || booking.invoiceNumber,
      invoiceDate: booking.invoiceDate,
      monthlyAmount: booking.priceMonthly ?? booking.monthlyAmount,
      firstMonthAmount: booking.priceFirstMonth ?? booking.firstMonthAmount,
      venue: booking.venue || booking.location,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="participation-${ids.bid}.pdf"`);
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error('[participation.pdf] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* ========= CANCELLATION PDF ========= */
router.get('/:cid/bookings/:bid/cancellation.pdf', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const ids = requireIds(req, res); if (!ids) return;

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;

    const date   = req.query.date   ? new Date(String(req.query.date)) : (booking.cancelDate || booking.cancellationDate);
    const reason = req.query.reason ? String(req.query.reason) : (booking.cancelReason || '');

    const buf = await buildCancellationPdfHTML({
      customer: customer.toObject ? customer.toObject() : customer,
      booking : booking.toObject ? booking.toObject() : booking,
      offer,
      date,
      reason,
      cancellationNo: booking.cancellationNo || booking.cancellationNumber, // falls vorhanden
      referenceInvoice: (booking.invoiceNo || booking.invoiceNumber) ? {
        number: booking.invoiceNo || booking.invoiceNumber,
        date:   booking.invoiceDate || null,
      } : undefined,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cancellation-${ids.bid}.pdf"`);
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error('[cancellation.pdf] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* ========= STORNO PDF ========= */
router.get('/:cid/bookings/:bid/storno.pdf', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const ids = requireIds(req, res); if (!ids) return;

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;

    const amount   = (req.query.amount != null) ? Number(req.query.amount) : (booking.stornoAmount ?? offer?.price ?? 0);
    const currency = req.query.currency ? String(req.query.currency) : (booking.currency || 'EUR');

    const buf = await buildStornoPdfHTML({
      customer: customer.toObject ? customer.toObject() : customer,
      booking : booking.toObject ? booking.toObject() : booking,
      offer,
      amount,
      currency,
      stornoNo: booking.stornoNo || booking.stornoNumber, // falls vorhanden
      referenceInvoice: (booking.invoiceNo || booking.invoiceNumber) ? {
        number: booking.invoiceNo || booking.invoiceNumber,
        date:   booking.invoiceDate || null,
      } : undefined,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="storno-${ids.bid}.pdf"`);
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error('[storno.pdf] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});







/* ============== INVOICES: computed list (limit/skip) ============== */
router.get('/:cid/invoices', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const cid = String(req.params.cid || '').trim();
    if (!mongoose.isValidObjectId(cid)) return res.status(400).json({ error: 'Invalid customer id' });

    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 5)));
    const skip  = Math.max(0, Number(req.query.skip || 0));

    const customer = await Customer.findOne({ _id: cid, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const out = [];

    for (const b of (customer.bookings || [])) {
      if (!b || !b.offerId) continue;

      let { priceMonthly, priceFirstMonth, currency } = b;
      currency = normCurrency(currency || 'EUR');

      if (priceMonthly == null) {
        const offer = await Offer.findById(b.offerId).select('price').lean();
        if (offer && typeof offer.price === 'number') priceMonthly = offer.price;
      }
      if (priceMonthly == null) continue;

      const startISO = b.date ? new Date(b.date).toISOString().slice(0,10) : null;
      if (priceFirstMonth == null && startISO) {
        const pro = prorateForStart(startISO, priceMonthly);
        priceFirstMonth = pro.firstMonthPrice;
      }

      const first = (startISO && priceFirstMonth != null) ? {
        bookingId: String(b._id),
        type: 'first-month',
        title: b.offerTitle || b.offerType || 'Subscription',
        date: startISO,
        amount: Number(priceFirstMonth),
        currency,
      } : null;

      const recurISO = startISO ? nextPeriodStart(startISO) : null;
      const recurring = (recurISO && priceMonthly != null) ? {
        bookingId: String(b._id),
        type: 'recurring',
        title: (b.offerTitle || b.offerType || 'Subscription') + ' (monthly)',
        date: recurISO,
        amount: Number(priceMonthly),
        currency,
      } : null;

      if (first) out.push(first);
      if (recurring) out.push(recurring);
    }

    out.sort((a,b) => String(a.date).localeCompare(String(b.date)));

    const items = out.slice(skip, skip + limit);
    res.json({ ok: true, total: out.length, items });
  } catch (err) {
    console.error('[invoices] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ========= INVOICE PDF (first | recurring) for one booking ========= */
router.get('/:cid/bookings/:bid/invoice.pdf', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const ids = requireIds(req, res); if (!ids) return;

    const type = (String(req.query.type || 'first').toLowerCase() === 'recurring') ? 'recurring' : 'first';

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    let { priceMonthly, priceFirstMonth, currency } = booking;
    currency = normCurrency(currency || 'EUR');

    if (priceMonthly == null) {
      const offer = await Offer.findById(booking.offerId).select('price').lean();
      if (offer && typeof offer.price === 'number') priceMonthly = offer.price;
    }
    const startISO = booking.date ? new Date(booking.date).toISOString().slice(0,10) : null;
    if (priceFirstMonth == null && startISO && priceMonthly != null) {
      const pro = prorateForStart(startISO, priceMonthly);
      priceFirstMonth = pro.firstMonthPrice;
    }

    let invoiceDateISO = startISO;
    let amount = priceFirstMonth;
    let invoiceTitle = booking.offerTitle || booking.offerType || 'Subscription – first month';

    if (type === 'recurring') {
      invoiceDateISO = startISO ? nextPeriodStart(startISO) : null;
      amount = priceMonthly;
      invoiceTitle = (booking.offerTitle || booking.offerType || 'Subscription') + ' – monthly';
    }

    if (amount == null || !invoiceDateISO) {
      return res.status(400).json({ error: 'Invoice data incomplete for this booking' });
    }

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${type}-${ids.bid}.pdf"`);

    // Header
    doc.fontSize(20).text('Invoice', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666')
      .text('KickStart Academy', { align: 'right' })
      .text('Duisburg, NRW', { align: 'right' })
      .text('info@kickstart-academy.de', { align: 'right' })
      .fillColor('#000');

    // Customer
    doc.moveDown();
    const parentName = [customer.parent?.firstName, customer.parent?.lastName].filter(Boolean).join(' ') || '—';
    const childName  = [customer.child?.firstName, customer.child?.lastName].filter(Boolean).join(' ') || '—';
    doc.fontSize(12).text(`Customer: ${parentName}`);
    doc.text(`Child: ${childName}`);
    doc.text(`Booking: ${booking.offerTitle || booking.offerType || booking._id}`);
    doc.text(`Invoice date: ${invoiceDateISO}`);
    doc.moveDown();

    // Line
    doc.text(`Description: ${invoiceTitle}`);
    doc.text(`Amount: ${fmtAmount(amount)} ${currency}`);

    doc.moveDown(2);
    doc.fontSize(10).fillColor('#666')
      .text('This invoice is generated automatically.', { align: 'center' })
      .fillColor('#000');

    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('[invoice.pdf] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});






/* ========= GLOBAL DOCUMENT ALIAS ========= */
// GET /api/admin/bookings/:bid/documents/:type
router.get('/bookings/:bid/documents/:type', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const { bid, type } = req.params;

    // Booking-ID prüfen
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    // Nur erlaubte Dokument-Typen
    const ALLOWED = new Set(['participation', 'cancellation', 'storno']);
    const t = String(type || '').toLowerCase();
    if (!ALLOWED.has(t)) {
      return res.status(400).json({ error: 'Invalid document type' });
    }

    // Customer finden, der dieses Booking enthält
    const customer = await Customer.findOne({ owner, 'bookings._id': bid });
    if (!customer) return res.status(404).json({ error: 'Customer not found for booking' });

    // Redirect auf bestehenden Kunden-Pfad
    const redirectPath = `/api/admin/customers/${customer._id}/bookings/${bid}/${t}.pdf`;
    return res.redirect(302, redirectPath);
  } catch (err) {
    console.error('[alias-documents] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});












/* ========== PER-CUSTOMER DOCUMENT LIST ==========
   GET /api/admin/customers/:cid/documents?page=&limit=&type=&from=&to=&q=&sort=
*/
router.get('/:cid/documents', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const cid = String(req.params.cid || '').trim();
    if (!mongoose.isValidObjectId(cid)) {
      return res.status(400).json({ ok:false, error:'Invalid customer id' });
    }

    // Query-Parameter
    const page  = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20))); // Client überschreibt; s.u.
    const types = String(req.query.type || 'participation,cancellation,storno')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const from  = req.query.from ? new Date(String(req.query.from)) : null;
    const to    = req.query.to   ? new Date(String(req.query.to))   : null;
    const q     = String(req.query.q || '').toLowerCase();
    const sort  = String(req.query.sort || 'issuedAt:desc'); // issuedAt:asc|desc

    const customer = await Customer.findOne({ _id: cid, owner }).lean();
    if (!customer) return res.status(404).json({ ok:false, error:'Customer not found' });

    const items = [];

    for (const b of (customer.bookings || [])) {
      if (!b?._id) continue;
      const bid = String(b._id);
      const offerTitle = b.offerTitle || b.offerType || b.offer || '-';

      // participation: immer verfügbar
      if (types.includes('participation')) {
        items.push({
          id: `doc:${bid}:participation`,
          bookingId: bid,
          type: 'participation',
          title: `${offerTitle} – Teilnahmebestätigung`,
          issuedAt: (b.date || b.createdAt || new Date()),
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/participation.pdf`,
          offerTitle,
          offerType: b.offerType || '',
        });
      }

      // cancellation: nur wenn storniert / Datum vorhanden
      const isCancelled = (b.status === 'cancelled' || b.cancelDate || b.cancellationDate);
      if (types.includes('cancellation') && isCancelled) {
        items.push({
          id: `doc:${bid}:cancellation`,
          bookingId: bid,
          type: 'cancellation',
          title: `${offerTitle} – Kündigungsbestätigung`,
          issuedAt: (b.cancelDate || b.cancellationDate || b.updatedAt || new Date()),
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/cancellation.pdf`,
          offerTitle,
          offerType: b.offerType || '',
        });
      }

      // storno: wenn storno-Hinweise vorhanden
      const hasStorno =
        b.stornoNo ||
        (typeof b.stornoAmount === 'number') ||
        String(b.cancelReason || '').toLowerCase().includes('storno');
      if (types.includes('storno') && hasStorno) {
        items.push({
          id: `doc:${bid}:storno`,
          bookingId: bid,
          type: 'storno',
          title: `${offerTitle} – Stornorechnung`,
          issuedAt: (b.cancelDate || b.updatedAt || new Date()),
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/storno.pdf`,
          offerTitle,
          offerType: b.offerType || '',
        });
      }
    }

    // Text-/Datumsfilter
    const filtered = items.filter(it => {
      if (q) {
        const hay = `${it.title} ${it.offerTitle} ${it.type}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (from) {
        const d = new Date(it.issuedAt);
        if (isFinite(+from) && isFinite(+d) && d < from) return false;
      }
      if (to) {
        const d = new Date(it.issuedAt);
        if (isFinite(+to) && isFinite(+d) && d > to) return false;
      }
      return true;
    });

    // Sortierung
    const [field, dir] = sort.split(':');
    if (field === 'issuedAt') {
      filtered.sort((a, b) => {
        const av = a.issuedAt ? new Date(a.issuedAt).getTime() : 0;
        const bv = b.issuedAt ? new Date(b.issuedAt).getTime() : 0;
        return (dir === 'asc') ? (av - bv) : (bv - av);
      });
    }

    // Pagination
    const total = filtered.length;
    const start = (page - 1) * limit;
    const end   = start + limit;
    const pageItems = filtered.slice(start, end);

    return res.json({ ok:true, items: pageItems, total, page, limit });
  } catch (err) {
    console.error('[customers/:cid/documents] error:', err);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});














module.exports = router;




