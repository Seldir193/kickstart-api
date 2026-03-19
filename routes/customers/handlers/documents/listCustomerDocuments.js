// routes/customers/handlers/documents/listCustomerDocuments.js
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

  //const parentEmail = safeLower(req.query.parentEmail);

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

    // const distinctChildUids = new Set(
    //   bookingRefs.map((b) => safeText(b?.childUid)).filter(Boolean),
    // );

    // if (!childUid && distinctChildUids.size > 1) {
    //   return res.json({ ok: true, items: [], total: 0, page, limit });
    // }

    const distinctChildUids = new Set(
      bookingRefs.map((b) => safeText(b?.childUid)).filter(Boolean),
    );

    if (!scope && !childUid && distinctChildUids.size > 1) {
      return res.json({ ok: true, items: [], total: 0, page, limit });
    }

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

    //     let filtered = attachParentMeta(
    //       [...bookingDocs, ...creditNoteDocs, ...contractDocs, ...dunningDocs],
    //       bookingParentMap,
    //     ).filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

    //     if (childUid) {
    //       filtered = filtered.filter((d) => safeText(d?.childUid) === childUid);
    //     }

    //     if (from) filtered = filtered.filter((d) => new Date(d.issuedAt) >= from);
    //     if (to) filtered = filtered.filter((d) => new Date(d.issuedAt) <= to);

    //        if (parentEmail) {
    //   filtered = filtered.filter(
    //     (d) => safeLower(d?.parentEmail) === parentEmail,
    //   );
    // }

    sortDocs(filtered, sortKey, sortMul);

    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    return res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { listCustomerDocuments };

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

// function safeLower(v) {
//   return safeText(v).toLowerCase();
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

//     const customer = await Customer.findOne({ _id: id, owner }).lean();
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const bookingRefs = Array.isArray(customer?.bookings)
//       ? customer.bookings
//       : [];

//     const distinctChildUids = new Set(
//       bookingRefs.map((b) => safeText(b?.childUid)).filter(Boolean),
//     );

//     if (!childUid && distinctChildUids.size > 1) {
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

//     let filtered = [
//       ...bookingDocs,
//       ...creditNoteDocs,
//       ...contractDocs,
//       ...dunningDocs,
//     ].filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

//     if (childUid) {
//       filtered = filtered.filter((d) => safeText(d?.childUid) === childUid);
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
