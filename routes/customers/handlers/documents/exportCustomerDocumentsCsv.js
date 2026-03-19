// routes/customers/handlers/documents/exportCustomerDocumentsCsv.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const Booking = require("../../../../models/Booking");
const BillingDocument = require("../../../../models/BillingDocument");

const {
  docMatchesType,
  docMatchesQuery,
  parseDate,
} = require("../../helpers/documents/docMatchers");
const {
  buildCustomerDocs,
  buildCustomerDunningDocs,
  dunningStageLabel,
} = require("../../helpers/documents/buildCustomerDocs");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtDeDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function escCsv(value) {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
    "creditNoteNo",
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

function getBrand() {
  const company = process.env.BRAND_COMPANY || "Münchner Fussballschule NRW";
  const street = process.env.BRAND_ADDR_LINE1 || "Hochfelder Str. 33";
  const addr2 = process.env.BRAND_ADDR_LINE2 || "47226 Duisburg";
  const email =
    process.env.BRAND_EMAIL || "info@muenchner-fussball-schule.ruhr";
  const website =
    process.env.BRAND_WEBSITE_URL ||
    "https://www.muenchner-fussball-schule.ruhr";

  let zip = "";
  let city = "";

  if (addr2) {
    const m = String(addr2).match(/^(\d{4,5})\s+(.*)$/);
    zip = m ? m[1] : "";
    city = m ? m[2] : addr2;
  }

  return {
    company,
    street,
    zip,
    city,
    country: "",
    iban: process.env.BRAND_IBAN || "DE13350400380595090200",
    bic: process.env.BRAND_BIC || "COBADEFFXXX",
    taxId: process.env.BRAND_TAXID || "",
    email,
    website,
    vatNote: process.env.CSV_VAT_NOTE || "USt-befreit gem. § 19 UStG",
  };
}

function parseSort(query) {
  const sortStr = String(query.sort || "issuedAt:desc");
  const [field, dir] = sortStr.split(":");
  return {
    key: field || "issuedAt",
    mul: dir === "asc" ? 1 : -1,
  };
}

function sortDocs(items, sortKey, sortMul) {
  items.sort((a, b) => {
    const av = new Date(a?.[sortKey] || 0).getTime();
    const bv = new Date(b?.[sortKey] || 0).getTime();
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * sortMul;
  });
}

function loadDunningDocsForCustomer(owner, customer) {
  const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];
  const bookingIds = bookings
    // .map((b) => String(b?._id || ""))
    .map((b) => String(b?.bookingId || b?._id || ""))
    .filter((v) => v && mongoose.isValidObjectId(v));

  if (!bookingIds.length) return [];

  return BillingDocument.find({
    owner: String(owner),
    kind: "dunning",
    bookingId: { $in: bookingIds },
  })
    .sort({ sentAt: -1, createdAt: -1 })
    .lean();
}

function bookingByIdMap(customer) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  const out = new Map();

  for (const b of refs) {
    out.set(String(b?._id || ""), b);
    out.set(String(b?.bookingId || ""), b);
  }

  return out;
}

function offerCsvFields(b, offer, doc) {
  return {
    offerTitle: b?.offerTitle || offer?.title || doc?.offerTitle || "",
    offerType:
      b?.offerType || offer?.sub_type || offer?.type || doc?.offerType || "",
    venue: b?.venue || offer?.location || "",
  };
}

function refInvoiceFields(doc, booking, normalizeInvoiceNo) {
  if (
    doc.type === "participation" ||
    doc.type === "dunning" ||
    doc.type === "creditnote" ||
    doc.type === "contract"
  ) {
    return { refInvoiceNo: "", refInvoiceDate: "" };
  }

  return {
    refInvoiceNo: normalizeInvoiceNo(
      booking?.refInvoiceNo ||
        booking?.invoiceNumber ||
        booking?.invoiceNo ||
        "",
    ),
    refInvoiceDate: fmtDeDate(
      booking?.refInvoiceDate || booking?.invoiceDate || null,
    ),
  };
}

