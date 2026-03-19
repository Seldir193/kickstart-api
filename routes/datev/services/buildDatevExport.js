// routes/datev/services/buildDatevExport.js
"use strict";

const archiver = require("archiver");
const mongoose = require("mongoose");

const Customer = require("../../../models/Customer");
const Offer = require("../../../models/Offer");

const { appendDunningRows } = require("../helpers/dunningDatevHelpers");
const { pushCreditRowForBooking } = require("../helpers/creditNoteHelpers");

const {
  buildBatchId,
  buildDatevRow,
  buildExtfCsv,
  buildReadableCsv,
  buildZipFileName,
  courseOnly,
  isInsideDateRange,
  parseIsoDate,
  pickInvoiceAmount,
  pushReadableRow,
  safeText,
} = require("../helpers/datevValueHelpers");

function getDatevConfig() {
  return {
    debitAccount: Number(process.env.DATEV_AR_ACCOUNT || 10000),
    creditAccount: Number(process.env.DATEV_REVENUE_ACCOUNT || 8195),
    currency: (process.env.DATEV_CURRENCY || "EUR").toUpperCase(),
    exportName: process.env.DATEV_EXPORT_NAME || "Münchner Fussball Schule NRW",
  };
}

async function loadCustomers(owner) {
  return Customer.find({ owner })
    .select("_id userId parent child address bookings")
    .lean();
}

function collectOfferIds(customers) {
  const offerIds = [];
  for (const customer of customers) {
    collectCustomerOfferIds(customer, offerIds);
  }
  return [...new Set(offerIds)];
}

function collectCustomerOfferIds(customer, offerIds) {
  for (const booking of customer.bookings || []) {
    collectBookingOfferIds(booking, offerIds);
  }
}

function collectBookingOfferIds(booking, offerIds) {
  for (const key of ["offerId", "offer_id", "offer", "offerRef"]) {
    const value = booking?.[key];
    if (value && mongoose.isValidObjectId(String(value)))
      offerIds.push(String(value));
  }
}

async function loadOfferMap(offerIds) {
  if (!offerIds.length) return new Map();
  const offers = await Offer.find({ _id: { $in: offerIds } })
    .select("_id title type sub_type location price")
    .lean();
  return new Map(offers.map((offer) => [String(offer._id), offer]));
}

function findOfferForBooking(booking, offerMap) {
  for (const key of ["offerId", "offer_id", "offer", "offerRef"]) {
    const value = booking?.[key];
    if (!value) continue;
    const offer = offerMap.get(String(value));
    if (offer) return offer;
  }
  return null;
}

function buildCourseName(booking, offer) {
  return courseOnly(
    booking.offerTitle ||
      booking.offerType ||
      offer?.sub_type ||
      offer?.title ||
      "Kurs",
  );
}

function buildInvoiceReference(booking) {
  return {
    number: safeText(booking?.invoiceNumber || booking?.invoiceNo),
    date: booking?.invoiceDate || booking?.date || booking?.createdAt || null,
  };
}

function createExportStats() {
  return {
    invoiceOk: 0,
    invoiceSkip: 0,
    stornoOk: 0,
    stornoSkip: 0,
    creditOk: 0,
    dunningRaw: 0,
    dunningDeduped: 0,
    dunningRows: 0,
  };
}

function pushInvoiceRowForBooking(args) {
  const invoice = buildInvoiceReference(args.booking);
  const amount = pickInvoiceAmount(args.booking, args.offer);
  if (!isExportableInvoice(invoice, amount, args.from, args.to)) {
    args.stats.invoiceSkip += 1;
    return;
  }
  const row = buildInvoiceDatevRow(args, invoice, amount);
  pushReadableRow(args.readableRows, args.extfRows, row);
  args.stats.invoiceOk += 1;
}

function isExportableInvoice(invoice, amount, from, to) {
  if (!invoice.number || !invoice.date) return false;
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return isInsideDateRange(invoice.date, from, to);
}

