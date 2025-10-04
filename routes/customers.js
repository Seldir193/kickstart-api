// routes/customers.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { Types } = mongoose;

const { assignInvoiceData } = require('../utils/billing');
const {
  nextSequence,
  yearFrom,
  typeCodeFromOffer,       // PW für Powertraining etc.
  typeCodeFromOfferType,   // Fallback
  formatNumber,
  formatInvoiceShort,
  formatCancellationNo,
  formatStornoNo,
} = require('../utils/sequences');

const { normalizeInvoiceNo } = require('../utils/pdfData');

const Customer = require('../models/Customer');
const Offer    = require('../models/Offer');

const Booking  = require('../models/Booking'); // <-- hinzufügen


const { syncCustomerNewsletter } = require('../services/marketingSync');


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

/* ======= Helpers / Regeln ======= */
/** Darf eine Buchung gekündigt werden? */
function isCancelAllowed(offer) {
  if (!offer) return false;

  // 1) Primär: wöchentliche Abos sind kündbar
  if (String(offer.category) === 'Weekly') return true;

  // 2) Fallback für ältere Einträge ohne category
  const t  = String(offer.type || '');
  if (t === 'Foerdertraining' || t === 'Kindergarten') return true;

  // 3) Explizit NICHT kündbar
  const sub = String(offer.sub_type || '').toLowerCase();
  if (sub === 'powertraining') return false;         // Holiday Program
  if (t === 'PersonalTraining') return false;        // Individual

  return false;
}

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



// routes/customers.js
function buildFilter(query, owner) {
  const { q, newsletter, tab } = query || {};
  const filter = { owner };
  const t = String(tab || '').toLowerCase();

  if (t === 'newsletter') {
    // reine Newsletter-Leads (keine Buchungen)
    filter.newsletter = true;
    filter['bookings.0'] = { $exists: false };
  } else if (t === 'customers') {
    // echte Kunden (mind. 1 Buchung) – newsletter-Filter HIER IGNORIEREN
    filter['bookings.0'] = { $exists: true };
  } else {
    // Tab "all": optional nach Newsletter filtern
    if (newsletter === 'true')  filter.newsletter = true;
    if (newsletter === 'false') filter.newsletter = false;
  }

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









/* ======= UPDATE (vergibt userId falls noch keine existiert) ======= */
async function updateCustomerHandler(req, res) {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;
    const b = req.body || {};

    // 1) Aktuellen Datensatz laden (wir müssen wissen, ob userId fehlt)
    const current = await Customer.findOne({ _id: id, owner }).exec();
    if (!current) return res.status(404).json({ error: 'Customer not found' });

    // 2) Payload aus dem Dialog bauen (deine bisherige Logik)
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

    // 3) Falls KEINE userId vorhanden → jetzt fortlaufende Nummer ziehen
    if (current.userId == null) {
      update.userId = await Customer.nextUserIdForOwner(owner);
    }

    // 4) Update anwenden & zurückgeben
    const doc = await Customer.findOneAndUpdate(
      { _id: id, owner },
      { $set: update },
      { new: true }
    ).lean();

    return res.json(doc);
  } catch (err) {
    console.error('[customers:update] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/* PUT & PATCH auf denselben Handler zeigen lassen */
router.put('/:id', updateCustomerHandler);
router.patch('/:id', updateCustomerHandler);














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

/* ======= Customer-wide cancel (alle Verträge) ======= */
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
          cancellationNo: formatCancellationNo(),
        },
      },
      { new: true }
    ).lean();

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const pdf = await buildCancellationPdf({
      customer,
      booking: {},   // keine einzelne Buchung
      offer: null,
      date: cancelAt,
      reason,
      cancellationNo: customer.cancellationNo,
    });
    await sendCancellationEmail({
      to: customer.parent.email,
      customer,
      booking: {},
      offer: null,
      date: cancelAt,
      reason,
      pdfBuffer: pdf,
    });

    res.json({ ok: true, customer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});





















function requireOwner(req, res) {
  const v = req.get('x-provider-id');
  if (!v || !mongoose.isValidObjectId(v)) {
    res.status(401).json({ ok: false, error: 'Unauthorized: missing/invalid provider' });
    return null;
  }
  return new Types.ObjectId(v);
}

function requireId(req, res) {
  const id = String(req.params.id || '').trim();
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ ok: false, error: 'Invalid id' });
    return null;
  }
  return id;
}