function amountFields(doc, booking, offer) {
  const isDunning = doc.type === "dunning";
  const isPart = doc.type === "participation";
  const isStorno = doc.type === "storno";
  const isCredit = doc.type === "creditnote";

  const bookingPrice =
    booking?.priceAtBooking ??
    booking?.priceMonthly ??
    booking?.price ??
    offer?.price ??
    0;

  const creditAmount =
    doc.type === "creditnote"
      ? Math.abs(
          toNumber(
            doc.amount,
            toNumber(doc.finalPrice, toNumber(bookingPrice, 0)),
          ),
        )
      : 0;

  const basePrice = isDunning
    ? toNumber(doc.totalExtraFees, 0)
    : isStorno
      ? toNumber(
          doc.stornoAmount,
          toNumber(booking?.stornoAmount, toNumber(bookingPrice, 0)),
        )
      : isPart
        ? toNumber(bookingPrice, 0)
        : isCredit
          ? creditAmount
          : 0;

  const unitNet = Math.round(basePrice * 100) / 100;
  const vatRate = 0;
  const vatAmount = 0;
  const totalAmount = unitNet + vatAmount;

  return {
    price: isDunning ? unitNet : doc.type === "cancellation" ? "" : unitNet,
    unitNet,
    vatRate,
    vatAmount,
    totalAmount,
  };
}

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

async function loadBookingParentMap(owner, bookingRefs) {
  const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
    .map((b) => String(b?.bookingId || b?._id || ""))
    .filter((v) => v && mongoose.isValidObjectId(v));

  if (!bookingIds.length) return new Map();

  const docs = await Booking.find(
    { _id: { $in: bookingIds }, owner: String(owner) },
    {
      "invoiceTo.parent.email": 1,
      "invoiceTo.parent.firstName": 1,
      "invoiceTo.parent.lastName": 1,
    },
  )
    .lean()
    .catch(() => []);

  return new Map(
    docs.map((d) => [
      String(d._id),
      {
        parentEmail: safeLower(d?.invoiceTo?.parent?.email),
        parentFirstName: safeText(d?.invoiceTo?.parent?.firstName),
        parentLastName: safeText(d?.invoiceTo?.parent?.lastName),
      },
    ]),
  );
}

function attachParentMeta(items, parentMap) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const meta = parentMap.get(String(item?.bookingId || "")) || {};
    return {
      ...item,
      parentEmail: safeLower(meta.parentEmail),
      parentFirstName: safeText(meta.parentFirstName),
      parentLastName: safeText(meta.parentLastName),
    };
  });
}

function hasContractMeta(meta) {
  const signedAt = safeText(meta?.contractSignedAt);
  const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
  return Boolean(signedAt && html);
}

async function loadContractMetaMap(owner, bookingRefs) {
  const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
    .map((b) => String(b?.bookingId || b?._id || ""))
    .filter((v) => v && mongoose.isValidObjectId(v));

  if (!bookingIds.length) return new Map();

  const docs = await Booking.find(
    { _id: { $in: bookingIds }, owner: String(owner) },
    {
      "meta.contractSignedAt": 1,
      "meta.contractSnapshot.contractDoc": 1,
    },
  )
    .lean()
    .catch(() => []);

  return new Map(docs.map((d) => [String(d._id), d]));
}

function buildContractDocsFromMap(customer, bookingRefs, metaMap) {
  const customerId = safeText(customer?._id);
  const out = [];

  for (const ref of bookingRefs || []) {
    const bookingId = safeText(ref?.bookingId || ref?._id);
    if (!bookingId) continue;

    const doc = metaMap.get(bookingId);
    const meta = doc?.meta || {};
    if (!hasContractMeta(meta)) continue;

    out.push({
      id: `${bookingId}:contract`,
      bookingId,
      customerId,
      type: "contract",
      title: `Vertrag – ${safeText(ref.offerTitle || ref.offerType || "Angebot")}`,
      issuedAt: meta.contractSignedAt,
      href: `/api/admin/bookings/${encodeURIComponent(bookingId)}/documents/contract`,
      offerTitle: safeText(ref.offerTitle),
      offerType: safeText(ref.offerType),
      currency: safeText(ref.currency) || "EUR",

      childUid: safeText(ref.childUid),
      childFirstName: safeText(ref.childFirstName),
      childLastName: safeText(ref.childLastName),
    });
  }

  return out;
}

