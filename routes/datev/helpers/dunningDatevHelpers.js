// routes/datev/helpers/dunningDatevHelpers.js
"use strict";

const mongoose = require("mongoose");
const BillingDocument = require("../../../models/BillingDocument");

const {
  buildDatevRow,
  cleanText,
  isInsideDateRange,
  positiveNumberOrNull,
  pushReadableRow,
  safeText,
} = require("./datevValueHelpers");

function safeStage(document) {
  return safeText(document?.stage) || "reminder";
}

function dunningLink(document) {
  const id = safeText(document?._id);
  return id ? `/api/admin/invoices/dunning-documents/${id}/download` : "";
}

function buildDunningNumber(document, suffix) {
  const invoiceNo = safeText(document?.invoiceNo) || "NO-INVOICE";
  return `DUN-${invoiceNo}-${safeStage(document)}-${suffix}`;
}

function buildDunningText(document, label) {
  const invoiceNo = safeText(document?.invoiceNo) || "NO-INVOICE";
  return cleanText(`${label} – ${invoiceNo} – ${safeStage(document)}`);
}

function buildDunningFeeItems() {
  return [
    { key: "returnBankFee", suffix: "RLS", label: "Rücklastschriftgebühr" },
    { key: "dunningFee", suffix: "MAHN", label: "Mahngebühr" },
    { key: "processingFee", suffix: "BEARB", label: "Bearbeitungsgebühr" },
  ];
}

function pushDunningRowsForDocument(args) {
  const eventDate = buildDunningEventDate(args.document, args.mode);
  if (!eventDate || !isInsideDateRange(eventDate, args.from, args.to)) return 0;
  return pushDunningFeeItems(args, eventDate);
}

function buildDunningEventDate(document, mode) {
  return mode === "void-storno"
    ? document?.voidedAt || null
    : document?.sentAt || null;
}

function pushDunningFeeItems(args, eventDate) {
  let pushed = 0;
  for (const item of buildDunningFeeItems()) {
    const pushedItem = pushSingleDunningFeeRow(args, item, eventDate);
    if (pushedItem) pushed += 1;
  }
  return pushed;
}

function pushSingleDunningFeeRow(args, item, eventDate) {
  const amount = positiveNumberOrNull(args.document?.feesSnapshot?.[item.key]);
  if (!amount) return false;
  const row = buildDunningFeeRow(args, item, amount, eventDate);
  pushReadableRow(args.readableRows, args.extfRows, row);
  return true;
}

function buildDunningFeeRow(args, item, amount, eventDate) {
  return buildDatevRow({
    amount,
    currency: args.currency,
    debitAccount: args.debitAccount,
    creditAccount: args.creditAccount,
    date: eventDate,
    number: buildDunningNumber(
      args.document,
      buildDunningSuffix(args.mode, item.suffix),
    ),
    text: buildDunningText(
      args.document,
      buildDunningLabel(args.mode, item.label),
    ),
    link: dunningLink(args.document),
    side: args.mode === "void-storno" ? "H" : "S",
  });
}

function buildDunningSuffix(mode, suffix) {
  return mode === "void-storno" ? `${suffix}-STO` : suffix;
}

function buildDunningLabel(mode, label) {
  return mode === "void-storno" ? `${label} (Storno)` : label;
}

async function loadRawDunningDocuments(owner) {
  return BillingDocument.find(buildDunningQuery(owner))
    .select(buildDunningSelect())
    .sort({ createdAt: 1 })
    .lean();
}

function buildDunningQuery(owner) {
  return {
    owner: String(owner),
    kind: "dunning",
    sentAt: { $ne: null },
  };
}

function buildDunningSelect() {
  return "_id stage invoiceNo sentAt createdAt feesSnapshot voidedAt datevExportedAt datevVoidedExportedAt";
}

function dedupeFirstDunningDocuments(documents) {
  const firstByKey = new Map();
  for (const document of documents) {
    const key = buildDunningDedupKey(document);
    if (!firstByKey.has(key)) firstByKey.set(key, document);
  }
  return [...firstByKey.values()];
}

