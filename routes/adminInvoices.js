// routes/adminInvoices.js
"use strict";

const DEBUG_INVOICES = process.env.DEBUG_INVOICES === "1";
const fs = require("fs/promises");
const express = require("express");
const mongoose = require("mongoose");
const { Types } = mongoose;

const router = express.Router();

const BillingDocument = require("../models/BillingDocument");
const { archiveDunningPdf } = require("../utils/dunningArchive");
const { buildCsvText } = require("./adminInvoices/csvExportShared");

const {
  makeSendDocumentEmailHandler,
} = require("./adminInvoices/handlers/sendDocumentEmail");

const {
  buildExportListWithDunning,
} = require("./adminInvoices/exportListWithDunning");

function getMailer() {
  return require("../utils/mailer");
}

const { normalizeInvoiceNo } = require("../utils/pdfData");

const sendDocumentEmailHandler = makeSendDocumentEmailHandler({
  mongoose,
  Types,
  getModels,
  requireOwner,
  loadOwnedBooking,
  findCustomerAndBookingByBookingId,
  getMailer,
});

router.post("/:bookingId/send-document-email", sendDocumentEmailHandler);

function normalizeFilterDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  return null;
}

function getModels(req) {
  const Customer =
    req.app?.locals?.models?.Customer || require("../models/Customer");
  const Booking =
    req.app?.locals?.models?.Booking || require("../models/Booking");
  return { Customer, Booking };
}

function getProviderIdRaw(req) {
  const v = req.get("x-provider-id");
  return v ? String(v).trim() : null;
}