function isCreditInvoiceRef(ref) {
  const note = safeLower(ref?.note);
  const number = safeText(ref?.number);
  const amount = Number(ref?.amount);

  if (note.includes("gutschrift")) return true;
  if (number.toUpperCase().startsWith("GS")) return true;
  if (Number.isFinite(amount) && amount < 0) return true;

  return false;
}

function buildCustomerCreditNoteDocs(customer) {
  const customerId = safeText(customer?._id);
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  const out = [];

  for (const ref of refs) {
    const bookingId = safeText(ref?.bookingId || ref?._id);
    if (!bookingId) continue;

    const invoiceRefs = Array.isArray(ref?.invoiceRefs) ? ref.invoiceRefs : [];
    const creditRefs = invoiceRefs.filter(isCreditInvoiceRef);

    for (const creditRef of creditRefs) {
      const creditNoteNo = safeText(creditRef?.number);
      if (!creditNoteNo) continue;

      out.push({
        id: `${bookingId}:creditnote:${creditNoteNo}`,
        bookingId,
        customerId,
        type: "creditnote",
        title: `Gutschrift – ${safeText(ref.offerTitle || ref.offerType || "Angebot")}`,
        issuedAt:
          creditRef?.date ||
          ref.returnedAt ||
          ref.updatedAt ||
          ref.createdAt ||
          new Date(),
        href: `/api/admin/customers/${encodeURIComponent(
          customerId,
        )}/bookings/${encodeURIComponent(bookingId)}/credit-note.pdf`,
        offerTitle: safeText(ref.offerTitle),
        offerType: safeText(ref.offerType),
        currency: safeText(ref.currency) || "EUR",
        creditNoteNo,
        invoiceNo: creditNoteNo,
        invoiceNumber: creditNoteNo,
        amount: creditRef?.amount,
        finalPrice: creditRef?.finalPrice,

        childUid: safeText(ref.childUid),
        childFirstName: safeText(ref.childFirstName),
        childLastName: safeText(ref.childLastName),
      });
    }
  }

  return out;
}

