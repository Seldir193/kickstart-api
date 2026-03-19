"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeStr(value) {
  return String(value || "").trim();
}

function safeFilePart(value) {
  return safeStr(value).replace(/[^\w.-]+/g, "_");
}

function stageLabel(stage) {
  const s = safeStr(stage);
  if (s === "reminder") return "zahlungserinnerung";
  if (s === "dunning1") return "mahnung-1";
  if (s === "dunning2") return "mahnung-2";
  if (s === "final") return "letzte-mahnung";
  return "mahnung";
}

function bookingDocNo(booking = {}) {
  return safeStr(
    booking.invoiceNo ||
      booking.invoiceNumber ||
      booking.refInvoiceNo ||
      booking.cancellationNo ||
      booking.stornoNo ||
      booking.stornoNumber ||
      "",
  );
}

function toIso(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function yyyyMm(value) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function searchBlob({ customer, booking, stage, subject }) {
  const parent = customer?.parent || {};
  const child = customer?.child || {};
  const address = customer?.address || {};
  const parts = [
    stage,
    subject,
    booking?.invoiceNo,
    booking?.invoiceNumber,
    booking?.refInvoiceNo,
    booking?.offer,
    booking?.offerTitle,
    booking?.offerType,
    booking?.venue,
    parent.salutation,
    parent.firstName,
    parent.lastName,
    parent.email,
    child.firstName,
    child.lastName,
    address.street,
    address.houseNo,
    address.zip,
    address.city,
    customer?._id,
    customer?.userId,
    booking?._id,
  ];
  return parts
    .map((v) => safeStr(v))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function archiveDunningPdf({
  pdfBuffer,
  booking,
  customer,
  stage,
  sentAt,
  dueAt,
  subject,
  feeSnapshot,
  owner,
}) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
    throw new Error("Invalid dunning PDF buffer");
  }

  const baseDir = process.env.DOCS_DIR
    ? path.resolve(process.cwd(), process.env.DOCS_DIR)
    : path.resolve(process.cwd(), "uploads", "documents");

  const when = sentAt instanceof Date ? sentAt : new Date(sentAt || Date.now());
  const monthDir = yyyyMm(when);
  const ownerDir = safeFilePart(owner || "owner");
  const customerId = safeFilePart(
    customer?._id || customer?.userId || "customer",
  );
  const bookingId = safeFilePart(booking?._id || "booking");
  const docNo = safeFilePart(bookingDocNo(booking) || bookingId);
  const stagePart = stageLabel(stage);
  const ts = toIso(when).replace(/[:.]/g, "-");
  const fileName = `${stagePart}-${docNo}-${ts}.pdf`;

  const relDir = path.join("dunning", ownerDir, monthDir, customerId);
  const absDir = ensureDir(path.join(baseDir, relDir));
  const absPath = path.join(absDir, fileName);
  fs.writeFileSync(absPath, pdfBuffer);

  const relPath = path.join(relDir, fileName).replace(/\\/g, "/");

  return {
    kind: "dunning",
    stage: safeStr(stage),
    category: "billing",
    mimeType: "application/pdf",
    fileName,
    filePath: relPath,
    fileSize: pdfBuffer.length,
    bookingId: booking?._id || null,
    customerId: customer?._id || null,
    customerNo: safeStr(customer?.userId),
    invoiceNo: bookingDocNo(booking),
    invoiceDate: booking?.invoiceDate || null,
    offerTitle: safeStr(
      booking?.offerTitle || booking?.offer || booking?.offerType,
    ),
    subject: safeStr(subject),
    sentAt: when,
    dueAt: dueAt || null,
    feesSnapshot: feeSnapshot || {},
    createdBy: owner || null,
    searchText: searchBlob({ customer, booking, stage, subject }),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

module.exports = {
  archiveDunningPdf,
};
