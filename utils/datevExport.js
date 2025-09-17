// utils/datevExport.js
'use strict';

const archiver = require('archiver');
const { normalizeInvoiceNo } = require('./pdfData');
const { buildParticipationPdf, buildStornoPdf } = require('./pdf');

/* ========================= Einstellungen / ENV ========================= */
/** Firmenname in EXTF-Header */
const BRAND_NAME =
  process.env.DATEV_COMPANY_NAME ||
  process.env.BRAND_COMPANY ||
  'Muenchner Fussballschule NRW';

/** OPOS-Konten (Forderungen / Erlöse §19) */
const AR_ACCOUNT   = String(
  process.env.DATEV_AR_ACCOUNT ||
  process.env.DATEV_KTO_BANK ||      // Back-Compat (früher fälschlich „BANK“)
  '10000'
);
const REV_ACCOUNT  = String(
  process.env.DATEV_REVENUE_ACCOUNT ||
  process.env.DATEV_KTO_ERLOES ||    // Back-Compat
  '8195'                              // typ. §19 Kleinunternehmer-Erlöse
);

/** BU-Schlüssel (meist 0 bei §19) */
const BU_KEY       = String(process.env.DATEV_BU_SCHLUESSEL || '0');

/** Belege-Ordnername im ZIP */
const BELEG_DIR    = process.env.DATEV_BELEG_DIR || 'belege';

/** Dateinamensschema für Belege */
const NAME_SCHEME  = process.env.DATEV_BELEG_NAME_SCHEME || '{date}_{no}_{type}.pdf';

/** Währung */
const CURRENCY     = (process.env.DATEV_CURRENCY || 'EUR').toUpperCase();

/* ================================ Utils ================================ */
function pad2(n){ return String(n).padStart(2,'0'); }
function fmtDDMMYYYY(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return pad2(dt.getDate()) + pad2(dt.getMonth()+1) + String(dt.getFullYear());
}
function fmtYYYYMMDD(d){
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return String(dt.getFullYear()) + '-' + pad2(dt.getMonth()+1) + '-' + pad2(dt.getDate());
}
function toDEAmount(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return v.toFixed(2).replace('.', ',');
}

/** Kursname ohne Ort/Adresse */
function courseOnly(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];
  const commaDigit = s.search(/,\s*\d/);
  if (commaDigit > 0) s = s.slice(0, commaDigit);
  const dashAddr = s.search(/\s-\s*\d/);
  if (dashAddr > 0) s = s.slice(0, dashAddr);
  return s.trim();
}

function safeName(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileNameFrom({ date, no, type }) {
  const map = {
    '{date}': fmtYYYYMMDD(date),
    '{no}'  : safeName(no),
    '{type}': type,
  };
  let name = NAME_SCHEME;
  for (const k of Object.keys(map)) name = name.replace(k, map[k]);
  return safeName(name || `${fmtYYYYMMDD(date)}_${no}_${type}.pdf`);
}

function extfHeader() {
  const now = new Date();
  const ts = now.getFullYear().toString()
    + pad2(now.getMonth()+1) + pad2(now.getDate())
    + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds()) + '000';
  return `EXTF;700;21;Buchungsstapel;13;${ts};;${BRAND_NAME};1;${CURRENCY}`;
}

function readableHeaderRow() {
  return [
    'Umsatz','SH','WKZ','Konto','Gegenkonto','BU','Belegdatum','Belegnummer','Buchungstext','Beleglink'
  ].join(';');
}

function extfRow({ amount, sh, currency=CURRENCY, konto, gkto, bu, belegDatum, belegNr, text, belegLink }) {
  return [
    toDEAmount(amount),
    sh,
    currency,
    konto,
    gkto,
    bu,
    belegDatum,
    belegNr,
    text,
    belegLink
  ].map(v => (v == null ? '' : String(v))).join(';');
}
const readableRow = extfRow;

/* ======================== Hauptfunktion (ZIP) ========================== */
/**
 * entries: Array von { kind: 'invoice'|'storno', customer, booking, offer }
 * includePdfs: boolean – PDFs im Ordner /belege/ mitschreiben (Default: false)
 */
