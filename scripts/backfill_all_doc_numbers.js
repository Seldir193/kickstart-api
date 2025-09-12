// scripts/backfill_all_doc_numbers.js
require('dotenv').config();
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Offer    = require('../models/Offer');

const {
  nextSequence,
  yearFrom,
  typeCodeFromOfferType,
  formatInvoiceShort,
  formatCancellationNo,
  formatStornoNo,
} = require('../utils/sequences');

const { normalizeInvoiceNo } = require('../utils/pdfData');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI fehlt');
  const DRY = !!process.env.DRY_RUN;

  await mongoose.connect(uri);
  console.log(`✅ MongoDB verbunden${DRY ? ' (DRY-RUN: keine Writes)' : ''}`);

  // kleiner Offer-Cache, um DB-Calls zu sparen
  const offerCache = new Map();
  async function getOffer(offerId) {
    if (!offerId) return null;
    const key = String(offerId);
    if (offerCache.has(key)) return offerCache.get(key);
    const o = await Offer.findById(key).select('type location code').lean();
    offerCache.set(key, o || null);
    return o || null;
  }

  const cursor = Customer.find({ 'bookings.0': { $exists: true } }).cursor();

  let customersScanned = 0;
  let bookingsScanned  = 0;
  let bookingsUpdated  = 0;

  for await (const customer of cursor) {
    customersScanned++;
    let changed = false;

    for (const b of customer.bookings || []) {
      bookingsScanned++;
      let bChanged = false;

      // --- Offer-Daten für Typ/Code/Jahr ---
      const offer = await getOffer(b.offerId);
      const code  = (offer?.code || typeCodeFromOfferType(offer?.type || '') || 'INV').toUpperCase();

      // --- Participation / Rechnung ---
      const hasInvoiceNo   = !!(b.invoiceNumber || b.invoiceNo);
      const hasInvoiceDate = !!b.invoiceDate;

      if (!hasInvoiceNo) {
        // wir generieren nur, wenn wenigstens irgendein Datum da ist (Start/createdAt) – sonst heute
        const when = b.invoiceDate || b.date || b.createdAt || new Date();
        const seqKey = `invoice:${code}:${yearFrom(when)}`;
        const seq = await nextSequence(seqKey);
        b.invoiceNumber = normalizeInvoiceNo(formatInvoiceShort(code, seq, when));
        if (!hasInvoiceDate) b.invoiceDate = new Date(when);
        bChanged = true;
      } else if (!hasInvoiceDate) {
        // wenn Nummer existiert, aber kein Datum – setze createdAt/Start oder heute
        b.invoiceDate = new Date(b.date || b.createdAt || Date.now());
        bChanged = true;
      }

      // --- Cancellation ---
      const hasCancNo   = !!(b.cancellationNumber || b.cancellationNo);
      const hasCancDate = !!b.cancellationDate || !!b.cancelDate;

      if (hasCancDate && !hasCancNo) {
        b.cancellationNumber = formatCancellationNo();
        bChanged = true;
      }

      // --- Storno ---
      const hasStornoNo   = !!(b.stornoNumber || b.stornoNo);
      const hasStornoDate = !!b.stornoDate;

      if (hasStornoDate && !hasStornoNo) {
        b.stornoNumber = formatStornoNo();
        bChanged = true;
      }

      if (bChanged) {
        bookingsUpdated++;
        changed = true;
      }
    }

    if (changed && !DRY) {
      customer.markModified('bookings');
      await customer.save(); // nur Customer (embedded) – kein Booking.save()
    }
  }

  console.log(`Customers: ${customersScanned}, Bookings scanned: ${bookingsScanned}, updated: ${bookingsUpdated}`);
  await mongoose.disconnect();
  console.log('✔️  Fertig.');
})().catch(e => { console.error('❌ Fehler:', e.message); process.exit(1); });
