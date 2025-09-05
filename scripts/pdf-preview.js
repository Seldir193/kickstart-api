
// scripts/pdf-preview.js
// Beispiele:
//   node scripts/pdf-preview.js storno --cid 68b5b421a86f160c7bc41b25 --bid 689f1f26eecf0ccc26f1706d --amount 39 --currency EUR
//   node scripts/pdf-preview.js cancellation --cid 68b5b421a86f160c7bc41b25 --bid 689f1f26eecf0ccc26f1706d --html --watch
//   node scripts/pdf-preview.js participation --cid 68b5b421a86f160c7bc41b25 --bid 689f1f26eecf0ccc26f1706d
//
// Flags:
//   --cid <customerId>   : _id des Customers
//   --bid <bookingId>    : _id der Buchung (entweder eingebettet oder separate Collection)
//   --db  <name>         : DB-Name, falls in MONGO_URI keiner steht
//   --amount <num>       : Betrag (nur Storno; wenn weggelassen, wird offer.price genommen, falls vorhanden)
//   --currency <EUR>     : Währung (default EUR)
//   --reason <text>      : Kündigungsgrund (für cancellation)
//   --date <YYYY-MM-DD>  : Kündigungsdatum Override (für cancellation)
//   --html               : HTML statt PDF (schnelle Browservorschau)
//   --watch              : Live-Neuaufbau bei Template/CSS-Änderungen
//   --out <pfad>         : Ausgabedatei (Standard: tmp/preview-<type>.pdf|html)

'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { MongoClient, ObjectId } = require('mongodb');
const Handlebars = require('handlebars');

const {
  buildStornoPdfHTML,
  buildCancellationPdfHTML,
  buildParticipationPdfHTML,
} = require('../utils/pdfHtml');

/* ---------- Pfade ---------- */
const rootDir = path.resolve(__dirname, '..');
const tplDir  = path.resolve(rootDir, 'templates', 'pdf');
const outDir  = path.resolve(rootDir, 'tmp');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

/* ---------- CLI ---------- */
const args = process.argv.slice(2);
const type = (args[0] || '').trim(); // storno | cancellation | participation

function argVal(flag, def = undefined) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const htmlOnly   = args.includes('--html');
const watch      = args.includes('--watch');
const outPath    = argVal('--out', null);
const dbNameArg  = argVal('--db', null);
const cidArg     = argVal('--cid', null);
const bidArg     = argVal('--bid', null);
const amountArg  = argVal('--amount', null);
const currencyArg= argVal('--currency', null);
const reasonArg  = argVal('--reason', null);
const dateArg    = argVal('--date', null); // YYYY-MM-DD

/* ---------- Helpers ---------- */
function readFileSafe(p){ try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

async function renderHtmlOnly(tplName, data) {
  const hbsPath = path.resolve(tplDir, `${tplName}.hbs`);
  let html = readFileSafe(hbsPath);
  if (!html) throw new Error(`Template fehlt: ${path.relative(rootDir, hbsPath)}`);
  const baseCss = readFileSafe(path.resolve(tplDir, '_base.css')) || '';
  html = html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']\.\/_base\.css["'][^>]*>/i,
    `<style>\n${baseCss}\n</style>`
  );
  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(data);
}

function asDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ---------- DB ---------- */
async function fetchFromDb({ cid, bid, mUri, dbName }) {
  const uri = mUri || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI fehlt (.env)');

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = dbName ? client.db(dbName) : client.db();

    const Customers = db.collection('customers');
    const Bookings  = db.collection('bookings'); // falls vorhanden
    const Offers    = db.collection('offers');   // falls vorhanden

    const _cid = new ObjectId(cid);
    const customer = await Customers.findOne({ _id: _cid });

    if (!customer) throw new Error('Customer nicht gefunden');

    let booking = null;

    // 1) Versuch: separate bookings-Collection
    if (bid) {
      try {
        booking = await Bookings.findOne({ _id: new ObjectId(bid) });
      } catch { /* ignore if collection not exists */ }
    }

    // 2) Fallback: eingebettet in customer.bookings
    if (!booking && customer?.bookings?.length) {
      const found = customer.bookings.find(b => String(b._id) === String(bid));
      if (found) booking = found;
    }

    // 3) kein bid angegeben → nimm neueste eingebettete Buchung (falls vorhanden)
    if (!booking && !bid && customer?.bookings?.length) {
      booking = customer.bookings[customer.bookings.length - 1];
    }

    if (!booking) {
      throw new Error('Booking nicht gefunden (weder in Collection noch eingebettet)');
    }

    // Offer ermitteln (viele mögliche Namen abdecken)
    let offer = null;
    const offerId = booking.offerId || booking.offer_id || booking.offer || booking.offerRef;
    if (offerId) {
      try {
        offer = await Offers.findOne({ _id: new ObjectId(String(offerId)) });
      } catch { /* ignore */ }
    }

    return { customer, booking, offer };
  } finally {
    await client.close();
  }
}

