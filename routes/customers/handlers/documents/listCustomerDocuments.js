//routes\customers\handlers\documents\listCustomerDocuments.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const BillingDocument = require("../../../../models/BillingDocument");
const Booking = require("../../../../models/Booking");

const {
  docMatchesType,
  docMatchesQuery,
  parseDate,
} = require("../../helpers/documents/docMatchers");

const {
  buildCustomerDocs,
  buildCustomerDunningDocs,
} = require("../../helpers/documents/buildCustomerDocs");

function docPriority(type) {
  if (type === "invoice") return 4;
  if (type === "participation") return 3;
  if (type === "storno") return 2;
  if (type === "cancellation") return 1;
  return 0;
}

function dedupeDocs(items) {
  const map = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const bookingId = safeText(item?.bookingId);
    const invoiceNo = safeText(
      item?.invoiceNo || item?.invoiceNumber || item?.creditNoteNo,
    );
    const type = safeText(item?.type).toLowerCase();

    if (!bookingId || !invoiceNo) {
      map.set(String(item?.id || Math.random()), item);
      continue;
    }

    // const key = `${bookingId}::${invoiceNo}`;

    const stage = safeText(item?.stage).toLowerCase();

    const key =
      type === "dunning"
        ? `${bookingId}::${invoiceNo}::${type}::${stage}`
        : `${bookingId}::${invoiceNo}::${type}`;

    const existing = map.get(key);

    if (!existing) {
      map.set(key, item);
      continue;
    }

    const existingType = safeText(existing?.type).toLowerCase();

    if (docPriority(type) > docPriority(existingType)) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
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

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bookingBaseAmount(booking) {
  if (booking?.priceMonthly != null) return toNumber(booking.priceMonthly, 0);
  if (booking?.priceAtBooking != null)
    return toNumber(booking.priceAtBooking, 0);
  if (booking?.price != null) return toNumber(booking.price, 0);
  return 0;
}

function bookingMapFrom(customer) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  return new Map(refs.map((b) => [safeText(b?.bookingId || b?._id), b]));
}

function resolveDiscountMeta(booking) {
  const discount =
    booking?.discount && typeof booking.discount === "object"
      ? booking.discount
      : booking?.meta?.discount && typeof booking.meta.discount === "object"
        ? booking.meta.discount
        : {};

  return {
    voucherCode: safeText(discount?.voucherCode || booking?.meta?.voucherCode),
    voucherDiscount: toNumber(discount?.voucherDiscount, 0),
    totalDiscount: toNumber(discount?.totalDiscount, 0),
    finalPrice: toNumber(
      discount?.finalPrice,
      booking?.priceAtBooking ?? booking?.priceMonthly ?? booking?.price ?? 0,
    ),
  };
}

function recurringInvoiceHref(customerId, docId) {
  return `/api/admin/customers/${encodeURIComponent(
    customerId,
  )}/documents/billing-invoices/${encodeURIComponent(docId)}/download`;
}

function buildBillingInvoiceDocs(customer, billingDocs) {
  const customerId = safeText(customer?._id);
  const bookingById = bookingMapFrom(customer);
  const out = [];

  for (const doc of billingDocs || []) {
    const docId = safeText(doc?._id);
    const bookingId = safeText(doc?.bookingId);
    if (!docId || !bookingId) continue;

    const booking = bookingById.get(bookingId);
    if (!booking) continue;

    const invoiceNo = safeText(doc?.invoiceNo);
    const discount = resolveDiscountMeta(booking);
    const titleBase = safeText(
      booking?.offerTitle || doc?.offerTitle || "Angebot",
    );

    out.push({
      id: `invoice:${docId}`,
      bookingId,
      customerId,
      type: "invoice",
      title: `Rechnung – ${titleBase}`,
      issuedAt: doc?.invoiceDate || doc?.sentAt || doc?.createdAt || null,
      href: recurringInvoiceHref(customerId, docId),
      offerTitle: safeText(booking?.offerTitle || doc?.offerTitle),
      offerType: safeText(booking?.offerType),
      status: safeText(booking?.status) || "open",
      currency: safeText(doc?.currency || booking?.currency) || "EUR",
      invoiceNo,
      invoiceDate: doc?.invoiceDate || null,
      fileName: safeText(doc?.fileName),
      filePath: safeText(doc?.filePath),
      amount: bookingBaseAmount(booking),
      voucherCode: discount.voucherCode,
      voucherDiscount: discount.voucherDiscount,
      totalDiscount: discount.totalDiscount,
      finalPrice: discount.finalPrice,
      childUid: safeText(booking?.childUid),
      childFirstName: safeText(booking?.childFirstName),
      childLastName: safeText(booking?.childLastName),
    });
  }

  return out;
}

async function loadInvoiceDocsForCustomer(owner, customer) {
  const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];
  const bookingIds = bookings
    .map((b) => String(b?.bookingId || b?._id || ""))
    .filter((v) => v && mongoose.isValidObjectId(v));

  if (!bookingIds.length) return [];

  return BillingDocument.find({
    owner: String(owner),
    kind: "invoice",
    bookingId: { $in: bookingIds },
    voidedAt: null,
  })
    .sort({ invoiceDate: -1, createdAt: -1 })
    .lean();
}