function requireOwner(req, res) {
  const raw = getProviderIdRaw(req);
  if (!raw || !mongoose.isValidObjectId(raw)) {
    res
      .status(401)
      .json({ ok: false, error: "Unauthorized: invalid provider id" });
    return null;
  }
  return new Types.ObjectId(raw);
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function normalizeSort(s) {
  const def = { field: "issuedAt", dir: -1 };
  if (!s) return def;
  const [field, dir] = String(s).split(":");
  const map = { asc: 1, ASC: 1, desc: -1, DESC: -1 };
  return { field: field || def.field, dir: map[dir] ?? def.dir };
}

function toISO(d) {
  try {
    return new Date(d).toISOString();
  } catch {
    return null;
  }
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function isDigitsOnly(s) {
  return /^\d+$/.test(String(s || "").trim());
}

function docNoFrom(r) {
  return String(
    r.creditNoteNo ||
      r.invoiceNo ||
      r.invoiceNumber ||
      r.cancellationNo ||
      r.stornoNo ||
      r.stornoNumber ||
      "",
  ).trim();
}

function matchesInvoiceQuery({ q, customerNumber, docNo, blob }) {
  const raw = String(q || "").trim();
  if (!raw) return true;

  if (isDigitsOnly(raw)) {
    return String(customerNumber ?? "").trim() === raw;
  }

  const qq = norm(raw);
  const dn = norm(docNo);
  if (dn && dn.includes(qq)) return true;

  const dnDash = norm(String(docNo || "").replace(/\//g, "-"));
  if (dnDash && dnDash.includes(qq)) return true;

  return norm(blob).includes(qq);
}

function fullName(p) {
  const first = String(p?.firstName || "").trim();
  const last = String(p?.lastName || "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

function customerNameFrom(customer) {
  return fullName(customer?.parent) || "";
}

function customerChildNameFrom(customer) {
  return fullName(customer?.child) || "";
}

function docsFromBooking(customer, b, state) {
  const items = [];
  const baseTitle = b.offerTitle || b.offerType || "Booking";

  const customerName = customerNameFrom(customer);
  const customerChildName = customerChildNameFrom(customer);

  const bookingRefId = String(b.bookingId || b._id || "").trim();
  const rowIdBase = String(b._id || bookingRefId || "").trim();

  if (!bookingRefId) return items;

  const invNo = b.invoiceNumber || b.invoiceNo || null;
  const invDate = b.invoiceDate || null;

  const cancNo = b.cancellationNo || b.cancellationNumber || null;
  const cancDate = b.cancelDate || b.cancellationDate || null;

  const storNo = b.stornoNo || b.stornoNumber || null;
  const storDate = b.stornoDate || null;

  const statusLower = String(b.status || "").toLowerCase();

  const textForType =
    `${b.offerTitle || ""} ${b.offerType || ""}`.toLowerCase();
  const isHoliday = /camp|feriencamp|holiday|powertraining|power training/.test(
    textForType,
  );

  const issuedParticipation = invDate || b.createdAt || b.date || null;

  const refMeta = b && typeof b.meta === "object" ? b.meta : {};
  const stateMeta = state && typeof state.meta === "object" ? state.meta : {};
  const meta = { ...refMeta, ...stateMeta };

  const voucherCode = String(meta.voucherCode || meta.voucher || "").trim();
  const voucherDiscount = Number(meta.voucherDiscount || 0) || 0;
  const totalDiscount = Number(meta.totalDiscount || 0) || 0;
  const finalPrice =
    Number(meta.finalPrice) ||
    (b.priceAtBooking != null ? Number(b.priceAtBooking) : 0);

  if (invNo || invDate || isHoliday) {
    items.push({
      id: `inv:${rowIdBase}`,
      bookingId: bookingRefId,
      customerId: String(customer._id),
      type: "participation",
      title: `${baseTitle} – Teilnahmebestätigung`,
      issuedAt: issuedParticipation ? toISO(issuedParticipation) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType: b.offerType || undefined,
      amount: b.priceAtBooking != null ? Number(b.priceAtBooking) : undefined,
      currency: b.currency || "EUR",
      customerNumber: customer.userId,
      customerName: customerName || undefined,
      customerChildName: customerChildName || undefined,
      invoiceNo: invNo || undefined,
      invoiceNumber: invNo || undefined,
      voucherCode: voucherCode || undefined,
      voucherDiscount,
      totalDiscount,
      finalPrice,
      href: `/api/admin/bookings/${encodeURIComponent(
        bookingRefId,
      )}/documents/participation`,
      exportHref: `/api/admin/customers/${encodeURIComponent(
        String(customer._id),
      )}/bookings/${encodeURIComponent(bookingRefId)}/participation.pdf`,
    });
  }

  const issuedCancellation = cancDate || b.updatedAt || b.createdAt || null;
  const hasStorno = Boolean(storNo || storDate || statusLower === "storno");
  const hasCancellation = Boolean(
    cancNo || cancDate || statusLower === "cancelled",
  );

  if (!isHoliday && !hasStorno && hasCancellation) {
    items.push({
      id: `can:${rowIdBase}`,
      bookingId: bookingRefId,
      customerId: String(customer._id),
      type: "cancellation",
      title: `${baseTitle} – Kündigungsbestätigung`,
      issuedAt: issuedCancellation ? toISO(issuedCancellation) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType: b.offerType || undefined,
      customerNumber: customer.userId,
      customerName: customerName || undefined,
      customerChildName: customerChildName || undefined,
      cancellationNo: cancNo || undefined,
      href: `/api/admin/bookings/${encodeURIComponent(
        bookingRefId,
      )}/documents/cancellation`,
      exportHref: `/api/admin/customers/${encodeURIComponent(
        String(customer._id),
      )}/bookings/${encodeURIComponent(bookingRefId)}/cancellation.pdf`,
    });
  }

  const issuedStorno = storDate || cancDate || null;

  if (storNo || storDate || statusLower === "storno") {
    items.push({
      id: `sto:${rowIdBase}`,
      bookingId: bookingRefId,
      customerId: String(customer._id),
      type: "storno",
      title: `${baseTitle} – Storno-Rechnung`,
      issuedAt: issuedStorno ? toISO(issuedStorno) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType: b.offerType || undefined,
      amount: b.stornoAmount != null ? Number(b.stornoAmount) : undefined,
      currency: b.currency || "EUR",
      customerNumber: customer.userId,
      customerName: customerName || undefined,
      customerChildName: customerChildName || undefined,
      stornoNo: storNo || undefined,
      stornoNumber: storNo || undefined,
      href: `/api/admin/bookings/${encodeURIComponent(
        bookingRefId,
      )}/documents/storno`,
      exportHref: `/api/admin/customers/${encodeURIComponent(
        String(customer._id),
      )}/bookings/${encodeURIComponent(bookingRefId)}/storno.pdf`,
    });
  }

  if (DEBUG_INVOICES) {
    console.log("[DOC_FROM_BOOKING]", {
      bookingId: b._id,
      bookingRefId,
      offerTitle: b.offerTitle,
      invoiceDate: b.invoiceDate,
      createdAt: b.createdAt,
      cancelDate: b.cancelDate || null,
      stornoDate: b.stornoDate || null,
      isHoliday,
      issuedParticipation,
      status: statusLower,
      hasStorno,
      hasCancellation,
      customerNumber: customer.userId,
      customerName,
      customerChildName,
      invNo,
      cancNo,
      storNo,
    });
  }

  const creditNo = String(meta.creditNoteNo || "").trim();
  const creditDateRaw = String(meta.creditNoteDate || "").trim();
  const creditIssued =
    creditDateRaw || b.returnedAt || state?.returnedAt || null;

  if (creditNo) {
    items.push({
      id: `cr:${rowIdBase}:${creditNo.replace(/[^\w.-]+/g, "_")}`,
      bookingId: bookingRefId,
      customerId: String(customer._id),
      type: "creditnote",
      title: `${baseTitle} – Gutschrift`,
      issuedAt: creditIssued ? toISO(creditIssued) : undefined,
      offerTitle: b.offerTitle || undefined,
      offerType: b.offerType || undefined,
      amount:
        meta.creditNoteAmount != null
          ? Number(meta.creditNoteAmount)
          : undefined,
      currency: b.currency || "EUR",
      customerNumber: customer.userId,
      customerName: customerName || undefined,
      customerChildName: customerChildName || undefined,
      creditNoteNo: creditNo,
      href: `/api/admin/customers/bookings/${encodeURIComponent(
        bookingRefId,
      )}/credit-note.pdf`,
      fileName: `Gutschrift-${creditNo.replace(/[^\w.-]+/g, "_")}`,
    });
  }

  return items;
}

// function docsFromBooking(customer, b, state) {
//   const items = [];
//   const baseTitle = b.offerTitle || b.offerType || "Booking";

//   const customerName = customerNameFrom(customer);
//   const customerChildName = customerChildNameFrom(customer);

//   const bookingRefId = String(b.bookingId || b._id || "").trim();
//   const rowIdBase = String(b._id || bookingRefId || "").trim();

//   if (!bookingRefId) return items;

//   const invNo = b.invoiceNumber || b.invoiceNo || null;
//   const invDate = b.invoiceDate || null;

//   const cancNo = b.cancellationNo || b.cancellationNumber || null;
//   const cancDate = b.cancelDate || b.cancellationDate || null;

//   const storNo = b.stornoNo || b.stornoNumber || null;
//   const storDate = b.stornoDate || null;

//   const statusLower = String(b.status || "").toLowerCase();

//   const textForType =
//     `${b.offerTitle || ""} ${b.offerType || ""}`.toLowerCase();
//   const isHoliday = /camp|feriencamp|holiday|powertraining|power training/.test(
//     textForType,
//   );

//   const issuedParticipation = invDate || b.createdAt || b.date || null;

//   if (invNo || invDate || isHoliday) {
//     items.push({
//       id: `inv:${rowIdBase}`,
//       bookingId: bookingRefId,
//       customerId: String(customer._id),
//       type: "participation",
//       title: `${baseTitle} – Teilnahmebestätigung`,
//       issuedAt: issuedParticipation ? toISO(issuedParticipation) : undefined,
//       offerTitle: b.offerTitle || undefined,
//       offerType: b.offerType || undefined,
//       amount: b.priceAtBooking != null ? Number(b.priceAtBooking) : undefined,
//       currency: b.currency || "EUR",
//       customerNumber: customer.userId,
//       customerName: customerName || undefined,
//       customerChildName: customerChildName || undefined,
//       invoiceNo: invNo || undefined,
//       invoiceNumber: invNo || undefined,
//       href: `/api/admin/bookings/${encodeURIComponent(
//         bookingRefId,
//       )}/documents/participation`,
//       exportHref: `/api/admin/customers/${encodeURIComponent(
//         String(customer._id),
//       )}/bookings/${encodeURIComponent(bookingRefId)}/participation.pdf`,
//     });
//   }

//   const issuedCancellation = cancDate || b.updatedAt || b.createdAt || null;
//   const hasStorno = Boolean(storNo || storDate || statusLower === "storno");
//   const hasCancellation = Boolean(
//     cancNo || cancDate || statusLower === "cancelled",
//   );

//   if (!isHoliday && !hasStorno && hasCancellation) {
//     items.push({
//       id: `can:${rowIdBase}`,
//       bookingId: bookingRefId,
//       customerId: String(customer._id),
//       type: "cancellation",
//       title: `${baseTitle} – Kündigungsbestätigung`,
//       issuedAt: issuedCancellation ? toISO(issuedCancellation) : undefined,
//       offerTitle: b.offerTitle || undefined,
//       offerType: b.offerType || undefined,
//       customerNumber: customer.userId,
//       customerName: customerName || undefined,
//       customerChildName: customerChildName || undefined,
//       cancellationNo: cancNo || undefined,
//       href: `/api/admin/bookings/${encodeURIComponent(
//         bookingRefId,
//       )}/documents/cancellation`,
//       exportHref: `/api/admin/customers/${encodeURIComponent(
//         String(customer._id),
//       )}/bookings/${encodeURIComponent(bookingRefId)}/cancellation.pdf`,
//     });
//   }

//   const issuedStorno = storDate || cancDate || null;

//   if (storNo || storDate || statusLower === "storno") {
//     items.push({
//       id: `sto:${rowIdBase}`,
//       bookingId: bookingRefId,
//       customerId: String(customer._id),
//       type: "storno",
//       title: `${baseTitle} – Storno-Rechnung`,
//       issuedAt: issuedStorno ? toISO(issuedStorno) : undefined,
//       offerTitle: b.offerTitle || undefined,
//       offerType: b.offerType || undefined,
//       amount: b.stornoAmount != null ? Number(b.stornoAmount) : undefined,
//       currency: b.currency || "EUR",
//       customerNumber: customer.userId,
//       customerName: customerName || undefined,
//       customerChildName: customerChildName || undefined,
//       stornoNo: storNo || undefined,
//       stornoNumber: storNo || undefined,
//       href: `/api/admin/bookings/${encodeURIComponent(
//         bookingRefId,
//       )}/documents/storno`,
//       exportHref: `/api/admin/customers/${encodeURIComponent(
//         String(customer._id),
//       )}/bookings/${encodeURIComponent(bookingRefId)}/storno.pdf`,
//     });
//   }

//   if (DEBUG_INVOICES) {
//     console.log("[DOC_FROM_BOOKING]", {
//       bookingId: b._id,
//       bookingRefId,
//       offerTitle: b.offerTitle,
//       invoiceDate: b.invoiceDate,
//       createdAt: b.createdAt,
//       cancelDate: b.cancelDate || null,
//       stornoDate: b.stornoDate || null,
//       isHoliday,
//       issuedParticipation,
//       status: statusLower,
//       hasStorno,
//       hasCancellation,
//       customerNumber: customer.userId,
//       customerName,
//       customerChildName,
//       invNo,
//       cancNo,
//       storNo,
//     });
//   }

//   const refMeta = b && typeof b.meta === "object" ? b.meta : {};
//   const stateMeta = state && typeof state.meta === "object" ? state.meta : {};
//   const meta = { ...refMeta, ...stateMeta };

//   const creditNo = String(meta.creditNoteNo || "").trim();
//   const creditDateRaw = String(meta.creditNoteDate || "").trim();
//   const creditIssued =
//     creditDateRaw || b.returnedAt || state?.returnedAt || null;

//   if (creditNo) {
//     items.push({
//       id: `cr:${rowIdBase}:${creditNo.replace(/[^\w.-]+/g, "_")}`,
//       bookingId: bookingRefId,
//       customerId: String(customer._id),
//       type: "creditnote",
//       title: `${baseTitle} – Gutschrift`,
//       issuedAt: creditIssued ? toISO(creditIssued) : undefined,
//       offerTitle: b.offerTitle || undefined,
//       offerType: b.offerType || undefined,
//       amount:
//         meta.creditNoteAmount != null
//           ? Number(meta.creditNoteAmount)
//           : undefined,
//       currency: b.currency || "EUR",
//       customerNumber: customer.userId,
//       customerName: customerName || undefined,
//       customerChildName: customerChildName || undefined,
//       creditNoteNo: creditNo,
//       href: `/api/admin/customers/bookings/${encodeURIComponent(
//         bookingRefId,
//       )}/credit-note.pdf`,
//       fileName: `Gutschrift-${creditNo.replace(/[^\w.-]+/g, "_")}`,
//     });
//   }

//   return items;
// }

function issuedTime(v) {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function docNoKey(it) {
  return String(docNoFrom(it) || "").trim();
}

function docNoCompare(a, b) {
  return docNoKey(a).localeCompare(docNoKey(b), "de", {
    numeric: true,
    sensitivity: "base",
  });
}

function parseSelectedIds(query) {
  return new Set(
    String(query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function docStageOf(item) {
  return String(item?.stage || item?.lastDunningStage || "")
    .trim()
    .toLowerCase();
}

function docIdKeys(item) {
  const id = String(item?.id || "").trim();
  const type = String(item?.type || "")
    .trim()
    .toLowerCase();
  const bookingId = String(item?.bookingId || "").trim();
  const docNo = String(docNoFrom(item) || "")
    .trim()
    .toLowerCase();
  const stage = docStageOf(item);

  return [
    id,
    [type, bookingId].filter(Boolean).join("|"),
    [type, bookingId, docNo].filter(Boolean).join("|"),
    [type, bookingId, stage].filter(Boolean).join("|"),
    [type, bookingId, docNo, stage].filter(Boolean).join("|"),
  ].filter(Boolean);
}

function selectedIdKeys(selectedIds) {
  const out = new Set();

  for (const raw of selectedIds) {
    const id = String(raw || "").trim();
    if (!id) continue;

    out.add(id);

    if (id.startsWith("inv:")) {
      out.add(`participation|${id.slice(4)}`);
    }

    if (id.startsWith("can:")) {
      out.add(`cancellation|${id.slice(4)}`);
    }

    if (id.startsWith("sto:")) {
      out.add(`storno|${id.slice(4)}`);
    }

    if (id.startsWith("cr:")) {
      const rest = id.slice(3);
      const firstColon = rest.indexOf(":");

      if (firstColon >= 0) {
        const bookingKey = rest.slice(0, firstColon).trim();
        const creditNo = rest
          .slice(firstColon + 1)
          .trim()
          .toLowerCase();

        out.add(`creditnote|${bookingKey}`);
        out.add(`creditnote|${bookingKey}|${creditNo}`);
      }
    }

    if (id.startsWith("dunning:")) {
      const rest = id.slice(4);
      const parts = rest.split(":").map((v) => String(v || "").trim());
      const bookingKey = parts[0] || "";
      const stage = String(parts[1] || "").toLowerCase();

      if (bookingKey) out.add(`dunning|${bookingKey}`);
      if (bookingKey && stage) out.add(`dunning|${bookingKey}|${stage}`);
    }
  }

  return out;
}

function filterBySelectedIds(items, selectedIds) {
  if (!selectedIds.size) return items;

  const keys = selectedIdKeys(selectedIds);

  return items.filter((item) => {
    return docIdKeys(item).some((key) => keys.has(key));
  });
}

router.get("/", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const { Customer, Booking } = getModels(req);

    const result = await buildInvoiceList({
      owner,
      Customer,
      Booking,
      query: req.query,
    });

    if (!result) throw new Error("buildInvoiceList returned undefined");

    const { items, total, page, limit } = result;
    return res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    console.error("[adminInvoices] GET / error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

function bookingBaseAmount(booking) {
  if (booking?.priceMonthly != null) return Number(booking.priceMonthly) || 0;
  if (booking?.priceAtBooking != null)
    return Number(booking.priceAtBooking) || 0;
  if (booking?.price != null) return Number(booking.price) || 0;
  return 0;
}

function bookingInvoiceNo(booking) {
  return String(booking?.invoiceNumber || booking?.invoiceNo || "").trim();
}

function invoiceRefByNumber(booking, invoiceNo) {
  const refs = Array.isArray(booking?.invoiceRefs) ? booking.invoiceRefs : [];
  const wanted = String(invoiceNo || "").trim();
  if (!wanted) return {};
  return refs.find((ref) => String(ref?.number || "").trim() === wanted) || {};
}

function resolveGlobalDiscountMeta(booking, invoiceNo, type) {
  const meta =
    booking?.meta && typeof booking.meta === "object" ? booking.meta : {};

  const discount =
    booking?.discount && typeof booking.discount === "object"
      ? booking.discount
      : meta?.discount && typeof meta.discount === "object"
        ? meta.discount
        : {};

  const ref = invoiceRefByNumber(booking, invoiceNo);

  if (type === "invoice") {
    const amount = Number(
      ref?.finalPrice ??
        ref?.amount ??
        booking?.priceMonthly ??
        booking?.priceAtBooking ??
        booking?.price ??
        0,
    );

    return {
      voucherCode: "",
      voucherDiscount: 0,
      totalDiscount: 0,
      finalPrice: Number.isFinite(amount) ? amount : 0,
    };
  }

  if (type === "participation") {
    const voucherDiscount = Number(
      ref?.voucherDiscount ??
        meta?.voucherDiscount ??
        discount?.voucherDiscount ??
        booking?.voucherDiscount ??
        0,
    );

    const totalDiscount = Number(
      ref?.totalDiscount ??
        meta?.totalDiscount ??
        discount?.totalDiscount ??
        booking?.totalDiscount ??
        voucherDiscount ??
        0,
    );

    const finalPrice = Number(
      ref?.finalPrice ??
        meta?.finalPrice ??
        discount?.finalPrice ??
        booking?.finalPrice ??
        booking?.priceAtBooking ??
        booking?.priceMonthly ??
        booking?.price ??
        0,
    );

    return {
      voucherCode: String(
        ref?.voucherCode ||
          ref?.code ||
          meta?.voucherCode ||
          meta?.voucher ||
          discount?.voucherCode ||
          booking?.voucherCode ||
          "",
      ).trim(),
      voucherDiscount: Number.isFinite(voucherDiscount) ? voucherDiscount : 0,
      totalDiscount: Number.isFinite(totalDiscount) ? totalDiscount : 0,
      finalPrice: Number.isFinite(finalPrice) ? finalPrice : 0,
    };
  }

  return {
    voucherCode: "",
    voucherDiscount: 0,
    totalDiscount: 0,
    finalPrice: 0,
  };
}

function recurringInvoiceHref(item) {
  return `/api/admin/customers/${encodeURIComponent(
    String(item.customerId || ""),
  )}/documents/billing-invoices/${encodeURIComponent(
    String(item.documentId || ""),
  )}/download`;
}

function mapRecurringInvoiceDocToRow(doc, customer, booking) {
  const customerName = customerNameFrom(customer);
  const customerChildName = customerChildNameFrom(customer);
  const invoiceNo = String(doc?.invoiceNo || "").trim();
  const discountMeta = resolveGlobalDiscountMeta(booking, invoiceNo, "invoice");

  return {
    id: `invoice:${String(doc._id)}`,
    documentId: String(doc._id),
    bookingId: String(doc.bookingId || ""),
    customerId: String(doc.customerId || customer?._id || ""),
    type: "invoice",
    title: `Rechnung – ${booking?.offerTitle || doc?.offerTitle || "Angebot"}`,
    issuedAt: doc.invoiceDate || doc.sentAt || doc.createdAt || null,
    offerTitle: booking?.offerTitle || doc?.offerTitle || undefined,
    offerType: booking?.offerType || undefined,
    amount: bookingBaseAmount(booking),
    currency: booking?.currency || "EUR",
    customerNumber: customer?.userId || undefined,
    customerName: customerName || undefined,
    customerChildName: customerChildName || undefined,
    invoiceNo: invoiceNo || undefined,
    invoiceNumber: invoiceNo || undefined,
    invoiceDate: doc.invoiceDate || null,
    href: recurringInvoiceHref({
      customerId: String(doc.customerId || customer?._id || ""),
      documentId: String(doc._id || ""),
    }),
    exportHref: recurringInvoiceHref({
      customerId: String(doc.customerId || customer?._id || ""),
      documentId: String(doc._id || ""),
    }),
    fileName: doc.fileName || undefined,
    filePath: doc.filePath || undefined,
    paymentStatus: "paid",
    voucherCode: discountMeta.voucherCode,
    voucherDiscount: discountMeta.voucherDiscount,
    totalDiscount: discountMeta.totalDiscount,
    finalPrice: discountMeta.finalPrice,
  };
}

async function loadRecurringInvoiceRows({ owner, Customer, BillingDocument }) {
  const invoiceDocs = await BillingDocument.find({
    owner: String(owner),
    kind: "invoice",
    voidedAt: null,
  })
    .sort({ invoiceDate: -1, createdAt: -1 })
    .lean();

  if (!invoiceDocs.length) return [];

  const customerIds = [
    ...new Set(
      invoiceDocs.map((d) => String(d.customerId || "").trim()).filter(Boolean),
    ),
  ];

  const customers = customerIds.length
    ? await Customer.find(
        { owner, _id: { $in: customerIds } },
        {
          userId: 1,
          "parent.firstName": 1,
          "parent.lastName": 1,
          "parent.email": 1,
          "child.firstName": 1,
          "child.lastName": 1,
          bookings: 1,
        },
      ).lean()
    : [];

  const customerMap = new Map(customers.map((c) => [String(c._id), c]));
  const out = [];

  for (const doc of invoiceDocs) {
    const customer = customerMap.get(String(doc.customerId || ""));
    if (!customer) continue;

    const booking =
      (Array.isArray(customer.bookings) ? customer.bookings : []).find(
        (b) =>
          String(b?.bookingId || b?._id || "") === String(doc.bookingId || ""),
      ) || null;

    if (!booking) continue;

    const primaryBookingInvoiceNo = bookingInvoiceNo(booking);
    const invoiceNo = String(doc.invoiceNo || "").trim();

    if (
      invoiceNo &&
      primaryBookingInvoiceNo &&
      invoiceNo === primaryBookingInvoiceNo
    ) {
      continue;
    }

    out.push(mapRecurringInvoiceDocToRow(doc, customer, booking));
  }

  return out;
}

async function buildInvoiceList({
  owner,
  Customer,
  Booking,
  query,
  hardLimit,
}) {
  const page = clamp(query.page, 1, 10_000);
  const limit = clamp(query.limit, 1, hardLimit ?? 200);
  const skip = (page - 1) * limit;

  const typeStr = String(query.type || "").trim();
  const typeSet = new Set(
    typeStr
      ? typeStr
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : ["participation", "invoice", "cancellation", "storno", "creditnote"],
  );
  if (typeSet.has("creditnote")) typeSet.add("creditnote");

  const q = String(query.q || "").trim();

  const fromStr = normalizeFilterDate(query.from);
  const toStr = normalizeFilterDate(query.to);

  const fromDate = fromStr ? new Date(`${fromStr}T00:00:00`) : null;
  const toDate = toStr ? new Date(`${toStr}T23:59:59.999`) : null;

  const sort = normalizeSort(query.sort);
  const selectedIds = parseSelectedIds(query);

  const customers = await Customer.find(
    { owner },
    {
      userId: 1,
      "parent.firstName": 1,
      "parent.lastName": 1,
      "parent.email": 1,
      "child.firstName": 1,
      "child.lastName": 1,
      bookings: 1,
    },
  ).lean();

  const bookingIds = [];
  for (const c of customers) {
    for (const b of c.bookings || []) {
      if (b?.bookingId && mongoose.isValidObjectId(String(b.bookingId))) {
        bookingIds.push(new Types.ObjectId(String(b.bookingId)));
      }
    }
  }

  const bookingStateDocs = bookingIds.length
    ? await Booking.find(
        { owner, _id: { $in: bookingIds } },
        {
          paymentStatus: 1,
          paidAt: 1,
          returnedAt: 1,
          returnBankFee: 1,
          returnNote: 1,
          dunningEvents: 1,
          collectionStatus: 1,
          handedOverAt: 1,
          handedOverNote: 1,
          meta: 1,
          stripe: 1,
          createdAt: 1,
        },
      ).lean()
    : [];

  const bookingStateMap = new Map(
    bookingStateDocs.map((b) => [String(b._id), b]),
  );

  const recurringInvoiceRows = await loadRecurringInvoiceRows({
    owner,
    Customer,
    BillingDocument,
  });

  console.log(
    "[adminInvoices][recurringRows]",
    recurringInvoiceRows.map((r) => ({
      id: r.id,
      type: r.type,
      invoiceNo: r.invoiceNo,
      bookingId: r.bookingId,
      customerId: r.customerId,
      title: r.title,
    })),
  );

  const all = [];

  for (const c of customers) {
    for (const b of c.bookings || []) {
      const state = bookingStateMap.get(String(b.bookingId || b._id || ""));
      const docs = docsFromBooking(c, b, state);

      for (const r of docs) {
        if (!typeSet.has(String(r.type || "").toLowerCase())) continue;

        const blob = [
          c.parent?.firstName,
          c.parent?.lastName,
          c.parent?.email,
          c.child?.firstName,
          c.child?.lastName,
          r.title,
          r.offerTitle,
          r.offerType,
          r.bookingId,
        ]
          .filter(Boolean)
          .join(" ");

        const customerNumber = c.userId ?? r.customerNumber ?? "";
        const docNo = docNoFrom(r);

        if (!matchesInvoiceQuery({ q, customerNumber, docNo, blob })) continue;

        if (r.issuedAt && (fromDate || toDate)) {
          const t = new Date(r.issuedAt).getTime();
          if (!Number.isNaN(t)) {
            if (fromDate && t < fromDate.getTime()) continue;
            if (toDate && t > toDate.getTime()) continue;
          }
        }

        const state = bookingStateMap.get(String(r.bookingId || ""));

        if (state) {
          const events = Array.isArray(state.dunningEvents)
            ? state.dunningEvents
            : [];

          const lastEvent = events.length
            ? [...events].sort((a, b) => {
                const ta = new Date(a?.sentAt || 0).getTime();
                const tb = new Date(b?.sentAt || 0).getTime();
                return tb - ta;
              })[0]
            : null;

          const sentStages = [];
          const docByStage = {};
          for (const ev of events) {
            const st = String(ev?.stage || "").trim();
            if (!st) continue;
            if (!sentStages.includes(st)) sentStages.push(st);
            if (!docByStage[st] && ev?.documentId) {
              docByStage[st] = String(ev.documentId);
            }
          }

          const st = String(state.paymentStatus || "").trim();
          const paidAt = state.paidAt || null;

          r.paidAt = paidAt;
          r.paymentStatus = st || (paidAt ? "paid" : "open");
          r.paymentIntentId =
            String(state?.stripe?.paymentIntentId || "").trim() || null;
          r.returnedAt = state.returnedAt || null;
          r.returnBankFee = Number(state.returnBankFee || 0);
          r.returnNote = state.returnNote || "";
          r.dunningCount = events.length;
          r.lastDunningStage = lastEvent?.stage || null;
          r.lastDunningSentAt = lastEvent?.sentAt || null;
          r.nextDunningStage =
            (state.paymentStatus || "open") === "paid"
              ? null
              : nextDunningStage(events);

          r.dunningSentStages = sentStages;
          r.dunningDocIdByStage = docByStage;

          r.collectionStatus = state.collectionStatus || "none";
          r.handedOverAt = state.handedOverAt || null;
          r.handedOverNote = state.handedOverNote || "";

          const meta =
            state.meta && typeof state.meta === "object" ? state.meta : {};
          r.creditNoteEmailSentAt =
            String(meta.creditNoteEmailSentAt || "").trim() || null;
          r.creditNoteDate = String(meta.creditNoteDate || "").trim() || null;
          r.creditNoteAmount =
            meta.creditNoteAmount != null
              ? Number(meta.creditNoteAmount)
              : null;
          r.refundId = String(meta.stripeRefundId || "").trim() || null;

          r.stripeMode = String(state?.stripe?.mode || "").trim();
          r.subscriptionId =
            String(state?.stripe?.subscriptionId || "").trim() || null;
          r.paymentIntentId =
            String(state?.stripe?.paymentIntentId || "").trim() || null;

          r.contractSignedAt =
            meta.contractSignedAt != null
              ? String(meta.contractSignedAt)
              : null;
          r.createdAt = state?.createdAt ? toISO(state.createdAt) : null;
        } else {
          r.paymentStatus = "open";
          r.dunningCount = 0;
          r.lastDunningStage = null;
          r.lastDunningSentAt = null;
          r.nextDunningStage = "reminder";
          r.dunningSentStages = [];
          r.dunningDocIdByStage = {};
          r.collectionStatus = "none";
          r.handedOverAt = null;
          r.handedOverNote = "";
        }
        console.log("[adminInvoices][pushRecurring]", {
          id: r.id,
          type: r.type,
          invoiceNo: r.invoiceNo,
          q,
        });

        all.push(r);
      }
    }
  }

  // for (const r of recurringInvoiceRows) {
  //   if (!typeSet.has(String(r.type || "").toLowerCase())) continue;

  //   const blob = [
  //     r.customerName,
  //     r.customerChildName,
  //     r.title,
  //     r.offerTitle,
  //     r.offerType,
  //     r.bookingId,
  //   ]
  //     .filter(Boolean)
  //     .join(" ");

  //   const customerNumber = r.customerNumber ?? "";
  //   const docNo = docNoFrom(r);

  //   if (!matchesInvoiceQuery({ q, customerNumber, docNo, blob })) continue;

  //   if (r.issuedAt && (fromDate || toDate)) {
  //     const t = new Date(r.issuedAt).getTime();
  //     if (!Number.isNaN(t)) {
  //       if (fromDate && t < fromDate.getTime()) continue;
  //       if (toDate && t > toDate.getTime()) continue;
  //     }
  //   }

  //   all.push(r);
  // }

  // console.log(
  //   "[adminInvoices][allBeforeFilter]",
  //   all.map((r) => ({
  //     id: r.id,
  //     type: r.type,
  //     invoiceNo: r.invoiceNo,
  //     title: r.title,
  //   })),
  // );

  for (const r of recurringInvoiceRows) {
    const rowType = String(r.type || "").toLowerCase();
    const hasType = typeSet.has(rowType);

    const blob = [
      r.customerName,
      r.customerChildName,
      r.title,
      r.offerTitle,
      r.offerType,
      r.bookingId,
    ]
      .filter(Boolean)
      .join(" ");

    const customerNumber = r.customerNumber ?? "";
    const docNo = docNoFrom(r);
    const matchesQ = matchesInvoiceQuery({ q, customerNumber, docNo, blob });

    let inRange = true;
    if (r.issuedAt && (fromDate || toDate)) {
      const t = new Date(r.issuedAt).getTime();
      if (!Number.isNaN(t)) {
        if (fromDate && t < fromDate.getTime()) inRange = false;
        if (toDate && t > toDate.getTime()) inRange = false;
      }
    }

    console.log("[adminInvoices][recurring-check]", {
      id: r.id,
      type: rowType,
      invoiceNo: r.invoiceNo,
      q,
      typeStr,
      typeSet: [...typeSet],
      hasType,
      matchesQ,
      inRange,
      issuedAt: r.issuedAt,
    });

    if (!hasType) continue;
    if (!matchesQ) continue;
    if (!inRange) continue;

    console.log("[adminInvoices][pushRecurring]", {
      id: r.id,
      invoiceNo: r.invoiceNo,
    });

    all.push(r);
  }

  let filtered = filterBySelectedIds(all, selectedIds);

  filtered.sort((a, b) => {
    if (sort.field === "issuedAt") {
      const ta = issuedTime(a.issuedAt);
      const tb = issuedTime(b.issuedAt);

      if (ta !== tb) return (ta - tb) * sort.dir;

      const dn = docNoCompare(a, b);
      if (dn !== 0) return dn * sort.dir;

      return String(a.id || "").localeCompare(String(b.id || "")) * sort.dir;
    }

    const fa = a[sort.field] ?? "";
    const fb = b[sort.field] ?? "";
    if (fa === fb) return 0;
    return fa > fb ? sort.dir : -sort.dir;
  });

  const total = filtered.length;
  const items = filtered.slice(skip, skip + limit);

  return { items, total, page, limit };
}

router.get("/csv", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const { Customer, Booking } = getModels(req);
    const selectedIds = parseSelectedIds(req.query);

    let items = await buildExportListWithDunning({
      owner,
      Customer,
      Booking,
      query: req.query,
      hardLimit: 10000,
      deps: {
        buildInvoiceList,
        BillingDocument,
        clamp,
        normalizeFilterDate,
        normalizeSort,
        issuedTime,
        docNoCompare,
        norm,
        isDigitsOnly,
      },
    });

    items = filterBySelectedIds(items, selectedIds);

    const csv = buildCsvText(items, {
      env: process.env,
      docNoFrom,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="invoices.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    console.error("[adminInvoices] GET /csv error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

function safeFileNamePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 120);
}

function fileNameBaseFromItem(item) {
  const docNo = String(docNoFrom(item) || "").trim();
  return safeFileNamePart(
    item.fileName ||
      item.title ||
      `${item.type}${docNo ? `-${docNo}` : ""}` ||
      `${item.type}-${item.bookingId || "document"}`,
  );
}

function buildPdfUrlForItem(item, origin) {
  if (item?.exportHref) {
    return `${origin}${item.exportHref}`;
  }

  if (item?.href) {
    return `${origin}${item.href}`;
  }

  if (!item?.customerId || !item?.bookingId) return "";

  const typeToPdf = (type) =>
    type === "cancellation"
      ? "cancellation"
      : type === "storno"
        ? "storno"
        : type === "creditnote"
          ? "credit-note"
          : "participation";

  return (
    `${origin}/api/admin/customers/${encodeURIComponent(
      item.customerId,
    )}/bookings/${encodeURIComponent(item.bookingId)}/` +
    `${typeToPdf(item.type)}.pdf`
  );
}

// async function appendInvoicePdfToArchive({ archive, item, origin, provider }) {
//   const pdfUrl = buildPdfUrlForItem(item, origin);

//   if (!pdfUrl) {
//     throw new Error("missing customerId/bookingId and href");
//   }

//   const response = await fetch(pdfUrl, {
//     headers: provider ? { "x-provider-id": provider } : {},
//     redirect: "follow",
//   });

//   if (!response.ok) {
//     const msg = `Fetch failed (${response.status}) for ${pdfUrl}`;
//     archive.append(Buffer.from(msg, "utf8"), {
//       name: `error-${item.bookingId || "unknown"}.txt`,
//     });
//     return;
//   }

//   const contentType = (
//     response.headers.get("content-type") || ""
//   ).toLowerCase();
//   const buf = Buffer.from(await response.arrayBuffer());
//   const rawName = fileNameBaseFromItem(item);
//   const hasPdfExt = /\.pdf$/i.test(rawName);
//   const ext = contentType.includes("pdf") ? (hasPdfExt ? "" : ".pdf") : ".bin";

//   archive.append(buf, { name: `${rawName}${ext}` });
// }

async function appendInvoicePdfToArchive({ archive, item, origin, provider }) {
  const isRecurringInvoice = String(item?.type || "").trim() === "invoice";
  const filePath = String(item?.filePath || "").trim();

  if (isRecurringInvoice && filePath) {
    try {
      const buf = await fs.readFile(filePath);
      const rawName = fileNameBaseFromItem(item);
      const name = /\.pdf$/i.test(rawName) ? rawName : `${rawName}.pdf`;
      archive.append(buf, { name });
      return;
    } catch (e) {
      const msg = `Read failed for ${filePath}: ${(e && e.message) || e}`;
      archive.append(Buffer.from(msg, "utf8"), {
        name: `error-${item.bookingId || "unknown"}.txt`,
      });
      return;
    }
  }

  const pdfUrl = buildPdfUrlForItem(item, origin);

  if (!pdfUrl) {
    throw new Error("missing customerId/bookingId and href");
  }

  const response = await fetch(pdfUrl, {
    headers: provider ? { "x-provider-id": provider } : {},
    redirect: "follow",
  });

  if (!response.ok) {
    const msg = `Fetch failed (${response.status}) for ${pdfUrl}`;
    archive.append(Buffer.from(msg, "utf8"), {
      name: `error-${item.bookingId || "unknown"}.txt`,
    });
    return;
  }

  const contentType = (
    response.headers.get("content-type") || ""
  ).toLowerCase();
  const buf = Buffer.from(await response.arrayBuffer());
  const rawName = fileNameBaseFromItem(item);
  const hasPdfExt = /\.pdf$/i.test(rawName);
  const ext = contentType.includes("pdf") ? (hasPdfExt ? "" : ".pdf") : ".bin";

  archive.append(buf, { name: `${rawName}${ext}` });
}

router.get("/zip", async (req, res) => {
  try {
    const archiver = require("archiver");

    const owner = requireOwner(req, res);
    if (!owner) return;

    const { Customer, Booking } = getModels(req);
    const selectedIds = parseSelectedIds(req.query);

    let items = await buildExportListWithDunning({
      owner,
      Customer,
      Booking,
      query: { ...req.query, page: 1, limit: 10000 },
      hardLimit: 10000,
      deps: {
        buildInvoiceList,
        BillingDocument,
        clamp,
        normalizeFilterDate,
        normalizeSort,
        issuedTime,
        docNoCompare,
        norm,
        isDigitsOnly,
      },
    });

    items = filterBySelectedIds(items, selectedIds);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="invoices.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      throw err;
    });
    archive.pipe(res);

    const origin = `${req.protocol}://${req.get("host")}`;
    const provider = req.get("x-provider-id") || "";

    const csv = buildCsvText(items, {
      env: process.env,
      docNoFrom,
    });

    archive.append(Buffer.from(csv, "utf8"), { name: "invoices.csv" });

    for (const item of items) {
      try {
        await appendInvoicePdfToArchive({
          archive,
          item,
          origin,
          provider,
        });
      } catch (e) {
        const msg = `Error fetching booking ${item.bookingId}: ${
          (e && e.message) || e
        }`;
        archive.append(Buffer.from(msg, "utf8"), {
          name: `error-${item.bookingId || "unknown"}.txt`,
        });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("[adminInvoices] GET /zip error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

function parseMoney(v, fallback = 0) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function addDays(date, days) {
  const base = date instanceof Date ? date : new Date(date);
  const d = new Date(base);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function dunningStages() {
  return ["reminder", "dunning1", "dunning2", "final"];
}

function getLastDunningStage(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => {
    const ta = new Date(a?.sentAt || 0).getTime();
    const tb = new Date(b?.sentAt || 0).getTime();
    return tb - ta;
  });
  return sorted[0]?.stage || null;
}

function nextDunningStage(events) {
  const last = getLastDunningStage(events);
  const stages = dunningStages();
  if (!last) return "reminder";
  const idx = stages.indexOf(last);
  if (idx < 0) return "reminder";
  return stages[Math.min(idx + 1, stages.length - 1)];
}

function buildFeeSnapshot(booking, body = {}) {
  const returnBankFee =
    parseMoney(body.returnBankFee, null) ??
    parseMoney(booking?.returnBankFee, 0);

  const dunningFee = parseMoney(body.dunningFee, 0);
  const processingFee = parseMoney(body.processingFee, 0);
  const totalExtraFees = returnBankFee + dunningFee + processingFee;

  return {
    returnBankFee,
    dunningFee,
    processingFee,
    totalExtraFees,
    currency: "EUR",
  };
}

async function findCustomerAndBookingByBookingId({
  Customer,
  owner,
  bookingId,
}) {
  const customer = await Customer.findOne(
    { owner, "bookings.bookingId": bookingId },
    {
      userId: 1,
      parent: 1,
      child: 1,
      address: 1,
      bookings: 1,
    },
  );

  if (!customer) return { customer: null, bookingRef: null };

  const bookingRef =
    (customer.bookings || []).find(
      (b) => String(b.bookingId || "") === String(bookingId),
    ) || null;

  return { customer, bookingRef };
}

async function loadOwnedBooking({ Booking, owner, bookingId }) {
  return Booking.findOne({ _id: bookingId, owner });
}

async function findFirstSentDunningDoc({ owner, invoiceNo, stage }) {
  if (!invoiceNo || !stage) return null;
  return BillingDocument.findOne({
    owner: String(owner),
    kind: "dunning",
    invoiceNo: String(invoiceNo),
    stage: String(stage),
    sentAt: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .lean();
}

function buildItemSelectionKeys(item) {
  const type = String(item?.type || "")
    .trim()
    .toLowerCase();
  const id = String(item?.id || "").trim();
  const bookingId = String(item?.bookingId || "").trim();
  const docNo = String(docNoFrom(item) || "")
    .trim()
    .toLowerCase();
  const stage = String(item?.stage || item?.lastDunningStage || "")
    .trim()
    .toLowerCase();
  const documentId = String(item?.documentId || "").trim();

  return [
    id,
    [type, bookingId].filter(Boolean).join("|"),
    [type, bookingId, docNo].filter(Boolean).join("|"),
    [type, bookingId, stage].filter(Boolean).join("|"),
    [type, bookingId, documentId].filter(Boolean).join("|"),
  ].filter(Boolean);
}

function buildSelectedKeySet(selectedIds) {
  const out = new Set();

  for (const raw of selectedIds) {
    const id = String(raw || "").trim();
    if (!id) continue;

    out.add(id);

    if (id.startsWith("inv:")) {
      out.add(`participation|${id.slice(4)}`);
    }

    if (id.startsWith("can:")) {
      out.add(`cancellation|${id.slice(4)}`);
    }

    if (id.startsWith("sto:")) {
      out.add(`storno|${id.slice(4)}`);
    }

    if (id.startsWith("cr:")) {
      const rest = id.slice(3);
      const firstColon = rest.indexOf(":");

      if (firstColon >= 0) {
        const bookingKey = rest.slice(0, firstColon).trim();
        const creditNo = rest
          .slice(firstColon + 1)
          .trim()
          .toLowerCase();

        out.add(`creditnote|${bookingKey}`);
        out.add(`creditnote|${bookingKey}|${creditNo}`);
      }
    }

    if (id.startsWith("dun:")) {
      const rest = id.slice(4);
      const parts = rest.split(":").map((v) => String(v || "").trim());
      const bookingKey = parts[0] || "";
      const stage = String(parts[1] || "").toLowerCase();

      if (bookingKey) out.add(`dunning|${bookingKey}`);
      if (bookingKey && stage) out.add(`dunning|${bookingKey}|${stage}`);
    }
  }

  return out;
}

function filterBySelectedIds(items, selectedIds) {
  if (!selectedIds.size) return items;

  const selectedKeySet = buildSelectedKeySet(selectedIds);

  return items.filter((item) => {
    return buildItemSelectionKeys(item).some((key) => selectedKeySet.has(key));
  });
}

router.post("/:bookingId/mark-paid", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const bookingId = String(req.params.bookingId || "").trim();
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ ok: false, error: "Invalid bookingId" });
    }

    const { Booking } = getModels(req);
    const booking = await loadOwnedBooking({
      Booking,
      owner,
      bookingId: new Types.ObjectId(bookingId),
    });

    if (!booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    booking.paymentStatus = "paid";
    booking.paidAt = new Date();
    await booking.save();

    return res.json({
      ok: true,
      bookingId: String(booking._id),
      paymentStatus: booking.paymentStatus,
      paidAt: booking.paidAt,
    });
  } catch (err) {
    console.error("[adminInvoices] POST /:bookingId/mark-paid error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/:bookingId/mark-returned", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const bookingId = String(req.params.bookingId || "").trim();
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ ok: false, error: "Invalid bookingId" });
    }

    const body = req.body || {};
    const bankFee = parseMoney(body.bankFee, parseMoney(body.returnBankFee, 0));
    const returnNote = String(body.returnNote || "").trim();

    const { Booking } = getModels(req);
    const booking = await loadOwnedBooking({
      Booking,
      owner,
      bookingId: new Types.ObjectId(bookingId),
    });

    if (!booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    booking.paymentStatus = "returned";
    booking.returnedAt = new Date();
    booking.returnBankFee = bankFee;
    booking.returnNote = returnNote;
    await booking.save();

    return res.json({
      ok: true,
      bookingId: String(booking._id),
      paymentStatus: booking.paymentStatus,
      returnedAt: booking.returnedAt,
      returnBankFee: booking.returnBankFee,
      returnNote: booking.returnNote || "",
    });
  } catch (err) {
    console.error("[adminInvoices] POST /:bookingId/mark-returned error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/:bookingId/resend-dunning", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const bookingId = String(req.params.bookingId || "").trim();
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ ok: false, error: "Invalid bookingId" });
    }

    const body = req.body || {};
    const requestedStage = String(body.stage || "next").trim();

    const { Customer, Booking } = getModels(req);

    const booking = await loadOwnedBooking({
      Booking,
      owner,
      bookingId: new Types.ObjectId(bookingId),
    });

    if (!booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(409).json({
        ok: false,
        error: "Booking is already paid. Dunning not allowed.",
      });
    }

    const { customer } = await findCustomerAndBookingByBookingId({
      Customer,
      owner,
      bookingId: booking._id,
    });

    if (!customer) {
      return res.status(404).json({
        ok: false,
        error: "Customer for booking not found",
      });
    }

    const stage =
      requestedStage === "next"
        ? nextDunningStage(booking.dunningEvents)
        : requestedStage;

    if (!dunningStages().includes(stage)) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid dunning stage" });
    }

    const invNo = String(
      booking.invoiceNo || booking.invoiceNumber || "",
    ).trim();
    const doc = await findFirstSentDunningDoc({
      owner,
      invoiceNo: invNo,
      stage,
    });

    if (!doc) {
      return res.status(404).json({
        ok: false,
        error: "No existing dunning document for this invoice and stage",
      });
    }

    const toEmail = String(
      body.toEmail || customer?.parent?.email || booking.email || "",
    ).trim();

    if (!toEmail) {
      return res.status(400).json({ ok: false, error: "No recipient email" });
    }

    const freeText = String(body.freeText || "").trim();
    const dueAt = doc?.dueAt ? new Date(doc.dueAt) : addDays(new Date(), 14);
    const sentAt = new Date();
    const subject = String(body.subject || doc?.subject || "").trim();

    const feeSnapshot = doc?.feesSnapshot || {};
    const { sendDunningEmail } = getMailer();

    await sendDunningEmail({
      to: toEmail,
      customer,
      booking,
      stage,
      feeSnapshot,
      dueAt,
      freeText,
      sentAt,
      subject,
    });

    return res.json({
      ok: true,
      bookingId: String(booking._id),
      stage,
      document: {
        id: String(doc._id),
        kind: doc.kind,
        stage: doc.stage,
        fileName: doc.fileName,
        filePath: doc.filePath,
      },
    });
  } catch (err) {
    console.error(
      "[adminInvoices] POST /:bookingId/resend-dunning error:",
      err,
    );
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/:bookingId/send-dunning", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const bookingId = String(req.params.bookingId || "").trim();
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ ok: false, error: "Invalid bookingId" });
    }

    const body = req.body || {};
    const requestedStage = String(body.stage || "next").trim();
    const freeText = String(body.freeText || "").trim();
    const templateVersion = String(
      body.templateVersion || "invoice-dunning-v1",
    ).trim();

    const { Customer, Booking } = getModels(req);

    const booking = await loadOwnedBooking({
      Booking,
      owner,
      bookingId: new Types.ObjectId(bookingId),
    });

    if (!booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(409).json({
        ok: false,
        error: "Booking is already paid. Dunning not allowed.",
      });
    }

    const { customer } = await findCustomerAndBookingByBookingId({
      Customer,
      owner,
      bookingId: booking._id,
    });

    if (!customer) {
      return res.status(404).json({
        ok: false,
        error: "Customer for booking not found",
      });
    }

    const stage =
      requestedStage === "next"
        ? nextDunningStage(booking.dunningEvents)
        : requestedStage;

    if (!dunningStages().includes(stage)) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid dunning stage" });
    }

    const invNo = String(
      booking.invoiceNo || booking.invoiceNumber || "",
    ).trim();
    const existing = await findFirstSentDunningDoc({
      owner,
      invoiceNo: invNo,
      stage,
    });

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: "Dunning already exists for this invoice and stage. Use resend.",
        existingDocumentId: String(existing._id),
      });
    }

    const feesSnapshot = buildFeeSnapshot(booking, body);
    const sentAt = new Date();
    const dueAt = addDays(sentAt, 14);

    const toEmail = String(
      body.toEmail || customer?.parent?.email || booking.email || "",
    ).trim();

    if (!toEmail) {
      return res.status(400).json({ ok: false, error: "No recipient email" });
    }

    const { sendDunningEmail } = getMailer();
    const sentMail = await sendDunningEmail({
      to: toEmail,
      customer,
      booking,
      stage,
      feeSnapshot: feesSnapshot,
      dueAt,
      freeText,
      sentAt,
      subject: body.subject,
    });

    const subject = String(sentMail?.subject || body.subject || "").trim();

    let archivedDocument = null;

    if (sentMail?.pdfBuffer) {
      const archiveMeta = archiveDunningPdf({
        pdfBuffer: sentMail.pdfBuffer,
        booking,
        customer,
        stage,
        sentAt,
        dueAt,
        subject,
        feeSnapshot: feesSnapshot,
        owner,
      });

      archivedDocument = await BillingDocument.create({
        owner: String(owner),
        ...archiveMeta,
      });
    }

    booking.dunningEvents = Array.isArray(booking.dunningEvents)
      ? booking.dunningEvents
      : [];

    booking.dunningEvents.push({
      stage,
      sentAt,
      dueAt,
      feesSnapshot,
      toEmail,
      subject,
      templateVersion,
      note: freeText,
      sentBy: owner,
      documentId: archivedDocument?._id || null,
      documentFileName: archivedDocument?.fileName || "",
      documentFilePath: archivedDocument?.filePath || "",
    });

    await booking.save();

    return res.json({
      ok: true,
      bookingId: String(booking._id),
      paymentStatus: booking.paymentStatus || "open",
      dunningEvent: booking.dunningEvents[booking.dunningEvents.length - 1],
      nextStage:
        stage === "final" ? "final" : nextDunningStage(booking.dunningEvents),
      document: archivedDocument
        ? {
            id: String(archivedDocument._id),
            kind: archivedDocument.kind,
            stage: archivedDocument.stage,
            fileName: archivedDocument.fileName,
            filePath: archivedDocument.filePath,
          }
        : null,
    });
  } catch (err) {
    console.error("[adminInvoices] POST /:bookingId/send-dunning error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/:bookingId/mark-collection", async (req, res) => {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const bookingId = String(req.params.bookingId || "").trim();
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ ok: false, error: "Invalid bookingId" });
    }

    const body = req.body || {};
    const status = String(body.collectionStatus || "handed_over").trim();
    const note = String(body.note || body.handedOverNote || "").trim();

    if (!["none", "handed_over", "closed"].includes(status)) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid collectionStatus" });
    }

    const { Booking } = getModels(req);
    const booking = await loadOwnedBooking({
      Booking,
      owner,
      bookingId: new Types.ObjectId(bookingId),
    });

    if (!booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    booking.collectionStatus = status;
    booking.handedOverAt =
      status === "handed_over" ? new Date() : booking.handedOverAt || null;
    booking.handedOverNote = note;

    await booking.save();

    return res.json({
      ok: true,
      bookingId: String(booking._id),
      collectionStatus: booking.collectionStatus || "none",
      handedOverAt: booking.handedOverAt || null,
      handedOverNote: booking.handedOverNote || "",
    });
  } catch (err) {
    console.error(
      "[adminInvoices] POST /:bookingId/mark-collection error:",
      err,
    );
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
