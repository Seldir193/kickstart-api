// utils/sequences.js
const Counter = require('../models/Counter');

async function nextSequence(key) {
  const doc = await Counter.findOneAndUpdate(
    { _id: String(key) },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return doc.seq;
}

function yearFrom(date = new Date()) {
  return new Date(date).getFullYear();
}

/** Typ → 2–3-Buchstaben-Code */
function typeCodeFromOfferType(offerType = '') {
  const map = {
    Foerdertraining: 'FO',
    Kindergarten: 'KDN',
    PersonalTraining: 'PER',
    Camp: 'CA',
    Athletiktraining: 'ATH',
    AthleticTraining: 'ATH',
    RentACoach: 'RAC',
    ClubProgram: 'CLB',
    ClubPrograms: 'CLB',
    CoachEducation: 'CED',
  };

  const code = map[offerType];
  if (code) return code;

  // Fallback: erste 3 Buchstaben, max. 3
  const trimmed = String(offerType || '').trim();
  return trimmed ? trimmed.slice(0, 3).toUpperCase() : 'XXX';
}

/** Haupt-Rechnungsnummer lang (dein bestehendes Format) */
function formatNumber(providerId, code, year, seq) {
  return `${providerId}/${code}/${year}/${seq}`;
}

/* ---- Kurzform-Helfer bleiben wie gehabt ---- */
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

function formatInvoiceShort(typeCode, seq, date = new Date()) {
  const yy = twoDigitYear(date);
  const code = (typeCode || 'INV').toUpperCase();
  return `${code}-${yy}-${pad4(seq)}`;
}

/** Sub-Typen (sub_type) → Code */
function typeCodeFromOffer(offer = {}) {
  const st = String(offer?.sub_type || '');
  const subMap = {
    Powertraining: 'PW',
    Foerdertraining_Athletik: 'ATH',
    Torwarttraining: 'TWT',
    Einzeltraining_Athletik: 'ETA',
    Einzeltraining_Torwart: 'ETT',
    RentACoach_Generic: 'RAC',
    ClubProgram_Generic: 'CLB',
    CoachEducation: 'CED',
  };

  if (subMap[st]) return subMap[st];

  // sonst nach type mappen
  return typeCodeFromOfferType(offer?.type || '');
}

function formatCancellationNo() {
  return `KND-${randHex(6)}`;
}

function formatStornoNo() {
  return `STORNO-${randHex(6)}`;
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











