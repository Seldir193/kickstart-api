









// utils/sequences.js
const Counter = require('../models/Counter');

async function nextSequence(key) {
  const doc = await Counter.findOneAndUpdate(
    { _id: String(key) },                    // ✅ _id statt key
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();                                  // optional: plain object
  return doc.seq; // 1, 2, 3, ...
}

function yearFrom(date = new Date()) {
  return new Date(date).getFullYear();
}

function typeCodeFromOfferType(offerType = '') {
  const map = {
    'Foerdertraining': 'FO',
    'Kindergarten': 'KIGA',
    'Athletiktraining': 'AT',
    'AthleticTraining': 'AT',
  };
  return map[offerType] || (offerType.slice(0,2).toUpperCase() || 'XX');
}

/** ——— Bestehendes Langformat bleibt für Abwärtskompatibilität erhalten ——— */
function formatNumber(providerId, code, year, seq) {
  // z.B. "1/FO/2025/28"
  return `${providerId}/${code}/${year}/${seq}`;
}

/** ——— Neu: Kurzformate ——— */
function twoDigitYear(date = new Date()) {
  return String(yearFrom(date)).slice(-2);
}
function pad4(n) {
  return String(n).padStart(4, '0');
}
function randHex(len = 6) {
  const hex = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < len; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

/** Haupt-Rechnungsnummer kurz, z.B. "AT-25-0013" */
function formatInvoiceShort(typeCode, seq, date = new Date()) {
  const yy = twoDigitYear(date);
  const code = (typeCode || 'INV').toUpperCase();
  return `${code}-${yy}-${pad4(seq)}`;
}

/** Kündigungsnummer, z.B. "KND-925B67" */
function formatCancellationNo() {
  return `KND-${randHex(6)}`;
}

/** Stornonummer, z.B. "STORNO-925CF4" */
function formatStornoNo() {
  return `STORNO-${randHex(6)}`;
}

function typeCodeFromOffer(offer = {}) {
  const st = String(offer?.sub_type || '').toLowerCase();
  if (st === 'powertraining') return 'PW';
  return typeCodeFromOfferType(offer?.type || '');
}

module.exports = {
  nextSequence,
  yearFrom,
  typeCodeFromOfferType,
  formatNumber,
  formatInvoiceShort,
  typeCodeFromOffer,
  formatCancellationNo,
  formatStornoNo,
};
