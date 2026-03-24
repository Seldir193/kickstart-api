"use strict";

const archiver = require("archiver");
const mongoose = require("mongoose");

const Customer = require("../../../models/Customer");
const Offer = require("../../../models/Offer");
const BillingDocument = require("../../../models/BillingDocument");
const Booking = require("../../../models/Booking");

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

function collectBookingIds(customers) {
  const ids = [];

  for (const customer of customers) {
    for (const booking of customer.bookings || []) {
      const bookingId = String(booking?.bookingId || booking?._id || "").trim();
      if (bookingId && mongoose.isValidObjectId(bookingId)) ids.push(bookingId);
    }
  }

  return [...new Set(ids)];
}

async function loadBookingDocsMap(owner, bookingIds) {
  if (!bookingIds.length) return new Map();

  const docs = await Booking.find(
    { owner, _id: { $in: bookingIds } },
    {
      meta: 1,
      discount: 1,
      voucherCode: 1,
      voucherDiscount: 1,
      totalDiscount: 1,
      finalPrice: 1,
      priceMonthly: 1,
      monthlyAmount: 1,
      priceAtBooking: 1,
      invoiceNo: 1,
      invoiceNumber: 1,
      invoiceDate: 1,
    },
  ).lean();

  return new Map(docs.map((doc) => [String(doc._id), doc]));
}

function mergeBookingWithDoc(bookingRef, bookingDoc) {
  if (!bookingDoc) return bookingRef;
  return { ...bookingRef, ...bookingDoc };
}

async function loadCustomers(owner) {
  return Customer.find({ owner })
    .select("_id userId parent child address bookings")
    .lean();
}

function collectOfferIds(customers) {
  const offerIds = [];

  for (const customer of customers) {
    for (const booking of customer.bookings || []) {
      for (const key of ["offerId", "offer_id", "offer", "offerRef"]) {
        const value = booking?.[key];
        if (value && mongoose.isValidObjectId(String(value))) {
          offerIds.push(String(value));
        }
      }
    }
  }

  return [...new Set(offerIds)];
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
    recurringInvoiceOk: 0,
    recurringInvoiceSkip: 0,
    recurringInvoiceDocs: 0,
    recurringInvoiceMissingBooking: 0,
    recurringInvoiceMissingData: 0,
    recurringInvoiceOutOfRange: 0,
    skippedDuplicateInvoices: 0,
    skippedDuplicateCredits: 0,
  };
}

function createExportState() {
  return {
    invoiceKeys: new Set(),
    creditKeys: new Set(),
  };
}

function buildInvoiceExportKey(invoiceNo, fallbackId) {
  const no = safeText(invoiceNo);
  const id = safeText(fallbackId);
  if (no) return `invoice:${no}`;
  if (id) return `invoice-fallback:${id}`;
  return "";
}

function buildCreditExportKey(referenceNo, fallbackId) {
  const no = safeText(referenceNo);
  const id = safeText(fallbackId);
  if (no) return `credit:${no}`;
  if (id) return `credit-fallback:${id}`;
  return "";
}

async function loadRecurringInvoiceDocs(owner) {
  const docs = await BillingDocument.find({
    owner: String(owner),
    kind: "invoice",
    voidedAt: null,
  })
    .select(
      "_id bookingId customerId invoiceNo invoiceDate sentAt createdAt amount fileName filePath",
    )
    .lean();

  return docs;
}

function buildBookingMap(customers, bookingDocsMap) {
  const map = new Map();

  for (const customer of customers) {
    for (const bookingRef of customer.bookings || []) {
      const bookingId = String(
        bookingRef?.bookingId || bookingRef?._id || "",
      ).trim();

      if (!bookingId) continue;

      const bookingDoc = bookingDocsMap.get(bookingId) || null;
      const booking = mergeBookingWithDoc(bookingRef, bookingDoc);

      map.set(bookingId, { customer, booking });
    }
  }

  return map;
}

function buildVoucherText(booking) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
  const discount =
    booking?.discount && typeof booking.discount === "object"
      ? booking.discount
      : {};

  const voucherCode = safeText(
    meta.voucherCode ||
      meta.voucher ||
      discount.voucherCode ||
      booking?.voucherCode,
  );

  const voucherDiscount = Number(
    meta.voucherDiscount ??
      discount.voucherDiscount ??
      booking?.voucherDiscount ??
      0,
  );

  if (voucherCode) return ` Gutschein ${voucherCode}`;
  if (Number.isFinite(voucherDiscount) && voucherDiscount > 0) {
    return ` Gutschein ${voucherDiscount.toFixed(2).replace(".", ",")} EUR`;
  }

  return "";
}

