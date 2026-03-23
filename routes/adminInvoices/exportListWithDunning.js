//routes\adminInvoices\exportListWithDunning.js
"use strict";

function dunningStageLabel(stage) {
  if (stage === "reminder") return "Zahlungserinnerung";
  if (stage === "dunning1") return "1. Mahnung";
  if (stage === "dunning2") return "2. Mahnung";
  if (stage === "final") return "Letzte Mahnung";
  return "Mahnung";
}

function matchesDunningQuery({ q, doc, norm, isDigitsOnly }) {
  const raw = String(q || "").trim();
  if (!raw) return true;

  if (isDigitsOnly(raw)) {
    return String(doc.customerNo || "").trim() === raw;
  }

  const qq = norm(raw);
  const blob = [
    doc.fileName,
    doc.invoiceNo,
    doc.customerNo,
    doc.subject,
    doc.offerTitle,
    doc.searchText,
    doc.stage,
  ]
    .filter(Boolean)
    .join(" ");

  return norm(blob).includes(qq);
}

function mapDunningDocumentToInvoiceRow(doc) {
  const fees = doc?.feesSnapshot || {};
  const returnBankFee = Number(fees.returnBankFee || 0);
  const dunningFee = Number(fees.dunningFee || 0);
  const processingFee = Number(fees.processingFee || 0);
  const totalExtraFees = Number(
    fees.totalExtraFees != null
      ? fees.totalExtraFees
      : returnBankFee + dunningFee + processingFee,
  );

  return {
    id: `dunning:${String(doc._id)}`,
    bookingId: String(doc.bookingId || ""),
    customerId: String(doc.customerId || ""),
    type: "dunning",
    title: doc.subject || dunningStageLabel(doc.stage),
    issuedAt: doc.sentAt || doc.createdAt || null,
    offerTitle: doc.offerTitle || undefined,
    offerType: "dunning",
    amount: totalExtraFees,
    currency: fees.currency || "EUR",
    customerNumber: doc.customerNo || undefined,
    customerName: undefined,
    customerChildName: undefined,
    invoiceNo: doc.invoiceNo || undefined,
    invoiceNumber: doc.invoiceNo || undefined,
    href: `/api/admin/invoices/dunning-documents/${encodeURIComponent(
      String(doc._id),
    )}/download`,
    kind: "dunning",
    stage: doc.stage || null,
    fileName: doc.fileName || undefined,
    filePath: doc.filePath || undefined,
    paymentStatus: "open",
    dunningCount: 1,
    lastDunningStage: doc.stage || null,
    lastDunningSentAt: doc.sentAt || null,
    nextDunningStage: doc.stage === "final" ? "final" : null,
    subject: doc.subject || undefined,
    returnBankFee,
    dunningFee,
    processingFee,
    totalExtraFees,
    feesCurrency: fees.currency || "EUR",
    originalInvoiceAmount: 0,
    dunningTotalAmount: 0,
  };
}

function buildDateRange({ query, normalizeFilterDate }) {
  const fromStr = normalizeFilterDate(query.from);
  const toStr = normalizeFilterDate(query.to);

  return {
    fromDate: fromStr ? new Date(`${fromStr}T00:00:00`) : null,
    toDate: toStr ? new Date(`${toStr}T23:59:59.999`) : null,
  };
}

function inDateRange({ issuedAt, fromDate, toDate }) {
  if (!issuedAt) return true;
  if (!fromDate && !toDate) return true;

  const time = new Date(issuedAt).getTime();
  if (Number.isNaN(time)) return true;
  if (fromDate && time < fromDate.getTime()) return false;
  if (toDate && time > toDate.getTime()) return false;

  return true;
}

function buildDunningFilter({ owner, stageFilter }) {
  const filter = {
    owner: String(owner),
    kind: "dunning",
  };

  if (stageFilter) filter.stage = stageFilter;
  return filter;
}