async function loadBookingParentMap(owner, bookingRefs) {
  const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
    .map((b) => String(b?.bookingId || b?._id || ""))
    .filter((v) => v && mongoose.isValidObjectId(v));

  if (!bookingIds.length) return new Map();

  const docs = await Booking.find(
    { _id: { $in: bookingIds }, owner: String(owner) },
    {
      childUid: 1,
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
        bookingChildUid: safeText(d?.childUid),
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
      bookingChildUid: safeText(meta.bookingChildUid),
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

function contractHref(bid) {
  return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/contract`;
}

function baseTitleFrom(ref) {
  return String(ref?.offerTitle || ref?.offerType || "Angebot").trim();
}

function refIdOf(ref) {
  return String(ref?.bookingId || ref?._id || "").trim();
}

function buildContractDocsFromMap(customer, bookingRefs, metaMap) {
  const cid = String(customer?._id || "");
  const out = [];

  for (const ref of bookingRefs || []) {
    const bid = refIdOf(ref);
    if (!bid) continue;

    const doc = metaMap.get(bid);
    const meta = doc?.meta || {};
    if (!hasContractMeta(meta)) continue;

    out.push({
      id: `${bid}:contract`,
      type: "contract",
      title: `Vertrag – ${baseTitleFrom(ref)}`,
      issuedAt: meta.contractSignedAt,
      href: contractHref(bid),
      bookingId: bid,
      customerId: cid,
      offerTitle: safeText(ref.offerTitle),
      offerType: safeText(ref.offerType),
      status: safeText(ref.status) || "open",
      currency: safeText(ref.currency) || "EUR",
      childUid: safeText(ref.childUid),
      childFirstName: safeText(ref.childFirstName),
      childLastName: safeText(ref.childLastName),
    });
  }

  return out;
}

function childNameMatches(ref, childFirst, childLast) {
  const first = safeLower(ref?.childFirstName || ref?.firstName || "");
  const last = safeLower(ref?.childLastName || ref?.lastName || "");

  if (childFirst && safeLower(childFirst) !== first) return false;
  if (childLast && safeLower(childLast) !== last) return false;
  return Boolean(childFirst || childLast);
}

function matchesChildFilter(ref, childUid, childFirst, childLast) {
  const uid = safeText(ref?.childUid);
  if (!childUid && !childFirst && !childLast) return true;
  if (childUid && uid && childUid === uid) return true;
  return childNameMatches(ref, childFirst, childLast);
}

function creditNoteHref(customerId, bookingId) {
  return `/api/admin/customers/${encodeURIComponent(
    customerId,
  )}/bookings/${encodeURIComponent(bookingId)}/credit-note.pdf`;
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

function buildCustomerCreditNoteDocs(customer, opts = {}) {
  const customerId = safeText(customer?._id);
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

  const childUid = safeText(opts.childUid);
  const childFirst = safeText(opts.childFirst);
  const childLast = safeText(opts.childLast);

  const out = [];

  for (const ref of refs) {
    const bookingId = safeText(ref?.bookingId || ref?._id);
    if (!bookingId) continue;

    if (!matchesChildFilter(ref, childUid, childFirst, childLast)) continue;

    const invoiceRefs = Array.isArray(ref?.invoiceRefs) ? ref.invoiceRefs : [];
    const creditRefs = invoiceRefs.filter(isCreditInvoiceRef);

    for (const creditRef of creditRefs) {
      const creditNoteNo = safeText(creditRef?.number);
      if (!creditNoteNo) continue;

      const issuedAt =
        creditRef?.date ||
        ref?.returnedAt ||
        ref?.updatedAt ||
        ref?.createdAt ||
        new Date();

      const offerTitle = safeText(ref.offerTitle || ref.offerType || "Angebot");

      out.push({
        id: `${bookingId}:creditnote:${creditNoteNo}`,
        type: "creditnote",
        title: `Gutschrift – ${offerTitle}`,
        issuedAt,
        href: creditNoteHref(customerId, bookingId),
        bookingId,
        customerId,
        offerTitle: safeText(ref.offerTitle),
        offerType: safeText(ref.offerType),
        status: safeText(ref.status) || "open",
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

async function listCustomerDocuments(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));

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

    const childUid = safeText(req.query.childUid);
    const childFirst = safeText(req.query.childFirst);
    const childLast = safeText(req.query.childLast);

    const scope = safeText(req.query.scope).toLowerCase();
    const parentEmail = safeLower(req.query.parentEmail);

    const customer = await Customer.findOne({ _id: id, owner }).lean();
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const bookingRefs = Array.isArray(customer?.bookings)
      ? customer.bookings
      : [];

    const bookingParentMap = await loadBookingParentMap(owner, bookingRefs);

    const bookingDocs = buildCustomerDocs(customer, {
      childUid,
      childFirst,
      childLast,
    });

    const creditNoteDocs = buildCustomerCreditNoteDocs(customer, {
      childUid,
      childFirst,
      childLast,
    });

    const invoiceSource = await loadInvoiceDocsForCustomer(owner, customer);
    const invoiceDocs = buildBillingInvoiceDocs(customer, invoiceSource);

    const dunningSource = await loadDunningDocsForCustomer(owner, customer);
    const dunningDocs = buildCustomerDunningDocs(customer, dunningSource);

    const wantContract = !typeSet.size || typeSet.has("contract");
    const contractMetaMap = wantContract
      ? await loadContractMetaMap(owner, bookingRefs)
      : new Map();

    const contractDocs = wantContract
      ? buildContractDocsFromMap(customer, bookingRefs, contractMetaMap)
      : [];

    // let filtered = attachParentMeta(
    //   [
    //     ...bookingDocs,
    //     ...invoiceDocs,
    //     ...creditNoteDocs,
    //     ...contractDocs,
    //     ...dunningDocs,
    //   ],
    //   bookingParentMap,
    // );

    let filtered = attachParentMeta(
      [
        ...bookingDocs,
        ...invoiceDocs,
        ...creditNoteDocs,
        ...contractDocs,
        ...dunningDocs,
      ],
      bookingParentMap,
    );

    filtered = dedupeDocs(filtered);

    filtered = filtered.filter((d) => docMatchesType(d, typeSet));
    filtered = filtered.filter((d) => docMatchesQuery(d, q));

    if (childUid) {
      filtered = filtered.filter((d) => safeText(d?.childUid) === childUid);
    }

    // if (childUid) {
    //   filtered = filtered.filter((d) => {
    //     return safeText(d?.childUid || d?.bookingChildUid) === childUid;
    //   });
    // }

    if (parentEmail) {
      filtered = filtered.filter(
        (d) => safeLower(d?.parentEmail) === parentEmail,
      );
    }

    if (scope === "self") {
      filtered = filtered.filter((d) => !safeText(d?.bookingChildUid));
    }

    if (scope === "child") {
      filtered = filtered.filter((d) => safeText(d?.bookingChildUid));
    }

    if (from) {
      filtered = filtered.filter((d) => new Date(d.issuedAt) >= from);
    }

    if (to) {
      filtered = filtered.filter((d) => new Date(d.issuedAt) <= to);
    }

    sortDocs(filtered, sortKey, sortMul);

    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    return res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    console.error("[documents] error", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { listCustomerDocuments };

// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const BillingDocument = require("../../../../models/BillingDocument");
// const Booking = require("../../../../models/Booking");

// const {
//   docMatchesType,
//   docMatchesQuery,
//   parseDate,
// } = require("../../helpers/documents/docMatchers");

// const {
//   buildCustomerDocs,
//   buildCustomerDunningDocs,
// } = require("../../helpers/documents/buildCustomerDocs");

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
//     .map((b) => String(b?.bookingId || b?._id || ""))
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

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function safeLower(v) {
//   return safeText(v).toLowerCase();
// }

// function toNumber(value, fallback = 0) {
//   const n = Number(value);
//   return Number.isFinite(n) ? n : fallback;
// }

// function bookingBaseAmount(booking) {
//   if (booking?.priceMonthly != null) return toNumber(booking.priceMonthly, 0);
//   if (booking?.priceAtBooking != null)
//     return toNumber(booking.priceAtBooking, 0);
//   if (booking?.price != null) return toNumber(booking.price, 0);
//   return 0;
// }

// function bookingMapFrom(customer) {
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   return new Map(refs.map((b) => [safeText(b?.bookingId || b?._id), b]));
// }

// function bookingInvoiceNo(booking) {
//   return safeText(booking?.invoiceNumber || booking?.invoiceNo);
// }

// function resolveDiscountMeta(booking) {
//   const discount =
//     booking?.discount && typeof booking.discount === "object"
//       ? booking.discount
//       : booking?.meta?.discount && typeof booking.meta.discount === "object"
//         ? booking.meta.discount
//         : {};

//   return {
//     voucherCode: safeText(discount?.voucherCode || booking?.meta?.voucherCode),
//     voucherDiscount: toNumber(discount?.voucherDiscount, 0),
//     totalDiscount: toNumber(discount?.totalDiscount, 0),
//     finalPrice: toNumber(
//       discount?.finalPrice,
//       booking?.priceAtBooking ?? booking?.priceMonthly ?? booking?.price ?? 0,
//     ),
//   };
// }

// function recurringInvoiceHref(customerId, docId) {
//   return `/api/admin/customers/${encodeURIComponent(
//     customerId,
//   )}/documents/billing-invoices/${encodeURIComponent(docId)}/download`;
// }

// function buildBillingInvoiceDocs(customer, billingDocs) {
//   const customerId = safeText(customer?._id);
//   const bookingById = bookingMapFrom(customer);
//   const out = [];

//   for (const doc of billingDocs || []) {
//     const docId = safeText(doc?._id);
//     const bookingId = safeText(doc?.bookingId);
//     if (!docId || !bookingId) continue;

//     const booking = bookingById.get(bookingId);
//     if (!booking) continue;

//     const invoiceNo = safeText(doc?.invoiceNo);
//     // const primaryBookingInvoiceNo = bookingInvoiceNo(booking);

//     // if (
//     //   invoiceNo &&
//     //   primaryBookingInvoiceNo &&
//     //   invoiceNo === primaryBookingInvoiceNo
//     // ) {
//     //   // console.log("[documents] skip recurring invoice duplicate", {
//     //   //   bookingId,
//     //   //   invoiceNo,
//     //   //   primaryBookingInvoiceNo,
//     //   // });
//     //   continue;
//     // }

//     const discount = resolveDiscountMeta(booking);
//     const titleBase = safeText(
//       booking?.offerTitle || doc?.offerTitle || "Angebot",
//     );

//     out.push({
//       id: `invoice:${docId}`,
//       bookingId,
//       customerId,
//       type: "invoice",
//       title: `Rechnung – ${titleBase}`,
//       issuedAt: doc?.invoiceDate || doc?.sentAt || doc?.createdAt || null,
//       href: recurringInvoiceHref(customerId, docId),
//       offerTitle: safeText(booking?.offerTitle || doc?.offerTitle),
//       offerType: safeText(booking?.offerType),
//       status: safeText(booking?.status) || "open",
//       currency: safeText(doc?.currency || booking?.currency) || "EUR",
//       invoiceNo,
//       invoiceDate: doc?.invoiceDate || null,
//       fileName: safeText(doc?.fileName),
//       filePath: safeText(doc?.filePath),
//       amount: bookingBaseAmount(booking),
//       voucherCode: discount.voucherCode,
//       voucherDiscount: discount.voucherDiscount,
//       totalDiscount: discount.totalDiscount,
//       finalPrice: discount.finalPrice,
//       childUid: safeText(booking?.childUid),
//       childFirstName: safeText(booking?.childFirstName),
//       childLastName: safeText(booking?.childLastName),
//     });
//   }

//   return out;
// }

// async function loadInvoiceDocsForCustomer(owner, customer) {
//   const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const bookingIds = bookings
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return [];

//   return BillingDocument.find({
//     owner: String(owner),
//     kind: "invoice",
//     bookingId: { $in: bookingIds },
//     voidedAt: null,
//   })
//     .sort({ invoiceDate: -1, createdAt: -1 })
//     .lean();
// }

// async function loadBookingParentMap(owner, bookingRefs) {
//   const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return new Map();

//   const docs = await Booking.find(
//     { _id: { $in: bookingIds }, owner: String(owner) },
//     {
//       "invoiceTo.parent.email": 1,
//       "invoiceTo.parent.firstName": 1,
//       "invoiceTo.parent.lastName": 1,
//     },
//   )
//     .lean()
//     .catch(() => []);

//   return new Map(
//     docs.map((d) => [
//       String(d._id),
//       {
//         parentEmail: safeLower(d?.invoiceTo?.parent?.email),
//         parentFirstName: safeText(d?.invoiceTo?.parent?.firstName),
//         parentLastName: safeText(d?.invoiceTo?.parent?.lastName),
//       },
//     ]),
//   );
// }

// function attachParentMeta(items, parentMap) {
//   return (Array.isArray(items) ? items : []).map((item) => {
//     const meta = parentMap.get(String(item?.bookingId || "")) || {};
//     return {
//       ...item,
//       parentEmail: safeLower(meta.parentEmail),
//       parentFirstName: safeText(meta.parentFirstName),
//       parentLastName: safeText(meta.parentLastName),
//     };
//   });
// }

// function hasContractMeta(meta) {
//   const signedAt = safeText(meta?.contractSignedAt);
//   const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
//   return Boolean(signedAt && html);
// }

// async function loadContractMetaMap(owner, bookingRefs) {
//   const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return new Map();

//   const docs = await Booking.find(
//     { _id: { $in: bookingIds }, owner: String(owner) },
//     {
//       "meta.contractSignedAt": 1,
//       "meta.contractSnapshot.contractDoc": 1,
//     },
//   )
//     .lean()
//     .catch(() => []);

//   return new Map(docs.map((d) => [String(d._id), d]));
// }

// function contractHref(bid) {
//   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/contract`;
// }

// function baseTitleFrom(ref) {
//   return String(ref?.offerTitle || ref?.offerType || "Angebot").trim();
// }

// function refIdOf(ref) {
//   return String(ref?.bookingId || ref?._id || "").trim();
// }

// function buildContractDocsFromMap(customer, bookingRefs, metaMap) {
//   const cid = String(customer?._id || "");
//   const out = [];

//   for (const ref of bookingRefs || []) {
//     const bid = refIdOf(ref);
//     if (!bid) continue;

//     const doc = metaMap.get(bid);
//     const meta = doc?.meta || {};
//     if (!hasContractMeta(meta)) continue;

//     out.push({
//       id: `${bid}:contract`,
//       type: "contract",
//       title: `Vertrag – ${baseTitleFrom(ref)}`,
//       issuedAt: meta.contractSignedAt,
//       href: contractHref(bid),
//       bookingId: bid,
//       customerId: cid,
//       offerTitle: safeText(ref.offerTitle),
//       offerType: safeText(ref.offerType),
//       status: safeText(ref.status) || "open",
//       currency: safeText(ref.currency) || "EUR",
//       childUid: safeText(ref.childUid),
//       childFirstName: safeText(ref.childFirstName),
//       childLastName: safeText(ref.childLastName),
//     });
//   }

//   return out;
// }

// function childNameMatches(ref, childFirst, childLast) {
//   const first = safeLower(ref?.childFirstName || ref?.firstName || "");
//   const last = safeLower(ref?.childLastName || ref?.lastName || "");

//   if (childFirst && safeLower(childFirst) !== first) return false;
//   if (childLast && safeLower(childLast) !== last) return false;
//   return Boolean(childFirst || childLast);
// }

// function matchesChildFilter(ref, childUid, childFirst, childLast) {
//   const uid = safeText(ref?.childUid);
//   if (!childUid && !childFirst && !childLast) return true;
//   if (childUid && uid && childUid === uid) return true;
//   return childNameMatches(ref, childFirst, childLast);
// }

// function creditNoteHref(customerId, bookingId) {
//   return `/api/admin/customers/${encodeURIComponent(
//     customerId,
//   )}/bookings/${encodeURIComponent(bookingId)}/credit-note.pdf`;
// }

// function isCreditInvoiceRef(ref) {
//   const note = safeLower(ref?.note);
//   const number = safeText(ref?.number);
//   const amount = Number(ref?.amount);

//   if (note.includes("gutschrift")) return true;
//   if (number.toUpperCase().startsWith("GS")) return true;
//   if (Number.isFinite(amount) && amount < 0) return true;

//   return false;
// }

// function buildCustomerCreditNoteDocs(customer, opts = {}) {
//   const customerId = safeText(customer?._id);
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

//   const childUid = safeText(opts.childUid);
//   const childFirst = safeText(opts.childFirst);
//   const childLast = safeText(opts.childLast);

//   const out = [];

//   for (const ref of refs) {
//     const bookingId = safeText(ref?.bookingId || ref?._id);
//     if (!bookingId) continue;

//     if (!matchesChildFilter(ref, childUid, childFirst, childLast)) continue;

//     const invoiceRefs = Array.isArray(ref?.invoiceRefs) ? ref.invoiceRefs : [];
//     const creditRefs = invoiceRefs.filter(isCreditInvoiceRef);

//     for (const creditRef of creditRefs) {
//       const creditNoteNo = safeText(creditRef?.number);
//       if (!creditNoteNo) continue;

//       const issuedAt =
//         creditRef?.date ||
//         ref?.returnedAt ||
//         ref?.updatedAt ||
//         ref?.createdAt ||
//         new Date();

//       const offerTitle = safeText(ref.offerTitle || ref.offerType || "Angebot");

//       out.push({
//         id: `${bookingId}:creditnote:${creditNoteNo}`,
//         type: "creditnote",
//         title: `Gutschrift – ${offerTitle}`,
//         issuedAt,
//         href: creditNoteHref(customerId, bookingId),
//         bookingId,
//         customerId,
//         offerTitle: safeText(ref.offerTitle),
//         offerType: safeText(ref.offerType),
//         status: safeText(ref.status) || "open",
//         currency: safeText(ref.currency) || "EUR",
//         creditNoteNo,
//         invoiceNo: creditNoteNo,
//         invoiceNumber: creditNoteNo,
//         amount: creditRef?.amount,
//         finalPrice: creditRef?.finalPrice,
//         childUid: safeText(ref.childUid),
//         childFirstName: safeText(ref.childFirstName),
//         childLastName: safeText(ref.childLastName),
//       });
//     }
//   }

//   return out;
// }

// function summarizeDocs(items) {
//   return (Array.isArray(items) ? items : []).map((d) => ({
//     id: safeText(d?.id),
//     type: safeText(d?.type),
//     bookingId: safeText(d?.bookingId),
//     childUid: safeText(d?.childUid),
//     childFirstName: safeText(d?.childFirstName),
//     childLastName: safeText(d?.childLastName),
//     parentEmail: safeLower(d?.parentEmail),
//     invoiceNo: safeText(d?.invoiceNo || d?.invoiceNumber),
//     title: safeText(d?.title),
//   }));
// }

// async function listCustomerDocuments(req, res, requireOwner, requireId) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const page = Math.max(1, Number(req.query.page || 1));
//     const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));

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

//     const childUid = safeText(req.query.childUid);
//     const childFirst = safeText(req.query.childFirst);
//     const childLast = safeText(req.query.childLast);

//     const scope = safeText(req.query.scope).toLowerCase();
//     const parentEmail = safeLower(req.query.parentEmail);

//     // console.log("[documents] query", {
//     //   customerId: String(id),
//     //   page,
//     //   limit,
//     //   scope,
//     //   childUid,
//     //   childFirst,
//     //   childLast,
//     //   parentEmail,
//     //   q,
//     //   sortKey,
//     //   sortMul,
//     //   types: [...typeSet],
//     //   from,
//     //   to,
//     // });

//     const customer = await Customer.findOne({ _id: id, owner }).lean();
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const bookingRefs = Array.isArray(customer?.bookings)
//       ? customer.bookings
//       : [];

//     // console.log(
//     //   "[documents] bookingRefs:last10",
//     //   bookingRefs.slice(-10).map((b) => ({
//     //     bookingId: safeText(b?.bookingId || b?._id),
//     //     offerType: safeText(b?.offerType),
//     //     childUid: safeText(b?.childUid),
//     //     childFirstName: safeText(b?.childFirstName),
//     //     childLastName: safeText(b?.childLastName),
//     //     parentEmail: safeLower(b?.parentEmail),
//     //     invoiceNumber: safeText(b?.invoiceNumber || b?.invoiceNo),
//     //   })),
//     // );

//     const bookingParentMap = await loadBookingParentMap(owner, bookingRefs);

//     const distinctChildUids = new Set(
//       bookingRefs.map((b) => safeText(b?.childUid)).filter(Boolean),
//     );

//     if (!scope && !childUid && distinctChildUids.size > 1) {
//       const debugInvoiceNo = "RAC-26-0102";

//       const debugAll = filtered.filter((d) => {
//         const invoiceNo = safeText(
//           d?.invoiceNo || d?.invoiceNumber || d?.creditNoteNo,
//         );
//         return invoiceNo === debugInvoiceNo;
//       });

//       console.log("[documents debug invoice]", {
//         debugInvoiceNo,
//         scope,
//         parentEmail,
//         childUid,
//         totalMatching: debugAll.length,
//         matching: debugAll.map((d) => ({
//           id: d.id,
//           type: d.type,
//           bookingId: d.bookingId,
//           invoiceNo: d.invoiceNo || d.invoiceNumber || "",
//           childUid: d.childUid || "",
//           parentEmail: d.parentEmail || "",
//           title: d.title || "",
//         })),
//       });

//       return res.json({ ok: true, items: [], total: 0, page, limit });
//     }

//     const bookingDocs = buildCustomerDocs(customer, {
//       childUid,
//       childFirst,
//       childLast,
//     });

//     const creditNoteDocs = buildCustomerCreditNoteDocs(customer, {
//       childUid,
//       childFirst,
//       childLast,
//     });

//     const invoiceSource = await loadInvoiceDocsForCustomer(owner, customer);
//     const invoiceDocs = buildBillingInvoiceDocs(customer, invoiceSource);

//     const dunningSource = await loadDunningDocsForCustomer(owner, customer);
//     const dunningDocs = buildCustomerDunningDocs(customer, dunningSource);

//     const wantContract = !typeSet.size || typeSet.has("contract");
//     const contractMetaMap = wantContract
//       ? await loadContractMetaMap(owner, bookingRefs)
//       : new Map();

//     const contractDocs = wantContract
//       ? buildContractDocsFromMap(customer, bookingRefs, contractMetaMap)
//       : [];

//     let filtered = attachParentMeta(
//       [
//         ...bookingDocs,
//         ...invoiceDocs,
//         ...creditNoteDocs,
//         ...contractDocs,
//         ...dunningDocs,
//       ],
//       bookingParentMap,
//     );

//     filtered = filtered.filter((d) => docMatchesType(d, typeSet));

//     filtered = filtered.filter((d) => docMatchesQuery(d, q));

//     if (childUid) {
//       filtered = filtered.filter((d) => safeText(d?.childUid) === childUid);
//     }

//     if (parentEmail) {
//       filtered = filtered.filter(
//         (d) => safeLower(d?.parentEmail) === parentEmail,
//       );
//     }

//     if (scope === "self") {
//       filtered = filtered.filter((d) => !safeText(d?.childUid));
//     }

//     if (scope === "child") {
//       filtered = filtered.filter((d) => safeText(d?.childUid));
//     }

//     if (from) {
//       filtered = filtered.filter((d) => new Date(d.issuedAt) >= from);
//     }

//     if (to) {
//       filtered = filtered.filter((d) => new Date(d.issuedAt) <= to);
//     }

//     sortDocs(filtered, sortKey, sortMul);

//     const total = filtered.length;
//     const start = (page - 1) * limit;
//     const items = filtered.slice(start, start + limit);

//     return res.json({ ok: true, items, total, page, limit });
//   } catch (err) {
//     console.error("[documents] error", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { listCustomerDocuments };

// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const BillingDocument = require("../../../../models/BillingDocument");
// const Booking = require("../../../../models/Booking");

// const {
//   docMatchesType,
//   docMatchesQuery,
//   parseDate,
// } = require("../../helpers/documents/docMatchers");

// const {
//   buildCustomerDocs,
//   buildCustomerDunningDocs,
// } = require("../../helpers/documents/buildCustomerDocs");

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
//     .map((b) => String(b?.bookingId || b?._id || ""))
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

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function safeLower(v) {
//   return safeText(v).toLowerCase();
// }

// function toNumber(value, fallback = 0) {
//   const n = Number(value);
//   return Number.isFinite(n) ? n : fallback;
// }

// function bookingBaseAmount(booking) {
//   if (booking?.priceMonthly != null) return toNumber(booking.priceMonthly, 0);
//   if (booking?.priceAtBooking != null)
//     return toNumber(booking.priceAtBooking, 0);
//   if (booking?.price != null) return toNumber(booking.price, 0);
//   return 0;
// }

// function bookingMapFrom(customer) {
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   return new Map(refs.map((b) => [safeText(b?.bookingId || b?._id), b]));
// }

// function bookingInvoiceNo(booking) {
//   return safeText(booking?.invoiceNumber || booking?.invoiceNo);
// }

// function resolveDiscountMeta(booking) {
//   const discount =
//     booking?.discount && typeof booking.discount === "object"
//       ? booking.discount
//       : booking?.meta?.discount && typeof booking.meta.discount === "object"
//         ? booking.meta.discount
//         : {};

//   return {
//     voucherCode: safeText(discount?.voucherCode || booking?.meta?.voucherCode),
//     voucherDiscount: toNumber(discount?.voucherDiscount, 0),
//     totalDiscount: toNumber(discount?.totalDiscount, 0),
//     finalPrice: toNumber(
//       discount?.finalPrice,
//       booking?.priceAtBooking ?? booking?.priceMonthly ?? booking?.price ?? 0,
//     ),
//   };
// }

// // function recurringInvoiceHref(docId) {
// //   return `/api/admin/invoices/billing-documents/${encodeURIComponent(docId)}/download`;
// // }

// function recurringInvoiceHref(customerId, docId) {
//   return `/api/admin/customers/${encodeURIComponent(
//     customerId,
//   )}/documents/billing-invoices/${encodeURIComponent(docId)}/download`;
// }

// function buildBillingInvoiceDocs(customer, billingDocs) {
//   const customerId = safeText(customer?._id);
//   const bookingById = bookingMapFrom(customer);
//   const out = [];

//   for (const doc of billingDocs || []) {
//     const docId = safeText(doc?._id);
//     const bookingId = safeText(doc?.bookingId);
//     if (!docId || !bookingId) continue;

//     const booking = bookingById.get(bookingId);
//     if (!booking) continue;

//     const invoiceNo = safeText(doc?.invoiceNo);
//     const primaryBookingInvoiceNo = bookingInvoiceNo(booking);

//     if (
//       invoiceNo &&
//       primaryBookingInvoiceNo &&
//       invoiceNo === primaryBookingInvoiceNo
//     ) {
//       continue;
//     }

//     const discount = resolveDiscountMeta(booking);
//     const titleBase = safeText(
//       booking?.offerTitle || doc?.offerTitle || "Angebot",
//     );

//     out.push({
//       id: `invoice:${docId}`,
//       bookingId,
//       customerId,
//       type: "invoice",
//       title: `Rechnung – ${titleBase}`,
//       issuedAt: doc?.invoiceDate || doc?.sentAt || doc?.createdAt || null,
//       //  href: recurringInvoiceHref(docId),

//       href: recurringInvoiceHref(customerId, docId),

//       offerTitle: safeText(booking?.offerTitle || doc?.offerTitle),
//       offerType: safeText(booking?.offerType),
//       status: safeText(booking?.status) || "open",
//       currency: safeText(doc?.currency || booking?.currency) || "EUR",

//       invoiceNo,
//       invoiceDate: doc?.invoiceDate || null,
//       fileName: safeText(doc?.fileName),
//       filePath: safeText(doc?.filePath),
//       amount: bookingBaseAmount(booking),

//       voucherCode: discount.voucherCode,
//       voucherDiscount: discount.voucherDiscount,
//       totalDiscount: discount.totalDiscount,
//       finalPrice: discount.finalPrice,

//       childUid: safeText(booking?.childUid),
//       childFirstName: safeText(booking?.childFirstName),
//       childLastName: safeText(booking?.childLastName),
//     });
//   }

//   return out;
// }

// async function loadInvoiceDocsForCustomer(owner, customer) {
//   const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   const bookingIds = bookings
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return [];

//   return BillingDocument.find({
//     owner: String(owner),
//     kind: "invoice",
//     bookingId: { $in: bookingIds },
//     voidedAt: null,
//   })
//     .sort({ invoiceDate: -1, createdAt: -1 })
//     .lean();
// }

// async function loadBookingParentMap(owner, bookingRefs) {
//   const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return new Map();

//   const docs = await Booking.find(
//     { _id: { $in: bookingIds }, owner: String(owner) },
//     {
//       "invoiceTo.parent.email": 1,
//       "invoiceTo.parent.firstName": 1,
//       "invoiceTo.parent.lastName": 1,
//     },
//   )
//     .lean()
//     .catch(() => []);

//   return new Map(
//     docs.map((d) => [
//       String(d._id),
//       {
//         parentEmail: safeLower(d?.invoiceTo?.parent?.email),
//         parentFirstName: safeText(d?.invoiceTo?.parent?.firstName),
//         parentLastName: safeText(d?.invoiceTo?.parent?.lastName),
//       },
//     ]),
//   );
// }

// function attachParentMeta(items, parentMap) {
//   return (Array.isArray(items) ? items : []).map((item) => {
//     const meta = parentMap.get(String(item?.bookingId || "")) || {};
//     return {
//       ...item,
//       parentEmail: safeLower(meta.parentEmail),
//       parentFirstName: safeText(meta.parentFirstName),
//       parentLastName: safeText(meta.parentLastName),
//     };
//   });
// }

// function hasContractMeta(meta) {
//   const signedAt = safeText(meta?.contractSignedAt);
//   const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
//   return Boolean(signedAt && html);
// }

// async function loadContractMetaMap(owner, bookingRefs) {
//   const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return new Map();

//   const docs = await Booking.find(
//     { _id: { $in: bookingIds }, owner: String(owner) },
//     {
//       "meta.contractSignedAt": 1,
//       "meta.contractSnapshot.contractDoc": 1,
//     },
//   )
//     .lean()
//     .catch(() => []);

//   return new Map(docs.map((d) => [String(d._id), d]));
// }

// function contractHref(bid) {
//   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/contract`;
// }

// function baseTitleFrom(ref) {
//   return String(ref?.offerTitle || ref?.offerType || "Angebot").trim();
// }

// function refIdOf(ref) {
//   return String(ref?.bookingId || ref?._id || "").trim();
// }

// function buildContractDocsFromMap(customer, bookingRefs, metaMap) {
//   const cid = String(customer?._id || "");
//   const out = [];

//   for (const ref of bookingRefs || []) {
//     const bid = refIdOf(ref);
//     if (!bid) continue;

//     const doc = metaMap.get(bid);
//     const meta = doc?.meta || {};
//     if (!hasContractMeta(meta)) continue;

//     out.push({
//       id: `${bid}:contract`,
//       type: "contract",
//       title: `Vertrag – ${baseTitleFrom(ref)}`,
//       issuedAt: meta.contractSignedAt,
//       href: contractHref(bid),

//       bookingId: bid,
//       customerId: cid,
//       offerTitle: safeText(ref.offerTitle),
//       offerType: safeText(ref.offerType),
//       status: safeText(ref.status) || "open",
//       currency: safeText(ref.currency) || "EUR",

//       childUid: safeText(ref.childUid),
//       childFirstName: safeText(ref.childFirstName),
//       childLastName: safeText(ref.childLastName),
//     });
//   }

//   return out;
// }

// function childNameMatches(ref, childFirst, childLast) {
//   const first = safeLower(ref?.childFirstName || ref?.firstName || "");
//   const last = safeLower(ref?.childLastName || ref?.lastName || "");

//   if (childFirst && safeLower(childFirst) !== first) return false;
//   if (childLast && safeLower(childLast) !== last) return false;
//   return Boolean(childFirst || childLast);
// }

// function matchesChildFilter(ref, childUid, childFirst, childLast) {
//   const uid = safeText(ref?.childUid);
//   if (!childUid && !childFirst && !childLast) return true;
//   if (childUid && uid && childUid === uid) return true;
//   return childNameMatches(ref, childFirst, childLast);
// }

// function creditNoteHref(customerId, bookingId) {
//   return `/api/admin/customers/${encodeURIComponent(
//     customerId,
//   )}/bookings/${encodeURIComponent(bookingId)}/credit-note.pdf`;
// }

// function isCreditInvoiceRef(ref) {
//   const note = safeLower(ref?.note);
//   const number = safeText(ref?.number);
//   const amount = Number(ref?.amount);

//   if (note.includes("gutschrift")) return true;
//   if (number.toUpperCase().startsWith("GS")) return true;
//   if (Number.isFinite(amount) && amount < 0) return true;

//   return false;
// }

// function buildCustomerCreditNoteDocs(customer, opts = {}) {
//   const customerId = safeText(customer?._id);
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

//   const childUid = safeText(opts.childUid);
//   const childFirst = safeText(opts.childFirst);
//   const childLast = safeText(opts.childLast);

//   const out = [];

//   for (const ref of refs) {
//     const bookingId = safeText(ref?.bookingId || ref?._id);
//     if (!bookingId) continue;

//     if (!matchesChildFilter(ref, childUid, childFirst, childLast)) continue;

//     const invoiceRefs = Array.isArray(ref?.invoiceRefs) ? ref.invoiceRefs : [];
//     const creditRefs = invoiceRefs.filter(isCreditInvoiceRef);

//     for (const creditRef of creditRefs) {
//       const creditNoteNo = safeText(creditRef?.number);
//       if (!creditNoteNo) continue;

//       const issuedAt =
//         creditRef?.date ||
//         ref?.returnedAt ||
//         ref?.updatedAt ||
//         ref?.createdAt ||
//         new Date();

//       const offerTitle = safeText(ref.offerTitle || ref.offerType || "Angebot");

//       out.push({
//         id: `${bookingId}:creditnote:${creditNoteNo}`,
//         type: "creditnote",
//         title: `Gutschrift – ${offerTitle}`,
//         issuedAt,
//         href: creditNoteHref(customerId, bookingId),

//         bookingId,
//         customerId,
//         offerTitle: safeText(ref.offerTitle),
//         offerType: safeText(ref.offerType),
//         status: safeText(ref.status) || "open",
//         currency: safeText(ref.currency) || "EUR",

//         creditNoteNo,
//         invoiceNo: creditNoteNo,
//         invoiceNumber: creditNoteNo,
//         amount: creditRef?.amount,
//         finalPrice: creditRef?.finalPrice,

//         childUid: safeText(ref.childUid),
//         childFirstName: safeText(ref.childFirstName),
//         childLastName: safeText(ref.childLastName),
//       });
//     }
//   }

//   return out;
// }

// async function listCustomerDocuments(req, res, requireOwner, requireId) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const page = Math.max(1, Number(req.query.page || 1));
//     const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));

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

//     const childUid = safeText(req.query.childUid);
//     const childFirst = safeText(req.query.childFirst);
//     const childLast = safeText(req.query.childLast);

//     const scope = safeText(req.query.scope).toLowerCase();
//     const parentEmail = safeLower(req.query.parentEmail);

//     const customer = await Customer.findOne({ _id: id, owner }).lean();
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const bookingRefs = Array.isArray(customer?.bookings)
//       ? customer.bookings
//       : [];

//     const debugBookingRefs = bookingRefs.slice(-10).map((b) => ({
//       bookingId: safeText(b?.bookingId || b?._id),
//       offerType: safeText(b?.offerType),
//       childUid: safeText(b?.childUid),
//       childFirstName: safeText(b?.childFirstName),
//       childLastName: safeText(b?.childLastName),
//       invoiceNumber: safeText(b?.invoiceNumber || b?.invoiceNo),
//       parentEmail: safeLower(b?.parentEmail),
//     }));

//     const bookingParentMap = await loadBookingParentMap(owner, bookingRefs);

//     const distinctChildUids = new Set(
//       bookingRefs.map((b) => safeText(b?.childUid)).filter(Boolean),
//     );

//     if (!scope && !childUid && distinctChildUids.size > 1) {
//       return res.json({ ok: true, items: [], total: 0, page, limit });
//     }

//     const bookingDocs = buildCustomerDocs(customer, {
//       childUid,
//       childFirst,
//       childLast,
//     });

//     const creditNoteDocs = buildCustomerCreditNoteDocs(customer, {
//       childUid,
//       childFirst,
//       childLast,
//     });

//     const invoiceSource = await loadInvoiceDocsForCustomer(owner, customer);
//     const invoiceDocs = buildBillingInvoiceDocs(customer, invoiceSource);

//     const dunningSource = await loadDunningDocsForCustomer(owner, customer);
//     const dunningDocs = buildCustomerDunningDocs(customer, dunningSource);

//     const wantContract = !typeSet.size || typeSet.has("contract");
//     const contractMetaMap = wantContract
//       ? await loadContractMetaMap(owner, bookingRefs)
//       : new Map();

//     const contractDocs = wantContract
//       ? buildContractDocsFromMap(customer, bookingRefs, contractMetaMap)
//       : [];

//     let filtered = attachParentMeta(
//       [
//         ...bookingDocs,
//         ...invoiceDocs,
//         ...creditNoteDocs,
//         ...contractDocs,
//         ...dunningDocs,
//       ],
//       bookingParentMap,
//     ).filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

//     if (childUid) {
//       filtered = filtered.filter((d) => safeText(d?.childUid) === childUid);
//     }

//     if (parentEmail) {
//       filtered = filtered.filter(
//         (d) => safeLower(d?.parentEmail) === parentEmail,
//       );
//     }

//     if (scope === "self") {
//       filtered = filtered.filter((d) => !safeText(d?.childUid));
//     }

//     if (scope === "child") {
//       filtered = filtered.filter((d) => safeText(d?.childUid));
//     }

//     if (from) filtered = filtered.filter((d) => new Date(d.issuedAt) >= from);
//     if (to) filtered = filtered.filter((d) => new Date(d.issuedAt) <= to);

//     sortDocs(filtered, sortKey, sortMul);

//     const total = filtered.length;
//     const start = (page - 1) * limit;
//     const items = filtered.slice(start, start + limit);

//     return res.json({ ok: true, items, total, page, limit });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { listCustomerDocuments };

// // routes/customers/handlers/documents/listCustomerDocuments.js
// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const BillingDocument = require("../../../../models/BillingDocument");
// const Booking = require("../../../../models/Booking");

// const {
//   docMatchesType,
//   docMatchesQuery,
//   parseDate,
// } = require("../../helpers/documents/docMatchers");

// const {
//   buildCustomerDocs,
//   buildCustomerDunningDocs,
// } = require("../../helpers/documents/buildCustomerDocs");

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
//     .map((b) => String(b?.bookingId || b?._id || ""))
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

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function safeLower(v) {
//   return safeText(v).toLowerCase();
// }

// async function loadBookingParentMap(owner, bookingRefs) {
//   const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return new Map();

//   const docs = await Booking.find(
//     { _id: { $in: bookingIds }, owner: String(owner) },
//     {
//       "invoiceTo.parent.email": 1,
//       "invoiceTo.parent.firstName": 1,
//       "invoiceTo.parent.lastName": 1,
//     },
//   )
//     .lean()
//     .catch(() => []);

//   return new Map(
//     docs.map((d) => [
//       String(d._id),
//       {
//         parentEmail: safeLower(d?.invoiceTo?.parent?.email),
//         parentFirstName: safeText(d?.invoiceTo?.parent?.firstName),
//         parentLastName: safeText(d?.invoiceTo?.parent?.lastName),
//       },
//     ]),
//   );
// }

// function attachParentMeta(items, parentMap) {
//   return (Array.isArray(items) ? items : []).map((item) => {
//     const meta = parentMap.get(String(item?.bookingId || "")) || {};
//     return {
//       ...item,
//       parentEmail: safeLower(meta.parentEmail),
//       parentFirstName: safeText(meta.parentFirstName),
//       parentLastName: safeText(meta.parentLastName),
//     };
//   });
// }

// function hasContractMeta(meta) {
//   const signedAt = safeText(meta?.contractSignedAt);
//   const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
//   return Boolean(signedAt && html);
// }

// async function loadContractMetaMap(owner, bookingRefs) {
//   const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
//     .map((b) => String(b?.bookingId || b?._id || ""))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return new Map();

//   const docs = await Booking.find(
//     { _id: { $in: bookingIds }, owner: String(owner) },
//     {
//       "meta.contractSignedAt": 1,
//       "meta.contractSnapshot.contractDoc": 1,
//     },
//   )
//     .lean()
//     .catch(() => []);

//   return new Map(docs.map((d) => [String(d._id), d]));
// }

// function contractHref(bid) {
//   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/contract`;
// }

// function baseTitleFrom(ref) {
//   return String(ref?.offerTitle || ref?.offerType || "Angebot").trim();
// }

// function refIdOf(ref) {
//   return String(ref?.bookingId || ref?._id || "").trim();
// }

// function buildContractDocsFromMap(customer, bookingRefs, metaMap) {
//   const cid = String(customer?._id || "");
//   const out = [];

//   for (const ref of bookingRefs || []) {
//     const bid = refIdOf(ref);
//     if (!bid) continue;

//     const doc = metaMap.get(bid);
//     const meta = doc?.meta || {};
//     if (!hasContractMeta(meta)) continue;

//     out.push({
//       id: `${bid}:contract`,
//       type: "contract",
//       title: `Vertrag – ${baseTitleFrom(ref)}`,
//       issuedAt: meta.contractSignedAt,
//       href: contractHref(bid),

//       bookingId: bid,
//       customerId: cid,
//       offerTitle: safeText(ref.offerTitle),
//       offerType: safeText(ref.offerType),
//       status: safeText(ref.status) || "open",
//       currency: safeText(ref.currency) || "EUR",

//       childUid: safeText(ref.childUid),
//       childFirstName: safeText(ref.childFirstName),
//       childLastName: safeText(ref.childLastName),
//     });
//   }

//   return out;
// }

// function childNameMatches(ref, childFirst, childLast) {
//   const first = safeLower(ref?.childFirstName || ref?.firstName || "");
//   const last = safeLower(ref?.childLastName || ref?.lastName || "");

//   if (childFirst && safeLower(childFirst) !== first) return false;
//   if (childLast && safeLower(childLast) !== last) return false;
//   return Boolean(childFirst || childLast);
// }

// function matchesChildFilter(ref, childUid, childFirst, childLast) {
//   const uid = safeText(ref?.childUid);
//   if (!childUid && !childFirst && !childLast) return true;
//   if (childUid && uid && childUid === uid) return true;
//   return childNameMatches(ref, childFirst, childLast);
// }

// function creditNoteHref(customerId, bookingId) {
//   return `/api/admin/customers/${encodeURIComponent(
//     customerId,
//   )}/bookings/${encodeURIComponent(bookingId)}/credit-note.pdf`;
// }

// function isCreditInvoiceRef(ref) {
//   const note = safeLower(ref?.note);
//   const number = safeText(ref?.number);
//   const amount = Number(ref?.amount);

//   if (note.includes("gutschrift")) return true;
//   if (number.toUpperCase().startsWith("GS")) return true;
//   if (Number.isFinite(amount) && amount < 0) return true;

//   return false;
// }

// function buildCustomerCreditNoteDocs(customer, opts = {}) {
//   const customerId = safeText(customer?._id);
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

//   const childUid = safeText(opts.childUid);
//   const childFirst = safeText(opts.childFirst);
//   const childLast = safeText(opts.childLast);

//   const out = [];

//   for (const ref of refs) {
//     const bookingId = safeText(ref?.bookingId || ref?._id);
//     if (!bookingId) continue;

//     if (!matchesChildFilter(ref, childUid, childFirst, childLast)) continue;

//     const invoiceRefs = Array.isArray(ref?.invoiceRefs) ? ref.invoiceRefs : [];
//     const creditRefs = invoiceRefs.filter(isCreditInvoiceRef);

//     for (const creditRef of creditRefs) {
//       const creditNoteNo = safeText(creditRef?.number);
//       if (!creditNoteNo) continue;

//       const issuedAt =
//         creditRef?.date ||
//         ref?.returnedAt ||
//         ref?.updatedAt ||
//         ref?.createdAt ||
//         new Date();

//       const offerTitle = safeText(ref.offerTitle || ref.offerType || "Angebot");

//       out.push({
//         id: `${bookingId}:creditnote:${creditNoteNo}`,
//         type: "creditnote",
//         title: `Gutschrift – ${offerTitle}`,
//         issuedAt,
//         href: creditNoteHref(customerId, bookingId),

//         bookingId,
//         customerId,
//         offerTitle: safeText(ref.offerTitle),
//         offerType: safeText(ref.offerType),
//         status: safeText(ref.status) || "open",
//         currency: safeText(ref.currency) || "EUR",

//         creditNoteNo,
//         invoiceNo: creditNoteNo,
//         invoiceNumber: creditNoteNo,
//         amount: creditRef?.amount,
//         finalPrice: creditRef?.finalPrice,

//         childUid: safeText(ref.childUid),
//         childFirstName: safeText(ref.childFirstName),
//         childLastName: safeText(ref.childLastName),
//       });
//     }
//   }

//   return out;
// }

// async function listCustomerDocuments(req, res, requireOwner, requireId) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const page = Math.max(1, Number(req.query.page || 1));
//     const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));

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

//     const childUid = safeText(req.query.childUid);
//     const childFirst = safeText(req.query.childFirst);
//     const childLast = safeText(req.query.childLast);

//     const scope = safeText(req.query.scope).toLowerCase();

//     const parentEmail = safeLower(req.query.parentEmail);

//     const customer = await Customer.findOne({ _id: id, owner }).lean();
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const bookingRefs = Array.isArray(customer?.bookings)
//       ? customer.bookings
//       : [];

//     const bookingParentMap = await loadBookingParentMap(owner, bookingRefs);

//     const distinctChildUids = new Set(
//       bookingRefs.map((b) => safeText(b?.childUid)).filter(Boolean),
//     );

//     if (!scope && !childUid && distinctChildUids.size > 1) {
//       return res.json({ ok: true, items: [], total: 0, page, limit });
//     }

//     const bookingDocs = buildCustomerDocs(customer, {
//       childUid,
//       childFirst,
//       childLast,
//     });

//     const creditNoteDocs = buildCustomerCreditNoteDocs(customer, {
//       childUid,
//       childFirst,
//       childLast,
//     });

//     const dunningSource = await loadDunningDocsForCustomer(owner, customer);
//     const dunningDocs = buildCustomerDunningDocs(customer, dunningSource);

//     const wantContract = !typeSet.size || typeSet.has("contract");
//     const contractMetaMap = wantContract
//       ? await loadContractMetaMap(owner, bookingRefs)
//       : new Map();

//     const contractDocs = wantContract
//       ? buildContractDocsFromMap(customer, bookingRefs, contractMetaMap)
//       : [];

//     let filtered = attachParentMeta(
//       [...bookingDocs, ...creditNoteDocs, ...contractDocs, ...dunningDocs],
//       bookingParentMap,
//     ).filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

//     if (childUid) {
//       filtered = filtered.filter((d) => safeText(d?.childUid) === childUid);
//     }

//     if (parentEmail) {
//       filtered = filtered.filter(
//         (d) => safeLower(d?.parentEmail) === parentEmail,
//       );
//     }

//     if (scope === "self") {
//       filtered = filtered.filter((d) => !safeText(d?.childUid));
//     }

//     if (scope === "child") {
//       filtered = filtered.filter((d) => safeText(d?.childUid));
//     }

//     if (from) filtered = filtered.filter((d) => new Date(d.issuedAt) >= from);
//     if (to) filtered = filtered.filter((d) => new Date(d.issuedAt) <= to);

//     sortDocs(filtered, sortKey, sortMul);

//     const total = filtered.length;
//     const start = (page - 1) * limit;
//     const items = filtered.slice(start, start + limit);

//     return res.json({ ok: true, items, total, page, limit });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { listCustomerDocuments };