async function writeDatevZip({ res, entries, includePdfs = false }) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="datev-export.zip"`);

  const archive = archiver('zip', { zlib: { level: 3 } });
  archive.on('error', (err) => {
    console.error('[DATEV] archiver error:', err);
    try { res.status(500).end(); } catch {}
  });
  archive.pipe(res);

  const readableCsvChunks = [];
  readableCsvChunks.push('\uFEFF' + readableHeaderRow() + '\n');

  const extfCsvChunks = [];
  extfCsvChunks.push('\uFEFF' + extfHeader() + '\n');

  for (const e of entries) {
    const { kind, customer, booking, offer } = e;

    let belegNr='', belegDat, amount=0, sh='S', text='', pdfBuf=null, belegType='';
    const title = booking?.offerTitle || booking?.offerType || offer?.sub_type || offer?.title || '';
    const course = courseOnly(title);

    if (kind === 'invoice') {
      const amt =
        (Number.isFinite(Number(booking?.firstMonthAmount)) ? Number(booking.firstMonthAmount)
         : Number.isFinite(Number(booking?.monthlyAmount))  ? Number(booking.monthlyAmount)
         : Number.isFinite(Number(booking?.priceAtBooking)) ? Number(booking.priceAtBooking)
         : Number.isFinite(Number(offer?.price))            ? Number(offer.price)
         : 0);

      amount   = amt;
      sh       = 'S';
      belegNr  = normalizeInvoiceNo(booking?.invoiceNumber || booking?.invoiceNo || '');
      belegDat = fmtDDMMYYYY(booking?.invoiceDate || new Date());
      text     = `Teilnahme – ${course}`;
      belegType= 'Rechnung';

      if (includePdfs) {
        try {
          pdfBuf = await buildParticipationPdf({
            customer, booking, offer,
            invoiceNo: booking?.invoiceNumber || booking?.invoiceNo,
            invoiceDate: booking?.invoiceDate,
            monthlyAmount: booking?.monthlyAmount,
            firstMonthAmount: booking?.firstMonthAmount,
            venue: booking?.venue || offer?.location
          });
        } catch (err) {
          console.warn('[DATEV] participation PDF failed for', belegNr, err?.message);
          pdfBuf = null;
        }
      }
    } else if (kind === 'storno') {
      const amt =
        Number.isFinite(Number(booking?.stornoAmount)) ? Number(booking.stornoAmount)
        : Number.isFinite(Number(offer?.price))         ? Number(offer.price)
        : 0;

      amount   = amt;
      sh       = 'S'; // OPOS: Erlöse an Forderungen (beide SOLL/HABEN-Seite via Konten, nicht SH)
      belegNr  = String(booking?.stornoNo || booking?.stornoNumber || '').trim();
      belegDat = fmtDDMMYYYY(booking?.stornoDate || booking?.cancelDate || new Date());
      text     = `Gutschrift – ${course}`;
      belegType= 'Gutschrift';

      if (includePdfs) {
        try {
          pdfBuf = await buildStornoPdf({
            customer, booking, offer,
            amount: amount,
            currency: CURRENCY,
            stornoNo: booking?.stornoNo
          });
        } catch (err) {
          console.warn('[DATEV] storno PDF failed for', belegNr, err?.message);
          pdfBuf = null;
        }
      }
    } else {
      continue;
    }

    if (!belegNr || amount <= 0) continue;

    const dateForName = (kind === 'invoice')
      ? (booking?.invoiceDate || new Date())
      : (booking?.stornoDate || booking?.cancelDate || new Date());

    const fileName = fileNameFrom({ date: dateForName, no: belegNr, type: belegType });
    const belegRelPath = `${BELEG_DIR}/${fileName}`;

    const rowObj = (kind === 'invoice')
      ? {
          amount,
          sh,
          currency: CURRENCY,
          konto: AR_ACCOUNT,     // Forderungen an …
          gkto:  REV_ACCOUNT,    // … Erlöse
          bu:    BU_KEY,
          belegDatum: belegDat,
          belegNr:    belegNr,
          text,
          belegLink:  includePdfs ? belegRelPath : '', // Link nur wenn PDFs drin sind
        }
      : {
          amount,
          sh,
          currency: CURRENCY,
          konto: REV_ACCOUNT,     // Erlöse an …
          gkto:  AR_ACCOUNT,      // … Forderungen
          bu:    BU_KEY,
          belegDatum: belegDat,
          belegNr:    belegNr,
          text,
          belegLink:  includePdfs ? belegRelPath : '',
        };

    readableCsvChunks.push(readableRow(rowObj) + '\n');
    extfCsvChunks.push(extfRow(rowObj) + '\n');

    if (includePdfs && pdfBuf) {
      archive.append(pdfBuf, { name: belegRelPath });
    }
  }

  // CSVs anhängen
  archive.append(Buffer.from(readableCsvChunks.join(''), 'utf8'), { name: 'buchungen_readable.csv' });
  archive.append(Buffer.from(extfCsvChunks.join(''), 'utf8'), { name: 'buchungen_extf.csv' });

  // Belege-Ordner sicherstellen (auch wenn leer)
  archive.append(Buffer.from('', 'utf8'), { name: `${BELEG_DIR}/.keep` });

  await archive.finalize();
}

module.exports = {
  writeDatevZip,
};