async function fetchDunningDocs({ BillingDocument, filter, max }) {
  return BillingDocument.find(filter)
    .sort({ sentAt: -1, createdAt: -1 })
    .limit(max)
    .lean();
}

async function loadDunningDocumentsForList({
  owner,
  query,
  hardLimit,
  BillingDocument,
  normalizeFilterDate,
  norm,
  isDigitsOnly,
}) {
  const q = String(query.q || "").trim();
  const stageFilter = String(query.stage || "").trim();
  const max = Math.max(1, Number(hardLimit || 10000));
  const { fromDate, toDate } = buildDateRange({ query, normalizeFilterDate });

  const docs = await fetchDunningDocs({
    BillingDocument,
    filter: buildDunningFilter({ owner, stageFilter }),
    max,
  });

  const out = [];

  for (const doc of docs) {
    if (!matchesDunningQuery({ q, doc, norm, isDigitsOnly })) continue;

    const issuedAt = doc.sentAt || doc.createdAt || null;
    if (!inDateRange({ issuedAt, fromDate, toDate })) continue;

    out.push(mapDunningDocumentToInvoiceRow(doc));
  }

  return out;
}

function sortMergedItems({
  merged,
  query,
  normalizeSort,
  issuedTime,
  docNoCompare,
}) {
  const sort = normalizeSort(query.sort);

  merged.sort((a, b) => {
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

  return merged;
}

function readInvoiceItems(invoiceResult) {
  return Array.isArray(invoiceResult?.items) ? invoiceResult.items : [];
}

async function buildExportListWithDunning({
  owner,
  Customer,
  Booking,
  query,
  hardLimit,
  deps,
}) {
  if (!deps || typeof deps.buildInvoiceList !== "function") {
    throw new Error(
      "buildExportListWithDunning: deps.buildInvoiceList missing",
    );
  }

  const invoiceResult = await deps.buildInvoiceList({
    owner,
    Customer,
    Booking,
    query: { ...query, page: 1, limit: hardLimit ?? 10000 },
    hardLimit: hardLimit ?? 10000,
  });

  const invoiceItems = readInvoiceItems(invoiceResult);

  const dunningItems = await loadDunningDocumentsForList({
    owner,
    query,
    hardLimit: hardLimit ?? 10000,
    BillingDocument: deps.BillingDocument,
    clamp: deps.clamp,
    normalizeFilterDate: deps.normalizeFilterDate,
    norm: deps.norm,
    isDigitsOnly: deps.isDigitsOnly,
  });

  const merged = [...invoiceItems, ...dunningItems];

  const bookingIds = [
    ...new Set(
      dunningItems
        .map((it) => String(it.bookingId || "").trim())
        .filter(Boolean),
    ),
  ];

  if (bookingIds.length) {
    const bookingDocs = await Booking.find(
      { owner, _id: { $in: bookingIds } },
      {
        _id: 1,
        priceAtBooking: 1,
        stornoAmount: 1,
        currency: 1,
        offerTitle: 1,
        offerType: 1,
      },
    ).lean();

    const bookingMap = new Map(bookingDocs.map((b) => [String(b._id), b]));

    for (const it of dunningItems) {
      const booking = bookingMap.get(String(it.bookingId || ""));
      if (!booking) continue;

      const originalInvoiceAmount = Number(booking.priceAtBooking || 0);
      const totalExtraFees = Number(it.totalExtraFees || 0);

      it.originalInvoiceAmount = originalInvoiceAmount;
      it.dunningTotalAmount = originalInvoiceAmount + totalExtraFees;
      it.offerTitle = it.offerTitle || booking.offerTitle || it.offerTitle;
      it.offerType =
        it.offerType === "dunning"
          ? booking.offerType || "dunning"
          : it.offerType;
      it.currency = it.currency || booking.currency || "EUR";
    }
  }

  return sortMergedItems({
    merged,
    query,
    normalizeSort: deps.normalizeSort,
    issuedTime: deps.issuedTime,
    docNoCompare: deps.docNoCompare,
  });
}

module.exports = {
  buildExportListWithDunning,
};
