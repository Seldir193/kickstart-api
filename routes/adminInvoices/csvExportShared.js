//routes\adminInvoices\csvExportShared.js
"use strict";

function escCsv(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtDEDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function dunningStageLabel(stage) {
  if (stage === "reminder") return "Zahlungserinnerung";
  if (stage === "dunning1") return "1. Mahnung";
  if (stage === "dunning2") return "2. Mahnung";
  if (stage === "final") return "Letzte Mahnung";
  return "Mahnung";
}

function parseBrandZipCity(addrLine2) {
  const s = String(addrLine2 || "").trim();
  if (!s) return { zip: "", city: "" };
  const m = s.match(/^(\d{4,5})\s+(.*)$/);
  if (!m) return { zip: "", city: s };
  return { zip: m[1], city: m[2] };
}

function buildBrandMeta(env) {
  const brandCompany = env.BRAND_COMPANY || "Münchner Fussballschule NRW";
  const brandAddrStreet = env.BRAND_ADDR_LINE1 || "Hochfelder Str. 33";
  const brandAddrLine2 = env.BRAND_ADDR_LINE2 || "47226 Duisburg";
  const brandEmail = env.BRAND_EMAIL || "info@muenchner-fussball-schule.ruhr";
  const brandWebsite =
    env.BRAND_WEBSITE_URL || "https://www.muenchner-fussball-schule.ruhr";
  const iban = env.BRAND_IBAN || "DE13350400380595090200";
  const bic = env.BRAND_BIC || "COBADEFFXXX";
  const taxId = env.BRAND_TAXID || "";
  const vatNote = env.CSV_VAT_NOTE || "USt-befreit gem. § 19 UStG";
  const parsed = parseBrandZipCity(brandAddrLine2);

  return {
    brandCompany,
    brandAddrStreet,
    brandAddrZip: parsed.zip,
    brandAddrCity: parsed.city,
    brandCountry: "",
    brandEmail,
    brandWebsite,
    iban,
    bic,
    taxId,
    vatNote,
  };
}

function getDocNo(docNoFrom, item) {
  if (typeof docNoFrom === "function")
    return String(docNoFrom(item) || "").trim();
  return String(
    item.invoiceNo ||
      item.invoiceNumber ||
      item.cancellationNo ||
      item.stornoNo ||
      item.stornoNumber ||
      "",
  ).trim();
}

function getFeeSnapshot(item) {
  return item && item.feesSnapshot && typeof item.feesSnapshot === "object"
    ? item.feesSnapshot
    : {};
}

function calcDunningAmounts(item) {
  const fees = getFeeSnapshot(item);
  const returnBankFee = toNum(item.returnBankFee ?? fees.returnBankFee, 0);
  const dunningFee = toNum(item.dunningFee ?? fees.dunningFee, 0);
  const processingFee = toNum(item.processingFee ?? fees.processingFee, 0);
  const totalExtraFees = toNum(
    item.totalExtraFees ?? fees.totalExtraFees,
    returnBankFee + dunningFee + processingFee,
  );
  const originalInvoiceAmount = toNum(
    item.originalInvoiceAmount ?? item.invoiceAmount ?? item.baseAmount,
    0,
  );
  const dunningTotalAmount = toNum(
    item.dunningTotalAmount,
    originalInvoiceAmount + totalExtraFees,
  );
  const feesCurrency = String(
    item.feesCurrency || fees.currency || item.currency || "EUR",
  );

  return {
    originalInvoiceAmount,
    returnBankFee,
    dunningFee,
    processingFee,
    totalExtraFees,
    dunningTotalAmount,
    feesCurrency,
  };
}

function csvHeaders() {
  return [
    "id",
    "bookingId",
    "type",
    "title",
    "issuedAt",
    "status",
    "offerTitle",
    "offerType",
    "venue",
    "price",
    "currency",
    "href",
    "invoiceNo",
    "invoiceDate",
    "refInvoiceNo",
    "refInvoiceDate",
    "cancellationNo",
    "stornoNo",
    "stornoAmount",
    "brandCompany",
    "brandAddrStreet",
    "brandAddrZip",
    "brandAddrCity",
    "brandCountry",
    "docTitle",
    "quantity",
    "unitNet",
    "vatRate",
    "vatAmount",
    "totalAmount",
    "iban",
    "bic",
    "taxId",
    "brandEmail",
    "brandWebsite",
    "vatNote",

    "voucherCode",
    "voucherDiscount",
    "totalDiscount",
    "finalPrice",
    "dunningStage",
    "dunningSubject",
    "originalInvoiceAmount",
    "returnBankFee",
    "dunningFee",
    "processingFee",
    "totalExtraFees",
    "dunningTotalAmount",
    "feesCurrency",
    "dunningStageLabel",
    "dunningDueDate",
    "dunningFileName",
  ];
}

function buildCsvRow(item, options = {}) {
  const { env = process.env, docNoFrom } = options;
  const brand = buildBrandMeta(env);

  const isDunning = item.type === "dunning";
  const isParticipation = item.type === "participation";
  const isCancellation = item.type === "cancellation";
  const isStorno = item.type === "storno";

  const isInvoice = item.type === "invoice";

  const dunningAmounts = isDunning
    ? calcDunningAmounts(item)
    : {
        originalInvoiceAmount: 0,
        returnBankFee: 0,
        dunningFee: 0,
        processingFee: 0,
        totalExtraFees: 0,
        dunningTotalAmount: 0,
        feesCurrency: "",
      };

  let basePrice = 0;
  if (isDunning) basePrice = dunningAmounts.totalExtraFees;
  if (isStorno) basePrice = toNum(item.stornoAmount ?? item.amount, 0);
  if (isParticipation) basePrice = toNum(item.amount, 0);
  if (isInvoice) basePrice = toNum(item.amount, 0);

  if (isCancellation) basePrice = 0;

  const unitNet = toNum(basePrice, 0);
  const vatRate = 0;
  const vatAmount = 0;
  const totalAmount = unitNet + vatAmount;

  const row = {
    id: item.id || "",
    bookingId: item.bookingId || "",
    type: item.type || "",
    title: item.title || "",
    issuedAt: fmtDEDate(item.issuedAt),
    status: item.paymentStatus || item.status || "open",
    offerTitle: item.offerTitle || "",
    offerType: item.offerType || "",
    venue: item.venue || "",
    price: isCancellation ? "" : unitNet.toFixed(2),
    currency: item.currency || "EUR",
    href: item.href || "",
    invoiceNo: getDocNo(docNoFrom, item),
    invoiceDate: fmtDEDate(item.invoiceDate || item.issuedAt),
    refInvoiceNo:
      isParticipation || isDunning ? "" : String(item.refInvoiceNo || ""),
    refInvoiceDate:
      isParticipation || isDunning ? "" : fmtDEDate(item.refInvoiceDate),
    cancellationNo: isCancellation ? String(item.cancellationNo || "") : "",
    stornoNo: isStorno ? String(item.stornoNo || item.stornoNumber || "") : "",
    stornoAmount: isStorno
      ? toNum(item.stornoAmount ?? item.amount, 0).toFixed(2)
      : "",
    brandCompany: brand.brandCompany,
    brandAddrStreet: brand.brandAddrStreet,
    brandAddrZip: brand.brandAddrZip,
    brandAddrCity: brand.brandAddrCity,
    brandCountry: brand.brandCountry,
    docTitle: item.title || "",
    quantity: 1,
    unitNet: unitNet.toFixed(2),
    vatRate,
    vatAmount: vatAmount.toFixed(2),
    totalAmount: totalAmount.toFixed(2),
    iban: brand.iban,
    bic: brand.bic,
    taxId: brand.taxId,
    brandEmail: brand.brandEmail,
    brandWebsite: brand.brandWebsite,
    vatNote: brand.vatNote,

    voucherCode: isParticipation ? String(item.voucherCode || "") : "",
    voucherDiscount: isParticipation
      ? toNum(item.voucherDiscount, 0).toFixed(2)
      : isInvoice
        ? "0.00"
        : "",
    totalDiscount: isParticipation
      ? toNum(item.totalDiscount, 0).toFixed(2)
      : isInvoice
        ? "0.00"
        : "",
    finalPrice: isParticipation
      ? toNum(item.finalPrice, item.amount).toFixed(2)
      : isInvoice
        ? toNum(item.finalPrice, item.amount).toFixed(2)
        : "",
    dunningStage: isDunning ? String(item.stage || "") : "",
    dunningSubject: isDunning ? String(item.subject || "") : "",
    originalInvoiceAmount: isDunning
      ? dunningAmounts.originalInvoiceAmount.toFixed(2)
      : "",
    returnBankFee: isDunning ? dunningAmounts.returnBankFee.toFixed(2) : "",
    dunningFee: isDunning ? dunningAmounts.dunningFee.toFixed(2) : "",
    processingFee: isDunning ? dunningAmounts.processingFee.toFixed(2) : "",
    totalExtraFees: isDunning ? dunningAmounts.totalExtraFees.toFixed(2) : "",
    dunningTotalAmount: isDunning
      ? dunningAmounts.dunningTotalAmount.toFixed(2)
      : "",
    feesCurrency: isDunning ? dunningAmounts.feesCurrency : "",
    dunningStageLabel: isDunning ? dunningStageLabel(item.stage) : "",
    dunningDueDate: isDunning ? fmtDEDate(item.dueAt) : "",
    dunningFileName: isDunning ? String(item.fileName || "") : "",
  };

  return row;
}

function buildCsvLines(items, options = {}) {
  const headers = csvHeaders();
  const lines = [headers.join(",")];

  for (const item of Array.isArray(items) ? items : []) {
    const row = buildCsvRow(item, options);
    lines.push(headers.map((k) => escCsv(row[k])).join(","));
  }

  return { headers, lines };
}

function buildCsvText(items, options = {}) {
  const { lines } = buildCsvLines(items, options);
  return lines.join("\n");
}

module.exports = {
  csvHeaders,
  buildCsvRow,
  buildCsvLines,
  buildCsvText,
  dunningStageLabel,
};
