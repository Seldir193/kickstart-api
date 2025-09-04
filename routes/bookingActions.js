










// routes/bookingActions.js
const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const Customer = require('../models/Customer');
const Offer    = require('../models/Offer');

const { buildCancellationPdf, buildStornoPdf } = require('../utils/pdf');
const { sendCancellationEmail, sendStornoEmail } = require('../utils/mailer');
const { prorateForStart, nextPeriodStart, fmtAmount, normCurrency } = require('../utils/billing');

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

module.exports = router;