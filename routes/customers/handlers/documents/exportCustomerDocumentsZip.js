// routes/customers/handlers/documents/exportCustomerDocumentsZip.js
"use strict";

const mongoose = require("mongoose");
const archiver = require("archiver");

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
  runWithConcurrency,
} = require("../../helpers/documents/runWithConcurrency");

const {
  buildCustomerDocs,
  buildCustomerDunningDocs,
} = require("../../helpers/documents/buildCustomerDocs");

const { buildWeeklyContractPdf } = require("../../../../utils/pdf");

async function loadDunningDocsForCustomer(owner, customer) {
  const bookings = Array.isArray(customer?.bookings) ? customer.bookings : [];
  // const bookingIds = bookings
  //   .map((b) => String(b?._id || ""))

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

function sortDocs(items, sortKey, sortMul) {
  items.sort((a, b) => {
    const av = new Date(a?.[sortKey] || 0).getTime();
    const bv = new Date(b?.[sortKey] || 0).getTime();
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * sortMul;
  });
}

function parseSort(query) {
  const sortStr = String(query.sort || "issuedAt:desc");
  const [field, dir] = sortStr.split(":");
  return {
    key: field || "issuedAt",
    mul: dir === "asc" ? 1 : -1,
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

function findBookingRef(customer, bookingId) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
  return (
    refs.find((b) => String(b?._id || "") === String(bookingId || "")) ||
    refs.find((b) => String(b?.bookingId || "") === String(bookingId || "")) ||
    null
  );
}

function findCreditRef(bookingRef, wantedNo) {
  const refs = Array.isArray(bookingRef?.invoiceRefs)
    ? bookingRef.invoiceRefs
    : [];

  if (wantedNo) {
    const exact = refs.find((r) => safeText(r?.number) === safeText(wantedNo));
    if (exact) return exact;
  }

  return refs.find(isCreditInvoiceRef) || null;
}

function creditAmountAbs(bookingRef, offer, creditRef) {
  const amount =
    creditRef && Number.isFinite(Number(creditRef.amount))
      ? Number(creditRef.amount)
      : bookingRef?.priceAtBooking != null
        ? Number(bookingRef.priceAtBooking)
        : offer && typeof offer.price === "number"
          ? Number(offer.price)
          : 0;

  return Math.abs(Math.round(amount * 100) / 100);
}

async function exportCustomerDocumentsZip(
  req,
  res,
  requireOwner,
  requireId,
  normalizeInvoiceNo,
  buildParticipationPdf,
  buildCancellationPdf,
  buildStornoPdf,
) {
  try {
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

    const bookingParentMap = await loadBookingParentMap(owner, bookingRefs);
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

    // let docs = [
    //   ...bookingDocs,
    //   ...creditNoteDocs,
    //   ...contractDocs,
    //   ...dunningDocs,
    // ].filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

    let docs = attachParentMeta(
      [...bookingDocs, ...creditNoteDocs, ...contractDocs, ...dunningDocs],
      bookingParentMap,
    ).filter((d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q));

    if (selectedIds.size) {
      docs = docs.filter((d) => selectedIds.has(String(d.id || "")));
    }

    if (childUid) {
      docs = docs.filter((d) => safeText(d?.childUid) === childUid);
    }

    if (parentEmail) {
      docs = docs.filter((d) => safeLower(d?.parentEmail) === parentEmail);
    }

    if (scope === "self") {
      docs = docs.filter((d) => !safeText(d?.childUid));
    }

    if (scope === "child") {
      docs = docs.filter((d) => safeText(d?.childUid));
    }

    if (from) docs = docs.filter((d) => new Date(d.issuedAt) >= from);
    if (to) docs = docs.filter((d) => new Date(d.issuedAt) <= to);

    sortDocs(docs, sortKey, sortMul);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="customer-${id}-documents.zip"`,
    );

    const archive = archiver("zip", { zlib: { level: 3 } });

    archive.on("error", (err) => {
      console.error(err);
      try {
        res.status(500).end();
      } catch {}
    });

    archive.pipe(res);

    const safe = (s) =>
      String(s || "")
        .replace(/[^\w.\- äöüÄÖÜß]/g, "_")
        .slice(0, 120);

    function fmtISO(v) {
      if (!v) return "undated";
      const d = new Date(v);
      return isNaN(d.getTime()) ? "undated" : d.toISOString().slice(0, 10);
    }

    const labels = {
      participation: "Teilnahmebestätigung",
      cancellation: "Kündigungsbestätigung",
      storno: "Storno-Rechnung",
      creditnote: "Gutschrift",
      contract: "Vertrag",
      dunning: "Mahnung",
    };

    async function appendDunningPdf(d) {
      if (!d.href) return false;

      const origin = `${req.protocol}://${req.get("host")}`;
      const provider = req.get("x-provider-id") || "";

      const r = await fetch(`${origin}${d.href}`, {
        headers: provider ? { "x-provider-id": provider } : {},
        redirect: "follow",
      });

      if (!r.ok) {
        const msg = `Fetch failed (${r.status}) for ${d.href}`;
        archive.append(Buffer.from(msg, "utf8"), {
          name: `error-${d.bookingId || "unknown"}-dunning.txt`,
        });
        return true;
      }

      const buf = Buffer.from(await r.arrayBuffer());
      const fileName = String(d.fileName || d.title || `dunning-${d.id}`)
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 120);

      const name = /\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`;
      archive.append(buf, { name });
      return true;
    }

    async function processDoc(d) {
      if (d.type === "dunning") {
        const handled = await appendDunningPdf(d);
        if (handled) return;
      }

      if (d.type === "creditnote") {
        const bookingRef = findBookingRef(customer, d.bookingId);
        if (!bookingRef) {
          const msg = `Booking ref not found for ${d.bookingId || "unknown"}`;
          archive.append(Buffer.from(msg, "utf8"), {
            name: `error-${d.bookingId || "unknown"}-creditnote.txt`,
          });
          return;
        }

        let offer = null;
        if (bookingRef.offerId) {
          try {
            offer = await Offer.findById(bookingRef.offerId).lean();
          } catch {}
        }

        const creditNo = safeText(
          d.creditNoteNo || d.invoiceNo || d.invoiceNumber,
        );
        const creditRef = findCreditRef(bookingRef, creditNo);
        const abs = creditAmountAbs(bookingRef, offer, creditRef);

        const bookingForPdf = {
          ...(bookingRef.toObject ? bookingRef.toObject() : bookingRef),
          _id: bookingRef.bookingId || bookingRef._id,
          offerTitle:
            bookingRef.offerTitle ||
            bookingRef.offerType ||
            offer?.title ||
            offer?.sub_type ||
            offer?.type ||
            "Angebot",
          offerType:
            bookingRef.offerType || offer?.sub_type || offer?.type || "",
          venue: bookingRef.venue || offer?.location || "",
          date: bookingRef.date || bookingRef.createdAt || new Date(),
          priceAtBooking: -abs,
          currency: bookingRef.currency || "EUR",
        };

        const pdf = await buildParticipationPdf({
          customer,
          booking: bookingForPdf,
          offer,
          invoiceNo: creditNo,
          invoiceDate:
            safeText(creditRef?.date) || d.issuedAt || new Date().toISOString(),
          venue: bookingForPdf.venue || offer?.location || "",
        });

        const dateStr = fmtISO(d.issuedAt);
        const title =
          bookingForPdf.offerTitle || bookingForPdf.offerType || "Angebot";

        const parts = [dateStr, "Gutschrift"];
        if (creditNo) parts.push(creditNo);
        parts.push(title);

        const filename = parts.join(" - ");
        archive.append(pdf, { name: `${safe(filename)}.pdf` });
        return;
      }

      const booking = findBookingRef(customer, d.bookingId);
      if (!booking) return;

      let offer = null;
      if (booking.offerId) {
        try {
          offer = await Offer.findById(booking.offerId).lean();
        } catch {}
      }

      const snap = { ...booking };

      if (offer) {
        snap.offerTitle = snap.offerTitle || offer.title || "";
        snap.offerType = snap.offerType || offer.sub_type || offer.type || "";
        snap.venue = snap.venue || offer.location || "";
      }

      const refNo = normalizeInvoiceNo(
        snap.refInvoiceNo || snap.invoiceNumber || snap.invoiceNo || "",
      );
      const refDate = snap.refInvoiceDate || snap.invoiceDate || null;

      function pickDocNoFor(type, s) {
        if (type === "participation") {
          return normalizeInvoiceNo(s.invoiceNumber || s.invoiceNo || "");
        }

        if (type === "cancellation") {
          return normalizeInvoiceNo(
            s.cancellationNo || s.cancellationNumber || "",
          );
        }

        if (type === "storno") {
          const stor = normalizeInvoiceNo(s.stornoNo || s.stornoNumber || "");
          if (stor) return stor;
          const ref = normalizeInvoiceNo(
            s.refInvoiceNo || s.invoiceNumber || s.invoiceNo || "",
          );
          return ref ? `REF-${ref}` : "";
        }

        return "";
      }

      let buf;

      if (d.type === "participation") {
        buf = await buildParticipationPdf({ customer, booking: snap, offer });
      } else if (d.type === "cancellation") {
        const date = snap.cancelDate || new Date();
        const reason = snap.cancelReason || "";

        buf = await buildCancellationPdf({
          customer,
          booking: snap,
          offer,
          date,
          endDate: snap.endDate || null,
          reason,
          cancellationNo:
            snap.cancellationNo || snap.cancellationNumber || undefined,
          refInvoiceNo: refNo || undefined,
          refInvoiceDate: refDate || undefined,
        });
      } else if (d.type === "storno") {
        const amount =
          snap.stornoAmount != null
            ? Number(snap.stornoAmount) || 0
            : offer && typeof offer.price === "number"
              ? offer.price
              : 0;

        buf = await buildStornoPdf({
          customer,
          booking: snap,
          offer,
          amount,
          currency: snap.currency || "EUR",
          stornoNo: snap.stornoNo || snap.stornoNumber || undefined,
          refInvoiceNo: refNo || undefined,
          refInvoiceDate: refDate || undefined,
        });
      } else if (d.type === "contract") {
        const bookingForPdf = {
          ...(booking.toObject ? booking.toObject() : booking),
          _id: booking.bookingId || booking._id,
          offerTitle:
            booking.offerTitle ||
            booking.offerType ||
            offer?.title ||
            offer?.sub_type ||
            offer?.type ||
            "Angebot",
          offerType: booking.offerType || offer?.sub_type || offer?.type || "",
          venue: booking.venue || offer?.location || "",
        };

        buf = await buildWeeklyContractPdf({
          booking: bookingForPdf,
          offer,
        });
      } else {
        return;
      }

      const dateStr = fmtISO(d.issuedAt);
      const label = labels[d.type] || d.type;
      const docNo = pickDocNoFor(d.type, snap);
      const title = snap.offerTitle || snap.offerType || "Angebot";

      const parts = [dateStr, label];
      if (docNo) parts.push(docNo);
      parts.push(title);

      const filename = parts.join(" - ");
      const name = `${safe(filename)}.pdf`;

      archive.append(buf, { name });
    }

    await runWithConcurrency(docs, 3, processDoc);
    await archive.finalize();
  } catch (err) {
    console.error(err);
    try {
      res.status(500).json({ error: "Server error" });
    } catch {}
  }
}

module.exports = { exportCustomerDocumentsZip };

// // routes/customers/handlers/documents/exportCustomerDocumentsZip.js
// "use strict";

// const mongoose = require("mongoose");
// const archiver = require("archiver");

// const Customer = require("../../../../models/Customer");
// const Offer = require("../../../../models/Offer");
// const BillingDocument = require("../../../../models/BillingDocument");

// const {
//   docMatchesType,
//   docMatchesQuery,
//   parseDate,
// } = require("../../helpers/documents/docMatchers");

// const {
//   runWithConcurrency,
// } = require("../../helpers/documents/runWithConcurrency");

// const {
//   buildCustomerDocs,
//   buildCustomerDunningDocs,
// } = require("../../helpers/documents/buildCustomerDocs");

// async function loadDunningDocsForCustomer(owner, customer) {
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

// function sortDocs(items, sortKey, sortMul) {
//   items.sort((a, b) => {
//     const av = new Date(a?.[sortKey] || 0).getTime();
//     const bv = new Date(b?.[sortKey] || 0).getTime();
//     if (av === bv) return 0;
//     return (av < bv ? -1 : 1) * sortMul;
//   });
// }

// function parseSort(query) {
//   const sortStr = String(query.sort || "issuedAt:desc");
//   const [field, dir] = sortStr.split(":");
//   return {
//     key: field || "issuedAt",
//     mul: dir === "asc" ? 1 : -1,
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
//       });
//     }
//   }

//   return out;
// }

// function findBookingRef(customer, bookingId) {
//   const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];
//   return (
//     refs.find((b) => String(b?._id || "") === String(bookingId || "")) ||
//     refs.find((b) => String(b?.bookingId || "") === String(bookingId || "")) ||
//     null
//   );
// }

// function findCreditRef(bookingRef, wantedNo) {
//   const refs = Array.isArray(bookingRef?.invoiceRefs)
//     ? bookingRef.invoiceRefs
//     : [];

//   if (wantedNo) {
//     const exact = refs.find((r) => safeText(r?.number) === safeText(wantedNo));
//     if (exact) return exact;
//   }

//   return refs.find(isCreditInvoiceRef) || null;
// }

// function creditAmountAbs(bookingRef, offer, creditRef) {
//   const amount =
//     creditRef && Number.isFinite(Number(creditRef.amount))
//       ? Number(creditRef.amount)
//       : bookingRef?.priceAtBooking != null
//         ? Number(bookingRef.priceAtBooking)
//         : offer && typeof offer.price === "number"
//           ? Number(offer.price)
//           : 0;

//   return Math.abs(Math.round(amount * 100) / 100);
// }

// async function exportCustomerDocumentsZip(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   normalizeInvoiceNo,
//   buildParticipationPdf,
//   buildCancellationPdf,
//   buildStornoPdf,
// ) {
//   try {
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

//     const bookingDocs = buildCustomerDocs(customer);
//     const creditNoteDocs = buildCustomerCreditNoteDocs(customer);
//     const dunningSource = await loadDunningDocsForCustomer(owner, customer);
//     const dunningDocs = buildCustomerDunningDocs(customer, dunningSource);

//     let docs = [...bookingDocs, ...creditNoteDocs, ...dunningDocs].filter(
//       (d) => docMatchesType(d, typeSet) && docMatchesQuery(d, q),
//     );

//     if (selectedIds.size) {
//       docs = docs.filter((d) => selectedIds.has(String(d.id || "")));
//     }

//     if (from) docs = docs.filter((d) => new Date(d.issuedAt) >= from);
//     if (to) docs = docs.filter((d) => new Date(d.issuedAt) <= to);

//     sortDocs(docs, sortKey, sortMul);

//     res.setHeader("Content-Type", "application/zip");
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="customer-${id}-documents.zip"`,
//     );

//     const archive = archiver("zip", { zlib: { level: 3 } });

//     archive.on("error", (err) => {
//       console.error(err);
//       try {
//         res.status(500).end();
//       } catch {}
//     });

//     archive.pipe(res);

//     const safe = (s) =>
//       String(s || "")
//         .replace(/[^\w.\- äöüÄÖÜß]/g, "_")
//         .slice(0, 120);

//     function fmtISO(v) {
//       if (!v) return "undated";
//       const d = new Date(v);
//       return isNaN(d.getTime()) ? "undated" : d.toISOString().slice(0, 10);
//     }

//     const labels = {
//       participation: "Teilnahmebestätigung",
//       cancellation: "Kündigungsbestätigung",
//       storno: "Storno-Rechnung",
//       creditnote: "Gutschrift",
//       dunning: "Mahnung",
//     };

//     async function appendDunningPdf(d) {
//       if (!d.href) return false;

//       const origin = `${req.protocol}://${req.get("host")}`;
//       const provider = req.get("x-provider-id") || "";

//       const r = await fetch(`${origin}${d.href}`, {
//         headers: provider ? { "x-provider-id": provider } : {},
//         redirect: "follow",
//       });

//       if (!r.ok) {
//         const msg = `Fetch failed (${r.status}) for ${d.href}`;
//         archive.append(Buffer.from(msg, "utf8"), {
//           name: `error-${d.bookingId || "unknown"}-dunning.txt`,
//         });
//         return true;
//       }

//       const buf = Buffer.from(await r.arrayBuffer());
//       const fileName = String(d.fileName || d.title || `dunning-${d.id}`)
//         .replace(/[\\/:*?"<>|]+/g, "_")
//         .slice(0, 120);

//       const name = /\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`;
//       archive.append(buf, { name });
//       return true;
//     }

//     async function processDoc(d) {
//       if (d.type === "dunning") {
//         const handled = await appendDunningPdf(d);
//         if (handled) return;
//       }

//       if (d.type === "creditnote") {
//         const bookingRef = findBookingRef(customer, d.bookingId);
//         if (!bookingRef) {
//           const msg = `Booking ref not found for ${d.bookingId || "unknown"}`;
//           archive.append(Buffer.from(msg, "utf8"), {
//             name: `error-${d.bookingId || "unknown"}-creditnote.txt`,
//           });
//           return;
//         }

//         let offer = null;
//         if (bookingRef.offerId) {
//           try {
//             offer = await Offer.findById(bookingRef.offerId).lean();
//           } catch {}
//         }

//         const creditNo = safeText(
//           d.creditNoteNo || d.invoiceNo || d.invoiceNumber,
//         );
//         const creditRef = findCreditRef(bookingRef, creditNo);
//         const abs = creditAmountAbs(bookingRef, offer, creditRef);

//         const bookingForPdf = {
//           ...(bookingRef.toObject ? bookingRef.toObject() : bookingRef),
//           _id: bookingRef.bookingId || bookingRef._id,
//           offerTitle:
//             bookingRef.offerTitle ||
//             bookingRef.offerType ||
//             offer?.title ||
//             offer?.sub_type ||
//             offer?.type ||
//             "Angebot",
//           offerType:
//             bookingRef.offerType || offer?.sub_type || offer?.type || "",
//           venue: bookingRef.venue || offer?.location || "",
//           date: bookingRef.date || bookingRef.createdAt || new Date(),
//           priceAtBooking: -abs,
//           currency: bookingRef.currency || "EUR",
//         };

//         const pdf = await buildParticipationPdf({
//           customer,
//           booking: bookingForPdf,
//           offer,
//           invoiceNo: creditNo,
//           invoiceDate:
//             safeText(creditRef?.date) || d.issuedAt || new Date().toISOString(),
//           venue: bookingForPdf.venue || offer?.location || "",
//         });

//         const dateStr = fmtISO(d.issuedAt);
//         const title =
//           bookingForPdf.offerTitle || bookingForPdf.offerType || "Angebot";

//         const parts = [dateStr, "Gutschrift"];
//         if (creditNo) parts.push(creditNo);
//         parts.push(title);

//         const filename = parts.join(" - ");
//         archive.append(pdf, { name: `${safe(filename)}.pdf` });
//         return;
//       }

//       const booking = findBookingRef(customer, d.bookingId);
//       if (!booking) return;

//       let offer = null;
//       if (booking.offerId) {
//         try {
//           offer = await Offer.findById(booking.offerId).lean();
//         } catch {}
//       }

//       const snap = { ...booking };

//       if (offer) {
//         snap.offerTitle = snap.offerTitle || offer.title || "";
//         snap.offerType = snap.offerType || offer.sub_type || offer.type || "";
//         snap.venue = snap.venue || offer.location || "";
//       }

//       const refNo = normalizeInvoiceNo(
//         snap.refInvoiceNo || snap.invoiceNumber || snap.invoiceNo || "",
//       );
//       const refDate = snap.refInvoiceDate || snap.invoiceDate || null;

//       function pickDocNoFor(type, s) {
//         if (type === "participation") {
//           return normalizeInvoiceNo(s.invoiceNumber || s.invoiceNo || "");
//         }

//         if (type === "cancellation") {
//           return normalizeInvoiceNo(
//             s.cancellationNo || s.cancellationNumber || "",
//           );
//         }

//         if (type === "storno") {
//           const stor = normalizeInvoiceNo(s.stornoNo || s.stornoNumber || "");
//           if (stor) return stor;
//           const ref = normalizeInvoiceNo(
//             s.refInvoiceNo || s.invoiceNumber || s.invoiceNo || "",
//           );
//           return ref ? `REF-${ref}` : "";
//         }

//         return "";
//       }

//       let buf;

//       if (d.type === "participation") {
//         buf = await buildParticipationPdf({ customer, booking: snap, offer });
//       } else if (d.type === "cancellation") {
//         const date = snap.cancelDate || new Date();
//         const reason = snap.cancelReason || "";

//         buf = await buildCancellationPdf({
//           customer,
//           booking: snap,
//           offer,
//           date,
//           endDate: snap.endDate || null,
//           reason,
//           cancellationNo:
//             snap.cancellationNo || snap.cancellationNumber || undefined,
//           refInvoiceNo: refNo || undefined,
//           refInvoiceDate: refDate || undefined,
//         });
//       } else if (d.type === "storno") {
//         const amount =
//           snap.stornoAmount != null
//             ? Number(snap.stornoAmount) || 0
//             : offer && typeof offer.price === "number"
//               ? offer.price
//               : 0;

//         buf = await buildStornoPdf({
//           customer,
//           booking: snap,
//           offer,
//           amount,
//           currency: snap.currency || "EUR",
//           stornoNo: snap.stornoNo || snap.stornoNumber || undefined,
//           refInvoiceNo: refNo || undefined,
//           refInvoiceDate: refDate || undefined,
//         });
//       } else {
//         return;
//       }

//       const dateStr = fmtISO(d.issuedAt);
//       const label = labels[d.type] || d.type;
//       const docNo = pickDocNoFor(d.type, snap);
//       const title = snap.offerTitle || snap.offerType || "Angebot";

//       const parts = [dateStr, label];
//       if (docNo) parts.push(docNo);
//       parts.push(title);

//       const filename = parts.join(" - ");
//       const name = `${safe(filename)}.pdf`;

//       archive.append(buf, { name });
//     }

//     await runWithConcurrency(docs, 3, processDoc);
//     await archive.finalize();
//   } catch (err) {
//     console.error(err);
//     try {
//       res.status(500).json({ error: "Server error" });
//     } catch {}
//   }
// }

// module.exports = { exportCustomerDocumentsZip };