/* ---------- Mapping auf Template-Form ---------- */
function shapeData({ customer, booking, offer }) {
  // Eltern/Kinder/Adresse (deine Collection hat parent/child/address als Objekte)
  const parent = customer?.parent || {};
  const child  = customer?.child  || {};
  const addr   = customer?.address|| {};

  // Booking-Felder: Cover beide Varianten (separate "booking" Collection vs. eingebettet)
  // Separate Booking (dein Beispiel):
  //   {
  //     _id, firstName, lastName, email, age, date, level, message,
  //     confirmationCode, confirmedAt, status, adminNote, ...
  //   }
  // Eingebettet in Customer:
  //   {
  //     _id, cancellationDate, cancellationReason, canceledAt, createdAt, status, ...
  //     evtl. offerId / offerType / venue / date ...
  //   }
  const offerTitle = (
    booking.offerTitle
    || offer?.title
    || (offer?.type && offer?.location ? `${offer.type} • ${offer.location}` : '')
    || booking.program
    || booking.level
    || ''
  );

  const offerType = (
    booking.offerType
    || offer?.type
    || booking.level
    || ''
  );

  const venue = (
    booking.venue
    || booking.location
    || offer?.location
    || ''
  );

  const cancelDate =
    booking.cancellationDate
    || booking.cancelDate
    || booking.canceledAt
    || null;

  // Fallbacks für Datum/Status
  const date = booking.date || booking.day || booking.createdAt || null;
  const status = booking.status || 'active';

  // Amount/Currency werden vom Aufrufer gesetzt (oder per CLI)
  return {
    customer: {
      userId: String(customer?.userId ?? customer?._id ?? ''),
      parent: {
        salutation: parent.salutation || parent.anrede || '',
        firstName : parent.firstName  || parent.vorname || '',
        lastName  : parent.lastName   || parent.nachname || '',
      },
      child: {
        firstName: child.firstName || child.vorname || booking.firstName || '',
        lastName : child.lastName  || child.nachname || booking.lastName  || '',
      },
      address: {
        street : addr.street || addr.strasse || '',
        houseNo: addr.houseNo || addr.hausnr || '',
        zip    : addr.zip || addr.plz || '',
        city   : addr.city || addr.ort || '',
      },
    },
    booking: {
      _id       : booking._id,
      offerTitle,
      offerType,
      venue,
      date     : date ? String(date).slice(0, 10) : '',
      status,
      cancelDate: cancelDate ? String(cancelDate).slice(0, 10) : '',
    },
  };
}

/* ---------- Build ---------- */
async function buildOnce(kind, data, useHtml, customOutPath) {
  const baseOut = customOutPath
    ? customOutPath.replace(/\.pdf$|\.html$/i, '')
    : path.join(outDir, `preview-${kind}`);

  if (useHtml) {
    const html = await renderHtmlOnly(kind, data);
    const out = `${baseOut}.html`;
    fs.writeFileSync(out, html, 'utf8');
    console.log('HTML geschrieben:', path.relative(process.cwd(), out));
    return;
  }

  let buf;
  if (kind === 'storno') {
    buf = await buildStornoPdfHTML({
      customer: data.customer,
      booking : data.booking,
      amount  : data.amount ?? 0,
      currency: data.currency || 'EUR',
    });
  } else if (kind === 'cancellation') {
    buf = await buildCancellationPdfHTML({
      customer: data.customer,
      booking : data.booking,
      date    : data.details?.cancelDate || data.booking?.cancelDate,
      reason  : data.details?.reason || '',
    });
  } else if (kind === 'participation') {
    buf = await buildParticipationPdfHTML({
      customer: data.customer,
      booking : data.booking,
    });
  } else {
    throw new Error(`Unbekannter Typ: ${kind} (erlaubt: storno | cancellation | participation)`);
  }

  const out = `${baseOut}.pdf`;
  fs.writeFileSync(out, buf);
  console.log('PDF geschrieben:', path.relative(process.cwd(), out));
}

/* ---------- Main ---------- */
(async function main() {
  if (!['storno', 'cancellation', 'participation'].includes(type)) {
    console.error('Bitte Typ angeben: storno | cancellation | participation');
    process.exit(1);
  }

  const cid = cidArg;
  const bid = bidArg;
  if (!cid) {
    console.error('Bitte --cid <CustomerId> angeben (echte Mongo-ID, ohne < >).');
    process.exit(1);
  }

  // DB lesen
  const { customer, booking, offer } = await fetchFromDb({
    cid, bid,
    mUri: process.env.MONGO_URI,
    dbName: dbNameArg || undefined,
  });

  // Mappen
  const shaped = shapeData({ customer, booking, offer });

  // CLI-Overrides
  const data = {
    ...shaped,
    amount  : (amountArg != null) ? Number(amountArg) : (offer?.price ?? 0), // Storno: nimm offer.price als default
    currency: currencyArg || 'EUR',
  };
  if (type === 'cancellation') {
    data.details = data.details || {};
    if (reasonArg) data.details.reason = reasonArg;
    if (dateArg)   data.details.cancelDate = asDate(dateArg);
  }

  // Build
  await buildOnce(type, data, htmlOnly, outPath || undefined);

  // Watch Templates/CSS
  if (watch) {
    const watchList = [
      path.resolve(tplDir, `${type}.hbs`),
      path.resolve(tplDir, '_base.css'),
    ];
    console.log('Watching:', watchList.map(p => path.relative(process.cwd(), p)).join(', '));
    chokidar.watch(watchList, { ignoreInitial: true }).on('all', async () => {
      try {
        await buildOnce(type, data, htmlOnly, outPath || undefined);
      } catch (e) {
        console.error('Fehler beim Neu-Rendern:', e.message);
      }
    });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});