function buildDunningDedupKey(document) {
  const invoiceNo = safeText(document?.invoiceNo) || "NO-INVOICE";
  return `${invoiceNo}__${safeStage(document)}`;
}

function shouldExportVoidedCorrection(document) {
  if (!document?.voidedAt) return false;
  if (!document?.datevExportedAt) return false;
  if (document?.datevVoidedExportedAt) return false;
  return hasLaterVoidDate(document);
}

function hasLaterVoidDate(document) {
  const voidedTime = new Date(document.voidedAt).getTime();
  const exportedTime = new Date(document.datevExportedAt).getTime();
  return voidedTime > exportedTime;
}

async function updateDatevTracking(ids, fieldName, batchFieldName, batchId) {
  if (!ids.length) return;
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  await BillingDocument.updateMany(
    buildTrackingQuery(objectIds, fieldName),
    buildTrackingUpdate(fieldName, batchFieldName, batchId),
  );
}

function buildTrackingQuery(objectIds, fieldName) {
  return { _id: { $in: objectIds }, [fieldName]: null };
}

function buildTrackingUpdate(fieldName, batchFieldName, batchId) {
  const now = new Date();
  return { $set: { [fieldName]: now, [batchFieldName]: batchId } };
}

async function updateDunningTracking(exportedIds, voidedIds, batchId) {
  await updateDatevTracking(
    exportedIds,
    "datevExportedAt",
    "datevBatchId",
    batchId,
  );
  await updateDatevTracking(
    voidedIds,
    "datevVoidedExportedAt",
    "datevVoidedBatchId",
    batchId,
  );
}

function buildInitialDunningStats() {
  return { rawCount: 0, dedupedCount: 0, exportedRows: 0 };
}

async function appendDunningRows(args) {
  const stats = buildInitialDunningStats();
  const rawDocuments = await loadRawDunningDocuments(args.owner);
  const firstDocuments = dedupeFirstDunningDocuments(rawDocuments);
  const trackingIds = buildTrackingIds(
    firstDocuments,
    args,
    stats,
    rawDocuments,
  );
  await tryUpdateDunningTracking(trackingIds, args.batchId);
  return stats;
}

function buildTrackingIds(firstDocuments, args, stats, rawDocuments) {
  stats.rawCount = rawDocuments.length;
  stats.dedupedCount = firstDocuments.length;
  const exportedIds = appendNormalDunningRows(firstDocuments, args, stats);
  const voidedIds = appendVoidedDunningRows(firstDocuments, args, stats);
  return { exportedIds, voidedIds };
}

function appendNormalDunningRows(documents, args, stats) {
  const exportedIds = [];
  for (const document of documents) {
    if (document?.voidedAt) continue;
    const added = pushDunningRowsForDocument({
      ...args,
      document,
      mode: "normal",
    });
    if (added > 0) exportedIds.push(String(document._id));
    stats.exportedRows += added;
  }
  return exportedIds;
}

function appendVoidedDunningRows(documents, args, stats) {
  const voidedIds = [];
  for (const document of documents) {
    if (!shouldExportVoidedCorrection(document)) continue;
    const added = pushDunningRowsForDocument({
      ...args,
      document,
      mode: "void-storno",
    });
    if (added > 0) voidedIds.push(String(document._id));
    stats.exportedRows += added;
  }
  return voidedIds;
}

async function tryUpdateDunningTracking(trackingIds, batchId) {
  try {
    await updateDunningTracking(
      trackingIds.exportedIds,
      trackingIds.voidedIds,
      batchId,
    );
  } catch (error) {
    console.error("[DATEV] tracking update failed:", error);
  }
}

module.exports = {
  appendDunningRows,
  buildDunningNumber,
  buildDunningText,
  dedupeFirstDunningDocuments,
  dunningLink,
  loadRawDunningDocuments,
  pushDunningRowsForDocument,
  safeStage,
  shouldExportVoidedCorrection,
  updateDunningTracking,
};
