// routes/datev/helpers/datevValueHelpers.js
"use strict";

function parseIsoDate(value, endOfDay = false) {
  if (!value) return null;
  const iso = String(value).slice(0, 10);
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

function toDate(value) {
  return new Date(value);
}

function isValidDate(date) {
  return !Number.isNaN(date.getTime());
}

function toYyyyMmDd(value) {
  const date = toDate(value);
  if (!isValidDate(date)) return "";
  return joinDateParts(date);
}

function joinDateParts(date) {
  const year = date.getFullYear();
  const month = padTwo(date.getMonth() + 1);
  const day = padTwo(date.getDate());
  return `${year}${month}${day}`;
}

function padTwo(value) {
  return String(value).padStart(2, "0");
}

function formatGermanMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return roundMoney(amount).toFixed(2).replace(".", ",");
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function isInsideDateRange(value, from, to) {
  if (!value) return false;
  const date = toDate(value);
  if (!isValidDate(date)) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function positiveNumberOrNull(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function safeText(value) {
  return String(value ?? "").trim();
}

function safeLower(value) {
  return safeText(value).toLowerCase();
}

function courseOnly(value = "") {
  let text = safeText(value);
  text = text.split(/\s*(?:[•|]|—|–)\s*/)[0];
  text = removeCommaAddress(text);
  text = removeDashAddress(text);
  return safeText(text);
}

function removeCommaAddress(value) {
  const index = value.search(/,\s*\d/);
  return index > 0 ? value.slice(0, index) : value;
}

function removeDashAddress(value) {
  const index = value.search(/\s-\s*\d/);
  return index > 0 ? value.slice(0, index) : value;
}

function cleanText(value = "") {
  const text = String(value || "").replace(/[;\r\n]+/g, " ");
  return collapseWhitespace(text).slice(0, 60);
}

function collapseWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickInvoiceAmount(booking, offer) {
  const candidates = invoiceAmountCandidates(booking, offer);
  return firstPositiveAmount(candidates);
}

function invoiceAmountCandidates(booking, offer) {
  return [
    booking?.firstMonthAmount,
    booking?.monthlyAmount,
    booking?.priceAtBooking,
    offer?.price,
  ];
}

function pickStornoAmount(booking, offer) {
  const candidates = stornoAmountCandidates(booking, offer);
  return firstPositiveAmount(candidates);
}

function stornoAmountCandidates(booking, offer) {
  return [booking?.stornoAmount, booking?.priceAtBooking, offer?.price];
}

function firstPositiveAmount(values) {
  for (const value of values) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return null;
}

function buildDatevRow(args) {
  return {
    Umsatz: formatGermanMoney(args.amount),
    SH: args.side || "S",
    WKZ: args.currency,
    Konto: pickDebitAccount(args),
    Gegenkonto: pickCreditAccount(args),
    BU: 0,
    Belegdatum: toYyyyMmDd(args.date),
    Belegnummer: args.number,
    Buchungstext: cleanText(args.text),
    Beleglink: args.link || "",
  };
}

function pickDebitAccount(args) {
  return args.reverse ? args.creditAccount : args.debitAccount;
}

function pickCreditAccount(args) {
  return args.reverse ? args.debitAccount : args.creditAccount;
}

function pushExtfRow(extfRows, row) {
  extfRows.push(extfValues(row).join(";"));
}

function extfValues(row) {
  return [
    row.Umsatz,
    row.SH,
    row.WKZ,
    row.Konto,
    row.Gegenkonto,
    row.BU,
    row.Belegdatum,
    row.Belegnummer,
    row.Buchungstext,
    "",
  ];
}

function pushReadableRow(readableRows, extfRows, row) {
  readableRows.push(row);
  pushExtfRow(extfRows, row);
}

function buildReadableCsv(readableRows) {
  return readableHeader() + readableBody(readableRows);
}

function readableHeader() {
  return "Umsatz;SH;WKZ;Konto;Gegenkonto;BU;Belegdatum;Belegnummer;Buchungstext;Beleglink\n";
}

function readableBody(readableRows) {
  return readableRows.map(readableRowText).join("\n");
}

function readableRowText(row) {
  return [
    row.Umsatz,
    row.SH,
    row.WKZ,
    row.Konto,
    row.Gegenkonto,
    row.BU,
    row.Belegdatum,
    row.Belegnummer,
    row.Buchungstext,
    row.Beleglink,
  ].join(";");
}

function buildExtfCsv(extfRows, exportName, currency, now = new Date()) {
  return buildExtfHeader(exportName, currency, now) + extfRows.join("\n");
}

function buildExtfHeader(exportName, currency, now) {
  const stamp = buildExtfStamp(now);
  return `EXTF;700;21;Buchungsstapel;13;${stamp};;${exportName};1;${currency}\n`;
}

function buildExtfStamp(now) {
  const year = now.getFullYear();
  const month = padTwo(now.getMonth() + 1);
  const day = padTwo(now.getDate());
  const hour = padTwo(now.getHours());
  const minute = padTwo(now.getMinutes());
  const second = padTwo(now.getSeconds());
  return `${year}${month}${day}${hour}${minute}${second}000`;
}

function buildZipFileName(now = new Date()) {
  return `datev-export-${toYyyyMmDd(now)}.zip`;
}

function buildBatchId(now = new Date()) {
  return `datev-${toYyyyMmDd(now)}-${Date.now()}`;
}

module.exports = {
  buildBatchId,
  buildDatevRow,
  buildExtfCsv,
  buildReadableCsv,
  buildZipFileName,
  cleanText,
  collapseWhitespace,
  courseOnly,
  formatGermanMoney,
  isInsideDateRange,
  parseIsoDate,
  pickInvoiceAmount,
  pickStornoAmount,
  positiveNumberOrNull,
  pushReadableRow,
  safeLower,
  safeText,
  toYyyyMmDd,
};