/** Admin: interne Buchung hinzufügen */
router.post('/:id/bookings', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const { offerId, date } = req.body || {};
    if (!offerId || !mongoose.isValidObjectId(offerId)) {
      return res.status(400).json({ error: 'Invalid offerId' });
    }

    const offer = await Offer.findOne({ _id: offerId, owner }).lean();
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // 1) Subdoc im Customer speichern (mit Link auf zentrale Buchung)
    const bookingId = new Types.ObjectId();
    const when = date ? new Date(date) : new Date();

    customer.bookings.push({
      _id: bookingId,
      bookingId, // <--- wichtig
      offerId: offer._id,
      offerTitle: offer.title,
      offerType: offer.sub_type || offer.type || '',
      venue: offer.location || '',
      date: when,
      status: 'active',
      createdAt: new Date(),
      priceAtBooking: (typeof offer.price === 'number') ? offer.price : undefined,
    });

    const bookingSubdoc = customer.bookings.id(bookingId);
    await assignInvoiceData({ booking: bookingSubdoc, offer, providerId: String(owner) });
    await customer.save();

    // 2) Zentrale Buchung in Booking-Collection anlegen
    await Booking.create({
      _id: bookingId,
      source: 'admin_booking',
      owner,
      offerId: offer._id,
      firstName: customer.child?.firstName || 'Vorname',
      lastName:  customer.child?.lastName  || 'Nachname',
      email:     customer.parent?.email     || `noemail+${bookingId}@example.com`,
      age:       customer.child?.birthDate
                   ? Math.max(5, Math.min(19,
                       Math.floor((Date.now() - new Date(customer.child.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
                     ))
                   : 10,
      date:      when.toISOString().slice(0,10), // 'yyyy-mm-dd'
      level:     'U12',
      message:   customer.notes || '',
      status:    'pending',
      priceAtBooking: (typeof offer.price === 'number') ? offer.price : undefined,
      // optional: Rechnungs-Snapshot aus Subdoc übernehmen, falls assignInvoiceData etwas gesetzt hat
      invoiceNumber: bookingSubdoc?.invoiceNumber || undefined,
      invoiceNo:     bookingSubdoc?.invoiceNo     || undefined,
      invoiceDate:   bookingSubdoc?.invoiceDate   || undefined,
    });

    return res.status(201).json({ ok: true, booking: bookingSubdoc.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
});











/* ======= DOCUMENT PDFs (Next proxy ruft POST) ======= */
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

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    booking.offerTitle = booking.offerTitle || offer.title || offer.sub_type || offer.type || '';
    booking.offerType  = booking.offerType  || offer.sub_type || offer.type || '';
    booking.venue      = booking.venue      || offer.location || '';

    const pdf = await buildParticipationPdf({ customer, booking, offer });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Teilnahmebestaetigung.pdf"');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= STORNO: Email mit Storno-PDF ======= */
router.post('/:id/bookings/:bid/email/storno', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const { currency = 'EUR', amount: rawAmount, refInvoiceNo, refInvoiceDate } = req.body || {};
    const amountNum =
      (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === '')
        ? undefined
        : (Number.isFinite(Number(rawAmount)) ? Number(rawAmount) : undefined);

    const customerDoc = await Customer.findOne({ _id: id, owner }).exec();
    if (!customerDoc) return res.status(404).json({ error: 'Customer not found' });

    const booking = customerDoc.bookings.id(bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!customerDoc.parent?.email) {
      return res.status(400).json({ error: 'Customer has no email' });
    }

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    booking.offerTitle = booking.offerTitle || offer.title || offer.sub_type || offer.type || '';
    booking.offerType  = booking.offerType  || offer.sub_type || offer.type || '';
    booking.venue      = booking.venue      || offer.location || '';

    if (!booking.stornoNo) {
      booking.stornoNo = formatStornoNo();
      await customerDoc.save();
    }

    const effectiveRefNo   = (refInvoiceNo && String(refInvoiceNo).trim())
                          || booking.invoiceNumber
                          || booking.invoiceNo
                          || '';
    const effectiveRefDate = refInvoiceDate || booking.invoiceDate || null;

    if (!effectiveRefNo) {
      return res.status(422).json({
        error: 'MISSING_INVOICE',
        message: 'Für diese Stornorechnung fehlt die Referenz auf die Originalrechnung. Bitte zuerst die Teilnahme/Rechnung senden oder refInvoiceNo/refInvoiceDate mitgeben.',
      });
    }

    const customer = customerDoc.toObject ? customerDoc.toObject() : customerDoc;

    const pdf = await buildStornoPdf({
      customer,
      booking,
      offer,
      amount: amountNum,
      currency,
      stornoNo: booking.stornoNo,
      refInvoiceNo:   effectiveRefNo,
      refInvoiceDate: effectiveRefDate,
    });

    await sendStornoEmail({
      to: customer.parent.email,
      customer,
      booking,
      offer,
      pdfBuffer: pdf,
      amount: amountNum,
      currency,
      stornoNo: booking.stornoNo,
      refInvoiceNo:   effectiveRefNo,
      refInvoiceDate: effectiveRefDate,
    });


    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= Confirmation email (invoice/participation) ======= */
router.post('/:id/bookings/:bid/email/confirmation', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const {
      invoiceNo,
      monthlyAmount,
      firstMonthAmount,
      venue,
      invoiceDate,
    } = req.body || {};

    // Kunde laden (nicht lean!)
    let customerDoc = await Customer.findOne({ _id: id, owner }).exec();
    if (!customerDoc) return res.status(404).json({ error: 'Customer not found' });

    // Buchung finden
    let booking = customerDoc.bookings.id(bid)
              || customerDoc.bookings.find(b => String(b?._id) === bid);
    if (!booking) {
      customerDoc = await Customer.findOne({ _id: id, owner }).exec();
      booking = customerDoc?.bookings?.id(bid)
             || customerDoc?.bookings?.find(b => String(b?._id) === bid);
    }
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (!customerDoc.parent?.email) {
      return res.status(400).json({ error: 'Customer has no email' });
    }

    // <— fehlte vorher
    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    const oneOff =
      String(offer.type) === 'PersonalTraining' ||
      String(offer.sub_type || '').toLowerCase() === 'powertraining';

    // Snapshots
    booking.offerTitle = booking.offerTitle || offer.title || offer.sub_type || offer.type || '';
    booking.offerType  = booking.offerType  || offer.sub_type || offer.type || '';
    booking.venue      = booking.venue      || offer.location || '';

    // Preise übernehmen
    let needsSave = false;
    const mAmt = oneOff ? undefined : ((monthlyAmount ?? '') === '' ? undefined : Number(monthlyAmount));
    const fAmt = oneOff ? undefined : ((firstMonthAmount ?? '') === '' ? undefined : Number(firstMonthAmount));

    if (Number.isFinite(mAmt)) { booking.monthlyAmount = mAmt; needsSave = true; }
    if (Number.isFinite(fAmt)) { booking.firstMonthAmount = fAmt; needsSave = true; }

    if (oneOff) {
      booking.monthlyAmount = undefined;
      booking.firstMonthAmount = undefined;
      if (booking.priceAtBooking == null && typeof offer.price === 'number') {
        booking.priceAtBooking = offer.price;
      }
      needsSave = true;
    } else if (booking.monthlyAmount == null && typeof offer.price === 'number') {
      booking.monthlyAmount = offer.price;
      needsSave = true;
    }

    // Rechnungsnummer setzen/generieren
    if (typeof invoiceNo === 'string' && invoiceNo.trim()) {
      if (!booking.invoiceNumber && !booking.invoiceNo) {
        booking.invoiceNumber = invoiceNo.trim();
        booking.invoiceDate   = invoiceDate ? new Date(invoiceDate) : new Date();
        if (booking.priceAtBooking == null && typeof offer.price === 'number') {
          booking.priceAtBooking = offer.price;
        }
        needsSave = true;
      }
    } else if (!booking.invoiceNumber && !booking.invoiceNo) {
      const code = (offer.code || typeCodeFromOffer(offer) || 'INV').toUpperCase();
      const seq  = await nextSequence(`invoice:${code}:${yearFrom()}`);
      booking.invoiceNumber = formatInvoiceShort(code, seq, new Date());
      booking.invoiceDate   = new Date();
      if (booking.priceAtBooking == null && typeof offer.price === 'number') {
        booking.priceAtBooking = offer.price;
      }
      needsSave = true;
    }

    if (needsSave) {
      customerDoc.markModified('bookings');
      await customerDoc.save();
    }

    const effectiveInvoiceNo =
      (typeof invoiceNo === 'string' && invoiceNo.trim())
      || booking.invoiceNumber || booking.invoiceNo || '';

    const effectiveInvoiceDate = invoiceDate || booking.invoiceDate || undefined;

    const customer = customerDoc.toObject ? customerDoc.toObject() : customerDoc;

    // PDF
    let pdf;
    try {
      pdf = await buildParticipationPdf({
        customer,
        booking,
        offer,
        invoiceNo:        effectiveInvoiceNo,
        invoiceDate:      effectiveInvoiceDate,
        venue:            venue || offer?.location,
        monthlyAmount:    booking.monthlyAmount,
        firstMonthAmount: booking.firstMonthAmount,
      });
    } catch (e) {
      console.error('buildParticipationPdf failed:', e);
      return res.status(500).json({ error: 'PDF_BUILD_FAILED', detail: String(e?.message || e) });
    }

    // Mail
    try {
      await sendParticipationEmail({
        to: customer.parent.email,
        customer,
        booking,
        offer: offer || {},
        pdfBuffer: pdf,
        monthlyAmount,
        firstMonthAmount,
      });
    } catch (e) {
      console.error('sendParticipationEmail failed:', e);
      return res.status(502).json({ error: 'MAIL_SEND_FAILED', detail: String(e?.message || e) });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
});

/* ======= DOC: cancellation PDF ======= */
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

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;

    const date = booking.cancelDate || new Date();
    const reason = booking.cancelReason || '';

    if (!booking.invoiceNumber && !booking.invoiceNo && offer) {
      const code = (offer.code || typeCodeFromOffer(offer) || 'INV').toUpperCase();
      const seq  = await nextSequence(`invoice:${code}:${yearFrom(booking.date || new Date())}`);
      booking.invoiceNumber = formatInvoiceShort(code, seq, booking.date || new Date());
      booking.invoiceDate   = booking.date || new Date();
      // lean → kein save() hier
    }

    // router.post('/:id/bookings/:bid/documents/cancellation', …)




// router.post('/:id/bookings/:bid/documents/cancellation', …)
const endAt =
  req.body?.endDate ? new Date(req.body.endDate) :
  (booking.endDate || null);

if (endAt && !booking.endDate) {
  booking.endDate = endAt; // lean – kein save nötig
}


    const referenceInvoice = {
      number: booking.invoiceNumber || booking.invoiceNo || '',
      date:   booking.invoiceDate || null,
    };

    const pdf = await buildCancellationPdf({
      customer,
      booking,
      offer,
       endDate: endAt || booking.endDate || null,  // << wichtig
      date,
      reason,
      cancellationNo: booking.cancellationNo || undefined,
      refInvoiceNo: referenceInvoice.number,
      refInvoiceDate: referenceInvoice.date,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Kuendigungsbestaetigung.pdf"');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});




















/* ======= DOC: storno PDF ======= */
router.post('/:id/bookings/:bid/documents/storno', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const { currency = 'EUR' } = req.body || {};
    const rawAmount = req.body?.amount;
    const amountNum =
      (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === '')
        ? undefined
        : (Number.isFinite(Number(rawAmount)) ? Number(rawAmount) : undefined);

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = (customer.bookings || []).find(b => String(b._id) === bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    if (!booking.invoiceNumber && !booking.invoiceNo) {
      const code = (offer.code || typeCodeFromOffer(offer) || 'INV').toUpperCase();
      const seq  = await nextSequence(`invoice:${code}:${yearFrom(booking.date || new Date())}`);
      booking.invoiceNumber = formatInvoiceShort(code, seq, booking.date || new Date());
      booking.invoiceDate   = booking.date || new Date();
      // lean → kein save() hier
    }

    const referenceInvoice = {
      number: booking.invoiceNumber || booking.invoiceNo || '',
      date:   booking.invoiceDate || null,
    };

    const pdf = await buildStornoPdf({
      customer,
      booking,
      offer,
      amount: amountNum,
      currency,
      stornoNo: booking.stornoNo || undefined,
      refInvoiceNo: referenceInvoice.number,
      refInvoiceDate: referenceInvoice.date,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Storno-Rechnung.pdf"');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======= STORNO: Markiere Buchung cancelled (kein Email) ======= */
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

    // zusätzlich: zentrale Booking-Collection updaten
await Booking.findByIdAndUpdate(
  booking._id,
  {
    $set: {
      status: 'storno',
      stornoNo: booking.stornoNo || formatStornoNo(),
      stornoDate: new Date(),
      stornoAmount: req.body?.amount ? Number(req.body.amount) : undefined,
    },
  },
  { new: true }
);


    return res.json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});




// routes/customers.js (Ausschnitt)
router.post('/:id/bookings/:bid/cancel', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;
    const bid = String(req.params.bid || '').trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: 'Invalid booking id' });
    }

    const { date, reason, endDate } = req.body || {};
    const cancelAt = date ? new Date(date) : new Date();
    const endAt    = endDate ? new Date(endDate) : null;

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const booking = customer.bookings.id(bid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const offer = booking.offerId ? await Offer.findById(booking.offerId).lean() : null;
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    if (!isCancelAllowed(offer)) {
      return res.status(400).json({ error: 'This offer cannot be cancelled' });
    }

    booking.status = 'cancelled';
    booking.cancelDate = cancelAt;
    booking.cancelReason = String(reason || '');
    if (endAt) booking.endDate = endAt;

    if (!booking.cancellationNo) {
      booking.cancellationNo = formatCancellationNo();
    }

    if (!booking.invoiceNumber && !booking.invoiceNo) {
      const code = (offer.code || typeCodeFromOffer(offer) || 'INV').toUpperCase();
      const seq  = await nextSequence(`invoice:${code}:${yearFrom(booking.date || new Date())}`);
      booking.invoiceNumber = formatInvoiceShort(code, seq, booking.date || new Date());
      booking.invoiceDate   = booking.date || new Date();
      await customer.save();
    }

    booking.offerTitle = booking.offerTitle || offer.title || offer.sub_type || offer.type || '';
    booking.offerType  = booking.offerType  || offer.sub_type || offer.type || '';
    booking.venue      = booking.venue      || offer.location || '';

    await customer.save();

    if (customer.parent?.email) {
      const referenceInvoice = {
        number: booking.invoiceNumber || booking.invoiceNo || '',
        date:   booking.invoiceDate || null,
      };

      const pdf = await buildCancellationPdf({
        customer: customer.toObject?.() || customer,
        booking,
        offer,
        date: cancelAt,
        endDate: booking.endDate || endAt || null,
        reason,
        cancellationNo: booking.cancellationNo,
        refInvoiceNo: referenceInvoice.number,
        refInvoiceDate: referenceInvoice.date,
      });

      // zusätzlich: zentrale Booking-Collection updaten
await Booking.findByIdAndUpdate(
  booking._id,
  {
    $set: {
      status: 'cancelled',
      cancellationNo: booking.cancellationNo,
      cancellationDate: booking.cancelDate,
      cancellationReason: booking.cancelReason,
    },
  },
  { new: true }
);


      await sendCancellationEmail({
        to: customer.parent.email,
        customer: customer.toObject?.() || customer,
        booking,
        offer,
        date: cancelAt,
        endDate: booking.endDate || endAt || null,
        reason,
        pdfBuffer: pdf,
        refInvoiceNo: referenceInvoice.number,
        refInvoiceDate: referenceInvoice.date,
      });
    }

    res.json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
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






/** GET /api/customers/:id/documents */
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
        // Kündigungsbestätigung nur, wenn es eine echte Kündigung war (Nummer vorhanden)
        if (b.cancellationNo) {
          docs.push({
            id: `${bid}:cancellation`,
            type: 'cancellation',
            title: `Kündigungsbestätigung – ${baseTitle}`,
            issuedAt: issued,
            href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/cancellation`,
            ...common,
          });
        }
        // Storno-Rechnung bei allen stornierten Buchungen
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

    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
















/* ======= CSV Export (Kunde → identisch zu globalem CSV) ======= */
router.get('/:id/documents.csv', async (req, res) => {
  try {
    // alle Treffer (Client filtert vorher)
    req.query.page = '1';
    req.query.limit = '1000000';

    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

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

    const offerIds = [...new Set(
      (customer.bookings || [])
        .map(b => String(b.offerId || ''))
        .filter(v => v && mongoose.isValidObjectId(v))
    )];

    const offers = offerIds.length
      ? await Offer.find({ _id: { $in: offerIds }}).select('_id title type sub_type location price').lean()
      : [];
    const offerById = new Map(offers.map(o => [String(o._id), o]));

    // ---- Brand / Firma (wie in pdfHtml.getBrand) ----
    const BRAND_COMPANY = process.env.BRAND_COMPANY     || 'Münchner Fussballschule NRW';
    const BRAND_ADDR1   = process.env.BRAND_ADDR_LINE1  || 'Hochfelder Str. 33';
    const BRAND_ADDR2   = process.env.BRAND_ADDR_LINE2  || '47226 Duisburg';
    const BRAND_EMAIL   = process.env.BRAND_EMAIL       || 'info@muenchner-fussball-schule.ruhr';
    const BRAND_WEBSITE = process.env.BRAND_WEBSITE_URL || 'https://www.muenchner-fussball-schule.ruhr';
    const BRAND_IBAN    = process.env.BRAND_IBAN        || 'DE13350400380595090200';
    const BRAND_BIC     = process.env.BRAND_BIC         || 'COBADEFFXXX';
    const BRAND_TAXID   = process.env.BRAND_TAXID       || '';

    // addr2 ("47226 Duisburg") in PLZ + Ort aufsplitten
    let BRAND_ZIP = '', BRAND_CITY = '';
    if (BRAND_ADDR2) {
      const m = String(BRAND_ADDR2).match(/^(\d{4,5})\s+(.*)$/);
      BRAND_ZIP = m ? m[1] : '';
      BRAND_CITY = m ? m[2] : BRAND_ADDR2;
    }

    const VAT_NOTE = process.env.CSV_VAT_NOTE || 'USt-befreit gem. § 19 UStG';

    // ---- Dokuliste wie JSON/ZIP zusammenstellen ----
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

        // Kündigungsbestätigung (immer aufnehmen – ref/num ggf. leer)
        docs.push({
          id: `${bid}:cancellation`,
          type: 'cancellation',
          title: `Kündigungsbestätigung – ${baseTitle}`,
          issuedAt: issued,
          href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/cancellation`,
          ...common,
        });

        // Storno-Rechnung
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

    // ---- CSV Writer ----
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customer-${id}-documents.csv"`);

    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const fmtDEDate = (value) => {
      if (!value) return '';
      const d = new Date(value);
      if (isNaN(d.getTime())) return '';
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
      }).format(d);
    };

    // ⚙️ Header: identisch zum globalen (Basis + erweiterte Spalten)
    const headers = [
      // Basis
      'id','bookingId','type','title','issuedAt','status',
      'offerTitle','offerType','venue','price','currency','href',
      'invoiceNo','invoiceDate','refInvoiceNo','refInvoiceDate',
      'cancellationNo','stornoNo','stornoAmount',
      // Erweiterung (global)
      'brandCompany','brandAddrStreet','brandAddrZip','brandAddrCity','brandCountry',
      'docTitle','quantity','unitNet','vatRate','vatAmount','totalAmount',
      'iban','bic','taxId','brandEmail','brandWebsite','vatNote'
    ];
    res.write(headers.join(',') + '\n');


    for (const d of filtered) {
  const b = (customer.bookings || []).find(x => String(x._id) === d.bookingId) || {};
  const offer = (b.offerId && offerById.get(String(b.offerId))) || null;

  const offerTitle = b.offerTitle || offer?.title || '';
  const offerType  = b.offerType  || offer?.sub_type || offer?.type || '';
  const venue      = b.venue      || offer?.location || '';

  const isPart   = d.type === 'participation';
  const isCanc   = d.type === 'cancellation';
  const isStorno = d.type === 'storno';

  // Basispreis (nur für storno relevant; participation = leer)
  let basePrice = 0;
  if (isStorno) {
    basePrice =
      (typeof b.stornoAmount === 'number') ? b.stornoAmount
      : (typeof offer?.price === 'number') ? offer.price
      : 0;
  } else if (isPart) {
    basePrice = 0; // für Summenspalten unten
  }

  // Rechnungs-/Referenzdaten
  const invoiceNo   = normalizeInvoiceNo(b.invoiceNumber || b.invoiceNo || '');
  const invoiceDate = b.invoiceDate || null;

  // 🔁 WICHTIG: bei participation Ref-Felder LEER lassen (wie global)
  const refNo    = isPart ? '' : normalizeInvoiceNo(b.refInvoiceNo || b.invoiceNumber || b.invoiceNo || '');
  const refDate  = isPart ? null : (b.refInvoiceDate || b.invoiceDate || null);

  const cancellationNo = isCanc   ? (b.cancellationNo || b.cancellationNumber || '') : '';
  const stornoNo       = isStorno ? (b.stornoNo || b.stornoNumber || '')             : '';
  const stornoAmount   = isStorno
    ? (typeof b.stornoAmount === 'number' ? b.stornoAmount
       : (typeof basePrice === 'number' ? basePrice : ''))
    : '';

  // „globale“ Zusatzfelder
  const qty       = 1;
  const unitNet   = isPart ? 0 : (Math.round(Number(basePrice || 0) * 100) / 100);
  const vatRate   = 0;
  const vatAmount = 0;
  const totalAmt  = unitNet + vatAmount;

  // 💡 Preis-Spalte im globalen CSV ist bei participation LEER
  const priceForCsv = isPart ? '' : (typeof basePrice === 'number' ? basePrice : '');

  const row = [
    // Basis
    d.id,
    d.bookingId,
    d.type,
    d.title,
    fmtDEDate(d.issuedAt),
    d.status || '',
    offerTitle || '',
    offerType || '',
    venue || '',
    priceForCsv,           // << hier leer bei participation
    'EUR',
    d.href || '',
    invoiceNo || '',
    fmtDEDate(invoiceDate),
    refNo || '',           // << leer bei participation
    fmtDEDate(refDate),    // << leer bei participation
    cancellationNo || '',
    stornoNo || '',
    stornoAmount,
    // Erweiterung (global) – sorge dafür, dass ENV/Defaults dem globalen CSV entsprechen
    (process.env.BRAND_COMPANY     || 'Münchner Fussballschule NRW'),
    (process.env.BRAND_ADDR_LINE1  || 'Hochfelder Str.33'),
    BRAND_ZIP,
    BRAND_CITY,
    '', // brandCountry: global lässt es leer
    d.title,
    qty,
    unitNet.toFixed(2),    // 0.00 bei participation
    vatRate,
    vatAmount.toFixed(2),  // 0.00
    totalAmt.toFixed(2),   // 0.00 bei participation
    BRAND_IBAN,
    BRAND_BIC,
    BRAND_TAXID,
    BRAND_EMAIL,
    BRAND_WEBSITE,
    VAT_NOTE,
  ].map(esc).join(',');

  res.write(row + '\n');
}




    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});





/* ======= ZIP (PDFs als ZIP, Filter wie JSON/CSV) ======= */
async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const my = idx++;
      if (my >= items.length) break;
      await worker(items[my], my);
    }
  });
  await Promise.all(runners);
}

router.get('/:id/documents.zip', async (req, res) => {
  try {
    const owner = requireOwner(req, res); if (!owner) return;
    const id = requireId(req, res); if (!id) return;

    const typeParam = String(req.query.type || '').trim();
    const typeSet = new Set(typeParam ? typeParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : []);
    const from = parseDate(req.query.from);
    const to   = parseDate(req.query.to);
    const q    = String(req.query.q || '').trim();

    const sortStr = String(req.query.sort || 'issuedAt:desc');
    const [sortField, sortDir] = sortStr.split(':');
    const sortKey = (sortField || 'issuedAt');
    const sortMul = (sortDir === 'asc' ? 1 : -1);

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

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
        if (b.cancellationNo) {
          docs.push({
            id: `${bid}:cancellation`,
            type: 'cancellation',
            title: `Kündigungsbestätigung – ${baseTitle}`,
            issuedAt: issued,
            href: `/api/admin/customers/${customer._id}/bookings/${bid}/documents/cancellation`,
            ...common,
          });
        }
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

    docs = docs.filter(d => docMatchesType(d, typeSet) && docMatchesQuery(d, q));
    if (from) docs = docs.filter(d => new Date(d.issuedAt) >= from);
    if (to)   docs = docs.filter(d => new Date(d.issuedAt) <= to);

    docs.sort((a, b) => {
      const av = new Date(a[sortKey] || 0).getTime();
      const bv = new Date(b[sortKey] || 0).getTime();
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * sortMul;
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="customer-${id}-documents.zip"`);

    const archive = archiver('zip', { zlib: { level: 3 } });
    archive.on('error', (err) => {
      console.error(err);
      try { res.status(500).end(); } catch {}
    });
    archive.pipe(res);

    const safe = (s) => String(s || '').replace(/[^\w.\- äöüÄÖÜß]/g, '_').slice(0, 120);

    function fmtISO(v) {
      if (!v) return 'undated';
      const d = new Date(v);
      return isNaN(d.getTime()) ? 'undated' : d.toISOString().slice(0, 10);
    }
    const LABELS = {
      participation: 'Teilnahmebestätigung',
      cancellation:  'Kündigungsbestätigung',
      storno:        'Storno-Rechnung',
    };

    async function processDoc(d) {
      const booking = (customer.bookings || []).find(b => String(b._id) === d.bookingId);
      if (!booking) return;

      let offer = null;
      if (booking.offerId) {
        try { offer = await Offer.findById(booking.offerId).lean(); } catch {}
      }

      const snap = { ...booking };
      if (offer) {
        snap.offerTitle = snap.offerTitle || offer.title || '';
        snap.offerType  = snap.offerType  || offer.sub_type || offer.type || '';
        snap.venue      = snap.venue      || offer.location || '';
      }

      const refNo   = normalizeInvoiceNo(
        snap.refInvoiceNo || snap.invoiceNumber || snap.invoiceNo || ''
      );
      const refDate = snap.refInvoiceDate || snap.invoiceDate || null;

      function pickDocNoFor(type, s) {
        if (type === 'participation') {
          return normalizeInvoiceNo(s.invoiceNumber || s.invoiceNo || '');
        }
        if (type === 'cancellation') {
          return normalizeInvoiceNo(s.cancellationNo || '');
        }
        if (type === 'storno') {
          const stor = normalizeInvoiceNo(s.stornoNo || '');
          if (stor) return stor;
          const ref = normalizeInvoiceNo(s.refInvoiceNo || s.invoiceNumber || s.invoiceNo || '');
          return ref ? `REF-${ref}` : '';
        }
        return '';
      }

      let buf;
      if (d.type === 'participation') {
        buf = await buildParticipationPdf({
          customer,
          booking: snap,
          offer,
        });
      } else if (d.type === 'cancellation') {
        const date = snap.cancelDate || new Date();
        const reason = snap.cancelReason || '';
        buf = await buildCancellationPdf({
          customer,
          booking: snap,
          offer,
          date,
          endDate: snap.endDate || null, 
          reason,
          cancellationNo : snap.cancellationNo || undefined,
          refInvoiceNo   : refNo || undefined,
          refInvoiceDate : refDate || undefined,
        });
      } else if (d.type === 'storno') {
        const amount = (offer && typeof offer.price === 'number') ? offer.price : 0;
        buf = await buildStornoPdf({
          customer,
          booking: snap,
          offer,
          amount,
          currency       : 'EUR',
          stornoNo       : snap.stornoNo || undefined,
          refInvoiceNo   : refNo || undefined,
          refInvoiceDate : refDate || undefined,
        });
      } else {
        return;
      }

      const dateStr = fmtISO(d.issuedAt);
      const label   = LABELS[d.type] || d.type;
      const docNo   = pickDocNoFor(d.type, snap);
      const title   = snap.offerTitle || snap.offerType || 'Angebot';

      const parts = [dateStr, label];
      if (docNo) parts.push(docNo);
      parts.push(title);

      const filename = parts.join(' - ');
      const name = safe(filename) + '.pdf';
      archive.append(buf, { name });
    }

    await runWithConcurrency(docs, 3, processDoc);
    await archive.finalize();
  } catch (err) {
    console.error(err);
    try { res.status(500).json({ error: 'Server error' }); } catch {}
  }
});












router.patch('/:id/newsletter', async (req, res) => {
  try {
    const { id } = req.params;
    const want = !!req.body?.newsletter;

    const providerId =
      req.headers['x-provider-id'] ||
      req.user?.providerId || null;

    const filter = providerId ? { _id: id, providerId } : { _id: id };
    const doc = await Customer.findOne(filter);
    if (!doc) return res.status(404).json({ ok: false, error: 'Customer not found' });

 
     doc.newsletter = want;
   if (want && !doc.marketingConsentAt) {
     doc.marketingConsentAt = new Date();
   }

    const r = await syncCustomerNewsletter(doc, want, { mutate: true });
    if (r?.ok === false) {
      return res.status(400).json({ ok: false, error: r.error || 'Sync failed' });
    }


     //if (!doc.marketingLastSyncedAt) doc.marketingLastSyncedAt = new Date();

    
    await doc.save();
   
    const fresh = await Customer.findById(doc._id).lean();
     res.json({ ok: true, customer: fresh });
  } catch (err) {
    console.error('PATCH /customers/:id/newsletter failed:', err);
    res.status(500).json({ ok: false, error: 'Newsletter update failed' });
  }
});





module.exports = router;