function pushRecurringInvoiceRow(args) {
  const invoiceNo = safeText(args.doc?.invoiceNo);
  const invoiceDate =
    args.doc?.invoiceDate || args.doc?.sentAt || args.doc?.createdAt || null;

  const amount = Number(
    args.doc?.amount ??
      args.booking?.priceMonthly ??
      args.booking?.monthlyAmount ??
      args.offer?.price ??
      args.booking?.priceAtBooking ??
      0,
  );

  if (!invoiceNo || !invoiceDate || !Number.isFinite(amount) || amount <= 0) {
    args.stats.recurringInvoiceSkip += 1;
    args.stats.recurringInvoiceMissingData += 1;
    return;
  }

  if (!isInsideDateRange(invoiceDate, args.from, args.to)) {
    args.stats.recurringInvoiceSkip += 1;
    args.stats.recurringInvoiceOutOfRange += 1;
    return;
  }

  const dedupeKey = buildInvoiceExportKey(
    invoiceNo,
    args.doc?._id || args.booking?.bookingId || args.booking?._id,
  );

  if (dedupeKey && args.exportState.invoiceKeys.has(dedupeKey)) {
    args.stats.skippedDuplicateInvoices += 1;
    return;
  }

  if (dedupeKey) args.exportState.invoiceKeys.add(dedupeKey);

  const row = buildDatevRow({
    amount,
    currency: args.config.currency,
    debitAccount: args.config.debitAccount,
    creditAccount: args.config.creditAccount,
    date: invoiceDate,
    number: invoiceNo,
    text: `Folgerechnung – ${args.course}`,
  });

  pushReadableRow(args.readableRows, args.extfRows, row);
  args.stats.recurringInvoiceOk += 1;
}

async function appendRecurringInvoiceRows(args) {
  const docs = await loadRecurringInvoiceDocs(args.owner);
  const bookingMap = buildBookingMap(args.customers, args.bookingDocsMap);

  args.stats.recurringInvoiceDocs = docs.length;

  for (const doc of docs) {
    const bookingId = safeText(doc?.bookingId);
    const found = bookingMap.get(bookingId);

    if (!found) {
      args.stats.recurringInvoiceSkip += 1;
      args.stats.recurringInvoiceMissingBooking += 1;
      continue;
    }

    const offer = findOfferForBooking(found.booking, args.offerMap);
    const course = buildCourseName(found.booking, offer);

    pushRecurringInvoiceRow({
      ...args,
      doc,
      customer: found.customer,
      booking: found.booking,
      offer,
      course,
    });
  }
}

function pushInvoiceRowForBooking(args) {
  const invoice = buildInvoiceReference(args.booking);
  const amount = pickInvoiceAmount(args.booking, args.offer);

  if (!isExportableInvoice(invoice, amount, args.from, args.to)) {
    args.stats.invoiceSkip += 1;
    return;
  }

  const dedupeKey = buildInvoiceExportKey(
    invoice.number,
    args.booking?.bookingId || args.booking?._id,
  );

  if (dedupeKey && args.exportState.invoiceKeys.has(dedupeKey)) {
    args.stats.skippedDuplicateInvoices += 1;
    return;
  }

  if (dedupeKey) args.exportState.invoiceKeys.add(dedupeKey);

  const row = buildDatevRow({
    amount,
    currency: args.config.currency,
    debitAccount: args.config.debitAccount,
    creditAccount: args.config.creditAccount,
    date: invoice.date,
    number: invoice.number,
    text: `Teilnahme – ${args.course}${buildVoucherText(args.booking)}`,
  });

  pushReadableRow(args.readableRows, args.extfRows, row);
  args.stats.invoiceOk += 1;
}

function isExportableInvoice(invoice, amount, from, to) {
  if (!invoice.number || !invoice.date) return false;
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return isInsideDateRange(invoice.date, from, to);
}

async function appendBookingRows(args) {
  for (const customer of args.customers) {
    for (const bookingRef of customer.bookings || []) {
      const bookingId = String(
        bookingRef?.bookingId || bookingRef?._id || "",
      ).trim();

      const bookingDoc = args.bookingDocsMap.get(bookingId) || null;
      const booking = mergeBookingWithDoc(bookingRef, bookingDoc);
      const offer = findOfferForBooking(booking, args.offerMap);
      const course = buildCourseName(booking, offer);

      pushInvoiceRowForBooking({ ...args, booking, offer, course });
      pushCreditRowForBooking(buildCreditArgs(args, booking, offer, course));
    }
  }
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
    exportState: args.exportState,
    buildCreditExportKey,
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

function appendReadableCsv(archive, readableRows) {
  const readableCsv = buildReadableCsv(readableRows);
  archive.append(Buffer.from(readableCsv, "utf8"), {
    name: "buchungen_readable.csv",
  });
}

function appendExtfCsv(archive, extfRows, config) {
  const extfCsv = buildExtfCsv(extfRows, config.exportName, config.currency);
  archive.append(Buffer.from(extfCsv, "utf8"), {
    name: "buchungen_extf.csv",
  });
}

async function appendZipFiles(args) {
  appendReadableCsv(args.archive, args.readableRows);
  appendExtfCsv(args.archive, args.extfRows, args.config);
  await args.archive.finalize();
}

async function buildDatevExport({ req, res, owner }) {
  const from = parseIsoDate(req.query.from, false);
  const to = parseIsoDate(req.query.to, true);
  const config = getDatevConfig();
  const readableRows = [];
  const extfRows = [];
  const stats = createExportStats();
  const exportState = createExportState();

  const customers = await loadCustomers(owner);
  const offerIds = collectOfferIds(customers);
  const offerMap = await loadOfferMap(offerIds);
  const bookingIds = collectBookingIds(customers);
  const bookingDocsMap = await loadBookingDocsMap(owner, bookingIds);

  await appendBookingRows({
    customers,
    bookingDocsMap,
    offerMap,
    readableRows,
    extfRows,
    from,
    to,
    config,
    stats,
    exportState,
  });

  await appendRecurringInvoiceRows({
    owner,
    customers,
    bookingDocsMap,
    offerMap,
    readableRows,
    extfRows,
    from,
    to,
    config,
    stats,
    exportState,
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