function buildInvoiceDatevRow(args, invoice, amount) {
  return buildDatevRow({
    amount,
    currency: args.config.currency,
    debitAccount: args.config.debitAccount,
    creditAccount: args.config.creditAccount,
    date: invoice.date,
    number: invoice.number,
    text: `Teilnahme – ${args.course}`,
  });
}

async function appendBookingRows(args) {
  for (const customer of args.customers) {
    await appendCustomerBookingRows(customer, args);
  }
}

async function appendCustomerBookingRows(customer, args) {
  for (const booking of customer.bookings || []) {
    appendSingleBookingRows(booking, args.offerMap, args);
  }
}

function appendSingleBookingRows(booking, offerMap, args) {
  const offer = findOfferForBooking(booking, offerMap);
  const course = buildCourseName(booking, offer);
  pushInvoiceRowForBooking({ ...args, booking, offer, course });
  pushCreditRowForBooking(buildCreditArgs(args, booking, offer, course));
}

function buildCreditArgs(args, booking, offer, course) {
  return {
    readableRows: args.readableRows,
    extfRows: args.extfRows,
    booking,
    offer,
    course,
    from: args.from,
    to: args.to,
    buildDatevRow,
    currency: args.config.currency,
    debitAccount: args.config.debitAccount,
    creditAccount: args.config.creditAccount,
    stats: args.stats,
  };
}

function mapDunningStats(targetStats, dunningStats) {
  targetStats.dunningRaw = dunningStats.rawCount;
  targetStats.dunningDeduped = dunningStats.dedupedCount;
  targetStats.dunningRows = dunningStats.exportedRows;
}

function setZipHeaders(res, fileName) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
}

function createZipArchive(res) {
  const archive = archiver("zip", { zlib: { level: 3 } });
  archive.on("error", () => endZipResponseWithError(res));
  archive.pipe(res);
  return archive;
}

function endZipResponseWithError(res) {
  try {
    res.status(500).end();
  } catch {}
}

async function appendZipFiles(args) {
  appendReadableCsv(args.archive, args.readableRows);
  appendExtfCsv(args.archive, args.extfRows, args.config);
  await args.archive.finalize();
}

function appendReadableCsv(archive, readableRows) {
  const readableCsv = buildReadableCsv(readableRows);
  archive.append(Buffer.from(readableCsv, "utf8"), {
    name: "buchungen_readable.csv",
  });
}

function appendExtfCsv(archive, extfRows, config) {
  const extfCsv = buildExtfCsv(extfRows, config.exportName, config.currency);
  archive.append(Buffer.from(extfCsv, "utf8"), { name: "buchungen_extf.csv" });
}

async function buildDatevExport({ req, res, owner }) {
  const from = parseIsoDate(req.query.from, false);
  const to = parseIsoDate(req.query.to, true);
  const config = getDatevConfig();
  const readableRows = [];
  const extfRows = [];
  const stats = createExportStats();

  const customers = await loadCustomers(owner);
  const offerIds = collectOfferIds(customers);
  const offerMap = await loadOfferMap(offerIds);

  await appendBookingRows({
    customers,
    offerMap,
    readableRows,
    extfRows,
    from,
    to,
    config,
    stats,
  });

  const dunningStats = await appendDunningRows({
    owner,
    readableRows,
    extfRows,
    from,
    to,
    currency: config.currency,
    debitAccount: config.debitAccount,
    creditAccount: config.creditAccount,
    batchId: buildBatchId(),
  });

  mapDunningStats(stats, dunningStats);
  setZipHeaders(res, buildZipFileName());

  const archive = createZipArchive(res);
  await appendZipFiles({ archive, readableRows, extfRows, config });

  console.log("[DATEV/OPOS simple] stats", stats, "rows:", extfRows.length);
}

module.exports = {
  appendBookingRows,
  buildCourseName,
  buildDatevExport,
  buildInvoiceReference,
  collectOfferIds,
  createExportStats,
  findOfferForBooking,
  getDatevConfig,
  loadCustomers,
  loadOfferMap,
  mapDunningStats,
};