async function exportCustomerDocumentsCsv(
  req,
  res,
  requireOwner,
  requireId,
  normalizeInvoiceNo,
) {
  try {
    req.query.page = "1";
    req.query.limit = "1000000";

    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const typeParam = String(req.query.type || "").trim();
    const typeSet = new Set(
      typeParam
        ? typeParam
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : [],
    );

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const q = String(req.query.q || "").trim();
    const { key: sortKey, mul: sortMul } = parseSort(req.query);

    const selectedIds = new Set(
      String(req.query.ids || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const childUid = safeText(req.query.childUid);
    const parentEmail = safeLower(req.query.parentEmail);

    const scope = safeText(req.query.scope).toLowerCase();

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const bookingRefs = Array.isArray(customer?.bookings)
      ? customer.bookings
      : [];
    const bookingMap = bookingByIdMap(customer);

    const bookingParentMap = await loadBookingParentMap(owner, bookingRefs);

    const offerIds = [
      ...new Set(
        bookingRefs
          .map((b) => String(b.offerId || ""))
          .filter((v) => v && mongoose.isValidObjectId(v)),
      ),
    ];

    const offers = offerIds.length
      ? await Offer.find({ _id: { $in: offerIds } })
          .select("_id title type sub_type location price")
          .lean()
      : [];

    const offerById = new Map(offers.map((o) => [String(o._id), o]));
    // const bookingDocs = buildCustomerDocs(customer);
    // const creditNoteDocs = buildCustomerCreditNoteDocs(customer);

    const bookingDocs = buildCustomerDocs(customer, { childUid });
    const creditNoteDocs = buildCustomerCreditNoteDocs(customer);
    const dunningSource = await loadDunningDocsForCustomer(owner, customer);
    const dunningDocs = buildCustomerDunningDocs(customer, dunningSource);

    const wantContract = !typeSet.size || typeSet.has("contract");
    const contractMetaMap = wantContract
      ? await loadContractMetaMap(owner, bookingRefs)
      : new Map();

    const contractDocs = wantContract
      ? buildContractDocsFromMap(customer, bookingRefs, contractMetaMap)
      : [];

    // let filtered = [
    //   ...bookingDocs,
    //   ...creditNoteDocs,
    //   ...contractDocs,
    //   ...dunningDocs,
    // ].filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

    let filtered = attachParentMeta(
      [...bookingDocs, ...creditNoteDocs, ...contractDocs, ...dunningDocs],
      bookingParentMap,
    ).filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

    if (selectedIds.size) {
      filtered = filtered.filter((d) => selectedIds.has(String(d.id || "")));
    }

    if (childUid) {
      filtered = filtered.filter((d) => safeText(d?.childUid) === childUid);
    }

    if (parentEmail) {
      filtered = filtered.filter(
        (d) => safeLower(d?.parentEmail) === parentEmail,
      );
    }

    if (scope === "self") {
      filtered = filtered.filter((d) => !safeText(d?.childUid));
    }

    if (scope === "child") {
      filtered = filtered.filter((d) => safeText(d?.childUid));
    }

    if (from) filtered = filtered.filter((d) => new Date(d.issuedAt) >= from);
    if (to) filtered = filtered.filter((d) => new Date(d.issuedAt) <= to);

    sortDocs(filtered, sortKey, sortMul);

    const brand = getBrand();
    const headers = csvHeaders();

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="customer-${id}-documents.csv"`,
    );

    res.write(headers.join(",") + "\n");

    for (const d of filtered) {
      const b = bookingMap.get(String(d.bookingId || "")) || {};
      const offer = (b.offerId && offerById.get(String(b.offerId))) || null;
      const { offerTitle, offerType, venue } = offerCsvFields(b, offer, d);
      const { refInvoiceNo, refInvoiceDate } = refInvoiceFields(
        d,
        b,
        normalizeInvoiceNo,
      );
      const amounts = amountFields(d, b, offer);

      const invoiceNo = normalizeInvoiceNo(
        d.type === "creditnote"
          ? d.creditNoteNo || d.invoiceNo || d.invoiceNumber || ""
          : d.invoiceNo || b.invoiceNumber || b.invoiceNo || "",
      );

      const invoiceDate = d.invoiceDate || b.invoiceDate || d.issuedAt || null;

      const cancellationNo =
        d.type === "cancellation"
          ? d.cancellationNo || b.cancellationNo || b.cancellationNumber || ""
          : "";

      const stornoNo =
        d.type === "storno"
          ? d.stornoNo || b.stornoNo || b.stornoNumber || ""
          : "";

      const stornoAmount =
        d.type === "storno"
          ? toNumber(d.stornoAmount, toNumber(b.stornoAmount, 0)).toFixed(2)
          : "";

      const originalInvoiceAmount = toNumber(
        d.originalInvoiceAmount,
        b.priceAtBooking ?? b.priceMonthly ?? b.price ?? 0,
      );
      const returnBankFee = toNumber(d.returnBankFee, b.returnBankFee ?? 0);
      const dunningFee = toNumber(d.dunningFee, 0);
      const processingFee = toNumber(d.processingFee, 0);
      const totalExtraFees = toNumber(
        d.totalExtraFees,
        returnBankFee + dunningFee + processingFee,
      );
      const dunningTotalAmount = toNumber(
        d.dunningTotalAmount,
        originalInvoiceAmount + totalExtraFees,
      );

      const row = [
        d.id || "",
        d.bookingId || "",
        d.type || "",
        d.title || "",
        fmtDeDate(d.issuedAt),
        d.status || "",
        offerTitle || "",
        offerType || "",
        venue || "",
        amounts.price === "" ? "" : Number(amounts.price).toFixed(2),
        d.currency || b.currency || "EUR",
        d.href || "",
        invoiceNo || "",
        d.type === "creditnote" ? d.creditNoteNo || invoiceNo || "" : "",
        fmtDeDate(invoiceDate),
        refInvoiceNo || "",
        refInvoiceDate || "",
        cancellationNo || "",
        stornoNo || "",
        stornoAmount,
        brand.company,
        brand.street,
        brand.zip,
        brand.city,
        brand.country,
        d.title || "",
        1,
        amounts.unitNet.toFixed(2),
        amounts.vatRate,
        amounts.vatAmount.toFixed(2),
        amounts.totalAmount.toFixed(2),
        brand.iban,
        brand.bic,
        brand.taxId,
        brand.email,
        brand.website,
        brand.vatNote,
        d.type === "dunning" ? d.stage || "" : "",
        d.type === "dunning" ? d.subject || "" : "",
        d.type === "dunning" ? originalInvoiceAmount.toFixed(2) : "",
        d.type === "dunning" ? returnBankFee.toFixed(2) : "",
        d.type === "dunning" ? dunningFee.toFixed(2) : "",
        d.type === "dunning" ? processingFee.toFixed(2) : "",
        d.type === "dunning" ? totalExtraFees.toFixed(2) : "",
        d.type === "dunning" ? dunningTotalAmount.toFixed(2) : "",
        d.type === "dunning" ? d.currency || "EUR" : "",
        d.type === "dunning" ? dunningStageLabel(d.stage) : "",
        d.type === "dunning" ? fmtDeDate(d.dueAt) : "",
        d.type === "dunning" ? d.fileName || "" : "",
      ]
        .map(escCsv)
        .join(",");

      res.write(row + "\n");
    }

    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { exportCustomerDocumentsCsv };

// // routes/customers/handlers/documents/exportCustomerDocumentsCsv.js
// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const Offer = require("../../../../models/Offer");
// const BillingDocument = require("../../../../models/BillingDocument");

// const {
//   docMatchesType,
//   docMatchesQuery,
//   parseDate,
// } = require("../../helpers/documents/docMatchers");
// const {
//   buildCustomerDocs,
//   buildCustomerDunningDocs,
//   dunningStageLabel,
// } = require("../../helpers/documents/buildCustomerDocs");

// function toNumber(value, fallback = 0) {
//   const n = Number(value);
//   return Number.isFinite(n) ? n : fallback;
// }

// function fmtDeDate(value) {
//   if (!value) return "";
//   const d = new Date(value);
//   if (isNaN(d.getTime())) return "";
//   return new Intl.DateTimeFormat("de-DE", {
//     timeZone: "Europe/Berlin",
//     day: "2-digit",
//     month: "2-digit",
//     year: "numeric",
//   }).format(d);
// }

// function escCsv(value) {
//   if (value == null) return "";
//   const s = String(value);
//   return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
// }

// function csvHeaders() {
//   return [
//     "id",
//     "bookingId",
//     "type",
//     "title",
//     "issuedAt",
//     "status",
//     "offerTitle",
//     "offerType",
//     "venue",
//     "price",
//     "currency",
//     "href",
//     "invoiceNo",
//     "creditNoteNo",
//     "invoiceDate",
//     "refInvoiceNo",
//     "refInvoiceDate",
//     "cancellationNo",
//     "stornoNo",
//     "stornoAmount",
//     "brandCompany",
//     "brandAddrStreet",
//     "brandAddrZip",
//     "brandAddrCity",
//     "brandCountry",
//     "docTitle",
//     "quantity",
//     "unitNet",
//     "vatRate",
//     "vatAmount",
//     "totalAmount",
//     "iban",
//     "bic",
//     "taxId",
//     "brandEmail",
//     "brandWebsite",
//     "vatNote",
//     "dunningStage",
//     "dunningSubject",
//     "originalInvoiceAmount",
//     "returnBankFee",
//     "dunningFee",
//     "processingFee",
//     "totalExtraFees",
//     "dunningTotalAmount",
//     "feesCurrency",
//     "dunningStageLabel",
//     "dunningDueDate",
//     "dunningFileName",
//   ];
// }

// function getBrand() {
//   const company = process.env.BRAND_COMPANY || "Münchner Fussballschule NRW";
//   const street = process.env.BRAND_ADDR_LINE1 || "Hochfelder Str. 33";
//   const addr2 = process.env.BRAND_ADDR_LINE2 || "47226 Duisburg";
//   const email =
//     process.env.BRAND_EMAIL || "info@muenchner-fussball-schule.ruhr";
//   const website =
//     process.env.BRAND_WEBSITE_URL ||
//     "https://www.muenchner-fussball-schule.ruhr";

//   let zip = "";
//   let city = "";

//   if (addr2) {
//     const m = String(addr2).match(/^(\d{4,5})\s+(.*)$/);
//     zip = m ? m[1] : "";
//     city = m ? m[2] : addr2;
//   }

//   return {
//     company,
//     street,
//     zip,
//     city,
//     country: "",
//     iban: process.env.BRAND_IBAN || "DE13350400380595090200",
//     bic: process.env.BRAND_BIC || "COBADEFFXXX",
//     taxId: process.env.BRAND_TAXID || "",
//     email,
//     website,
//     vatNote: process.env.CSV_VAT_NOTE || "USt-befreit gem. § 19 UStG",
//   };
// }

// function parseSort(query) {
//   const sortStr = String(query.sort || "issuedAt:desc");
//   const [field, dir] = sortStr.split(":");
//   return {
//     key: field || "issuedAt",
//     mul: dir === "asc" ? 1 : -1,
//   };
// }

// function sortDocs(items, sortKey, sortMul) {
//   items.sort((a, b) => {
//     const av = new Date(a?.[sortKey] || 0).getTime();
//     const bv = new Date(b?.[sortKey] || 0).getTime();
//     if (av === bv) return 0;
//     return (av < bv ? -1 : 1) * sortMul;
//   });
// }

// function loadDunningDocsForCustomer(owner, customer) {
//   const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const bookingIds = bookings
//     .map((b) => String(b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return [];

//   return BillingDocument.find({
//     owner: String(owner),
//     kind: "dunning",
//     bookingId: { $in: bookingIds },
//   })
//     .sort({ sentAt: -1, createdAt: -1 })
//     .lean();
// }

// function bookingByIdMap(customer) {
//   return new Map(
//     (customer.bookings || []).map((b) => [String(b?._id || ""), b]),
//   );
// }

// function offerCsvFields(b, offer, doc) {
//   return {
//     offerTitle: b?.offerTitle || offer?.title || doc?.offerTitle || "",
//     offerType:
//       b?.offerType || offer?.sub_type || offer?.type || doc?.offerType || "",
//     venue: b?.venue || offer?.location || "",
//   };
// }

// function refInvoiceFields(doc, booking, normalizeInvoiceNo) {
//   if (
//     doc.type === "participation" ||
//     doc.type === "dunning" ||
//     doc.type === "creditnote"
//   ) {
//     return { refInvoiceNo: "", refInvoiceDate: "" };
//   }

//   return {
//     refInvoiceNo: normalizeInvoiceNo(
//       booking?.refInvoiceNo ||
//         booking?.invoiceNumber ||
//         booking?.invoiceNo ||
//         "",
//     ),
//     refInvoiceDate: fmtDeDate(
//       booking?.refInvoiceDate || booking?.invoiceDate || null,
//     ),
//   };
// }

// function amountFields(doc, booking, offer) {
//   const isDunning = doc.type === "dunning";
//   const isPart = doc.type === "participation";
//   const isStorno = doc.type === "storno";
//   const isCredit = doc.type === "creditnote";

//   const bookingPrice =
//     booking?.priceAtBooking ??
//     booking?.priceMonthly ??
//     booking?.price ??
//     offer?.price ??
//     0;

//   const creditAmount =
//     doc.type === "creditnote"
//       ? Math.abs(
//           toNumber(
//             doc.amount,
//             toNumber(doc.finalPrice, toNumber(bookingPrice, 0)),
//           ),
//         )
//       : 0;

//   const basePrice = isDunning
//     ? toNumber(doc.totalExtraFees, 0)
//     : isStorno
//       ? toNumber(
//           doc.stornoAmount,
//           toNumber(booking?.stornoAmount, toNumber(bookingPrice, 0)),
//         )
//       : isPart
//         ? toNumber(bookingPrice, 0)
//         : isCredit
//           ? creditAmount
//           : 0;

//   const unitNet = Math.round(basePrice * 100) / 100;
//   const vatRate = 0;
//   const vatAmount = 0;
//   const totalAmount = unitNet + vatAmount;

//   return {
//     price: isDunning ? unitNet : doc.type === "cancellation" ? "" : unitNet,
//     unitNet,
//     vatRate,
//     vatAmount,
//     totalAmount,
//   };
// }

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function isCreditInvoiceRef(ref) {
//   const note = safeText(ref?.note).toLowerCase();
//   const number = safeText(ref?.number);
//   const amount = Number(ref?.amount);

//   if (note.includes("gutschrift")) return true;
//   if (number.toUpperCase().startsWith("GS")) return true;
//   if (Number.isFinite(amount) && amount < 0) return true;

//   return false;
// }

// function buildCustomerCreditNoteDocs(customer) {
//   const customerId = safeText(customer?._id);
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const out = [];

//   for (const ref of refs) {
//     const bookingId = safeText(ref?.bookingId || ref?._id);
//     if (!bookingId) continue;

//     const invoiceRefs = Array.isArray(ref?.invoiceRefs) ? ref.invoiceRefs : [];
//     const creditRefs = invoiceRefs.filter(isCreditInvoiceRef);

//     for (const creditRef of creditRefs) {
//       const creditNoteNo = safeText(creditRef?.number);
//       if (!creditNoteNo) continue;

//       out.push({
//         id: `${bookingId}:creditnote:${creditNoteNo}`,
//         bookingId,
//         customerId,
//         type: "creditnote",
//         title: `Gutschrift – ${safeText(ref.offerTitle || ref.offerType || "Angebot")}`,
//         issuedAt:
//           creditRef?.date ||
//           ref.returnedAt ||
//           ref.updatedAt ||
//           ref.createdAt ||
//           new Date(),
//         href: `/api/admin/customers/${encodeURIComponent(
//           customerId,
//         )}/bookings/${encodeURIComponent(bookingId)}/credit-note.pdf`,
//         offerTitle: safeText(ref.offerTitle),
//         offerType: safeText(ref.offerType),
//         currency: safeText(ref.currency) || "EUR",
//         creditNoteNo,
//         invoiceNo: creditNoteNo,
//         invoiceNumber: creditNoteNo,
//         amount: creditRef?.amount,
//         finalPrice: creditRef?.finalPrice,
//       });
//     }
//   }

//   return out;
// }

// async function exportCustomerDocumentsCsv(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   normalizeInvoiceNo,
// ) {
//   try {
//     req.query.page = "1";
//     req.query.limit = "1000000";

//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const typeParam = String(req.query.type || "").trim();
//     const typeSet = new Set(
//       typeParam
//         ? typeParam
//             .split(",")
//             .map((s) => s.trim().toLowerCase())
//             .filter(Boolean)
//         : [],
//     );

//     const from = parseDate(req.query.from);
//     const to = parseDate(req.query.to);
//     const q = String(req.query.q || "").trim();
//     const { key: sortKey, mul: sortMul } = parseSort(req.query);

//     const selectedIds = new Set(
//       String(req.query.ids || "")
//         .split(",")
//         .map((s) => s.trim())
//         .filter(Boolean),
//     );

//     const customer = await Customer.findOne({ _id: id, owner }).lean();
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const bookingMap = bookingByIdMap(customer);

//     const offerIds = [
//       ...new Set(
//         (customer.bookings || [])
//           .map((b) => String(b.offerId || ""))
//           .filter((v) => v && mongoose.isValidObjectId(v)),
//       ),
//     ];

//     const offers = offerIds.length
//       ? await Offer.find({ _id: { $in: offerIds } })
//           .select("_id title type sub_type location price")
//           .lean()
//       : [];

//     const offerById = new Map(offers.map((o) => [String(o._id), o]));
//     const bookingDocs = buildCustomerDocs(customer);
//     const creditNoteDocs = buildCustomerCreditNoteDocs(customer);
//     const dunningSource = await loadDunningDocsForCustomer(owner, customer);
//     const dunningDocs = buildCustomerDunningDocs(customer, dunningSource);

//     let filtered = [...bookingDocs, ...creditNoteDocs, ...dunningDocs].filter(
//       (d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q),
//     );

//     if (selectedIds.size) {
//       filtered = filtered.filter((d) => selectedIds.has(String(d.id || "")));
//     }

//     if (from) filtered = filtered.filter((d) => new Date(d.issuedAt) >= from);
//     if (to) filtered = filtered.filter((d) => new Date(d.issuedAt) <= to);

//     sortDocs(filtered, sortKey, sortMul);

//     const brand = getBrand();
//     const headers = csvHeaders();

//     res.setHeader("Content-Type", "text/csv; charset=utf-8");
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="customer-${id}-documents.csv"`,
//     );

//     res.write(headers.join(",") + "\n");

//     for (const d of filtered) {
//       const b = bookingMap.get(String(d.bookingId || "")) || {};
//       const offer = (b.offerId && offerById.get(String(b.offerId))) || null;
//       const { offerTitle, offerType, venue } = offerCsvFields(b, offer, d);
//       const { refInvoiceNo, refInvoiceDate } = refInvoiceFields(
//         d,
//         b,
//         normalizeInvoiceNo,
//       );
//       const amounts = amountFields(d, b, offer);

//       const invoiceNo = normalizeInvoiceNo(
//         d.type === "creditnote"
//           ? d.creditNoteNo || d.invoiceNo || d.invoiceNumber || ""
//           : d.invoiceNo || b.invoiceNumber || b.invoiceNo || "",
//       );

//       const invoiceDate = d.invoiceDate || b.invoiceDate || d.issuedAt || null;

//       const cancellationNo =
//         d.type === "cancellation"
//           ? d.cancellationNo || b.cancellationNo || b.cancellationNumber || ""
//           : "";

//       const stornoNo =
//         d.type === "storno"
//           ? d.stornoNo || b.stornoNo || b.stornoNumber || ""
//           : "";

//       const stornoAmount =
//         d.type === "storno"
//           ? toNumber(d.stornoAmount, toNumber(b.stornoAmount, 0)).toFixed(2)
//           : "";

//       const originalInvoiceAmount = toNumber(
//         d.originalInvoiceAmount,
//         b.priceAtBooking ?? b.priceMonthly ?? b.price ?? 0,
//       );
//       const returnBankFee = toNumber(d.returnBankFee, b.returnBankFee ?? 0);
//       const dunningFee = toNumber(d.dunningFee, 0);
//       const processingFee = toNumber(d.processingFee, 0);
//       const totalExtraFees = toNumber(
//         d.totalExtraFees,
//         returnBankFee + dunningFee + processingFee,
//       );
//       const dunningTotalAmount = toNumber(
//         d.dunningTotalAmount,
//         originalInvoiceAmount + totalExtraFees,
//       );

//       const row = [
//         d.id || "",
//         d.bookingId || "",
//         d.type || "",
//         d.title || "",
//         fmtDeDate(d.issuedAt),
//         d.status || "",
//         offerTitle || "",
//         offerType || "",
//         venue || "",
//         amounts.price === "" ? "" : Number(amounts.price).toFixed(2),
//         d.currency || b.currency || "EUR",
//         d.href || "",
//         invoiceNo || "",
//         d.type === "creditnote" ? d.creditNoteNo || invoiceNo || "" : "",
//         fmtDeDate(invoiceDate),
//         refInvoiceNo || "",
//         refInvoiceDate || "",
//         cancellationNo || "",
//         stornoNo || "",
//         stornoAmount,
//         brand.company,
//         brand.street,
//         brand.zip,
//         brand.city,
//         brand.country,
//         d.title || "",
//         1,
//         amounts.unitNet.toFixed(2),
//         amounts.vatRate,
//         amounts.vatAmount.toFixed(2),
//         amounts.totalAmount.toFixed(2),
//         brand.iban,
//         brand.bic,
//         brand.taxId,
//         brand.email,
//         brand.website,
//         brand.vatNote,
//         d.type === "dunning" ? d.stage || "" : "",
//         d.type === "dunning" ? d.subject || "" : "",
//         d.type === "dunning" ? originalInvoiceAmount.toFixed(2) : "",
//         d.type === "dunning" ? returnBankFee.toFixed(2) : "",
//         d.type === "dunning" ? dunningFee.toFixed(2) : "",
//         d.type === "dunning" ? processingFee.toFixed(2) : "",
//         d.type === "dunning" ? totalExtraFees.toFixed(2) : "",
//         d.type === "dunning" ? dunningTotalAmount.toFixed(2) : "",
//         d.type === "dunning" ? d.currency || "EUR" : "",
//         d.type === "dunning" ? dunningStageLabel(d.stage) : "",
//         d.type === "dunning" ? fmtDeDate(d.dueAt) : "",
//         d.type === "dunning" ? d.fileName || "" : "",
//       ]
//         .map(escCsv)
//         .join(",");

//       res.write(row + "\n");
//     }

//     res.end();
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { exportCustomerDocumentsCsv };
