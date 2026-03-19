//routes\bookingActions\handlers\listCustomerDocumentsAction.js
"use strict";

const mongoose = require("mongoose");

const Customer = require("../../../models/Customer");
const Booking = require("../../../models/Booking");

const { nextPeriodStart } = require("../../../utils/billing");
const { requireOwner } = require("../helpers/provider");
const { resolveAmountsFromBookingRef } = require("../helpers/amounts");

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function norm(v) {
  return safeLower(v);
}

function isDigitsOnly(s) {
  return /^\d+$/.test(String(s || "").trim());
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safeText(v);
    if (s) return s;
  }
  return "";
}

function extractDocNo(it) {
  const href = safeText(it?.href);
  const m = /[?&]no=([^&]+)/.exec(href);
  if (m && m[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return firstNonEmpty(
    it?.invoiceNo,
    it?.invoiceNumber,
    it?.cancellationNo,
    it?.stornoNo,
    it?.stornoNumber,
  );
}

function matchesDocsQuery({ q, customerNumber, docNo, text }) {
  const raw = safeText(q);
  if (!raw) return true;

  if (isDigitsOnly(raw)) return safeText(customerNumber) === raw;

  const qq = norm(raw);
  const dn = norm(docNo);
  if (dn && dn.includes(qq)) return true;

  return norm(text).includes(qq);
}

function issuedTime(v) {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function docNoCompare(a, b) {
  const ka = safeText(extractDocNo(a));
  const kb = safeText(extractDocNo(b));
  return ka.localeCompare(kb, "de", { numeric: true, sensitivity: "base" });
}

function bookingDocHref(bid, type) {
  return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/${encodeURIComponent(
    type,
  )}`;
}

function childUidFrom(ref, doc) {
  const a = ref || {};
  const d = doc || {};
  return (
    safeText(a.childUid) ||
    safeText(a.child?.uid) ||
    safeText(a.child) ||
    safeText(d.childUid) ||
    safeText(d.child?.uid) ||
    safeText(d.child) ||
    ""
  );
}

function childNameFrom(ref, doc) {
  const a = ref || {};
  const d = doc || {};
  const first =
    safeText(a.childFirstName || a.firstName || a.child?.firstName) ||
    safeText(d.childFirstName || d.firstName || d.child?.firstName);
  const last =
    safeText(a.childLastName || a.lastName || a.child?.lastName) ||
    safeText(d.childLastName || d.lastName || d.child?.lastName);
  return { first: safeLower(first), last: safeLower(last) };
}

function matchesChildFilter({ qUid, qFirst, qLast, bookingRef, bookingDoc }) {
  const wantUid = safeText(qUid);
  const wantFirst = safeLower(qFirst);
  const wantLast = safeLower(qLast);

  if (!wantUid && !wantFirst && !wantLast) return true;

  const gotUid = childUidFrom(bookingRef, bookingDoc);
  if (wantUid && gotUid && wantUid === gotUid) return true;

  const got = childNameFrom(bookingRef, bookingDoc);
  if (wantFirst && wantFirst !== got.first) return false;
  if (wantLast && wantLast !== got.last) return false;

  return Boolean(wantFirst || wantLast);
}

function hasContractMeta(meta) {
  const signedAt = safeText(meta?.contractSignedAt);
  const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
  return Boolean(signedAt && html);
}

function readTypes(q) {
  return safeText(q || "participation,cancellation,storno,invoice,contract")
    .split(",")
    .map((s) => safeLower(s))
    .filter(Boolean);
}

function parseSort(q) {
  const [field, dirRaw] = safeText(q || "issuedAt:desc").split(":");
  return { field: field || "issuedAt", dir: dirRaw === "asc" ? "asc" : "desc" };
}

function dedupeById(items) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const id = safeText(it?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

async function loadBookingDocs(owner, bookingIds) {
  if (!bookingIds.length) return [];
  return Booking.find(
    { _id: { $in: bookingIds }, owner },
    {
      invoiceNumber: 1,
      invoiceNo: 1,
      cancellationNo: 1,
      cancellationNumber: 1,
      stornoNo: 1,
      stornoNumber: 1,
      childUid: 1,
      childFirstName: 1,
      childLastName: 1,
      child: 1,
      firstName: 1,
      lastName: 1,
      meta: 1,
    },
  )
    .lean()
    .catch(() => []);
}

async function listCustomerDocumentsAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const cid = safeText(req.params.cid);
    if (!mongoose.isValidObjectId(cid)) {
      return res.status(400).json({ ok: false, error: "Invalid customer id" });
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));

    const types = readTypes(req.query.type);

    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const q = safeText(req.query.q);
    const { field: sortField, dir: sortDir } = parseSort(req.query.sort);

    const childUid = safeText(req.query.childUid);
    const childFirst = safeText(req.query.childFirst);
    const childLast = safeText(req.query.childLast);

    const customer = await Customer.findOne({ _id: cid, owner }).lean();
    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const customerNumber = customer.userId ?? null;

    const bookingRefs = Array.isArray(customer.bookings)
      ? customer.bookings
      : [];
    const bookingIds = bookingRefs
      .map((b) => safeText(b?._id))
      .filter((id) => id && mongoose.isValidObjectId(id));

    const bookingDocs = await loadBookingDocs(owner, bookingIds);
    const bookingMap = new Map(bookingDocs.map((b) => [safeText(b._id), b]));

    const items = [];

    for (const b of bookingRefs) {
      const bid = safeText(b?._id);
      if (!bid) continue;

      const bookingDoc = bookingMap.get(bid) || {};

      if (
        !matchesChildFilter({
          qUid: childUid,
          qFirst: childFirst,
          qLast: childLast,
          bookingRef: b,
          bookingDoc,
        })
      ) {
        continue;
      }

      const offerTitle = b.offerTitle || b.offerType || b.offer || "-";

      const invNo = firstNonEmpty(
        b.invoiceNumber,
        b.invoiceNo,
        bookingDoc.invoiceNumber,
        bookingDoc.invoiceNo,
      );

      const cancNo = firstNonEmpty(
        b.cancellationNo,
        b.cancellationNumber,
        bookingDoc.cancellationNo,
        bookingDoc.cancellationNumber,
      );

      const storNo = firstNonEmpty(
        b.stornoNo,
        b.stornoNumber,
        bookingDoc.stornoNo,
        bookingDoc.stornoNumber,
      );

      const metaRef = b?.meta && typeof b.meta === "object" ? b.meta : null;
      const metaDoc =
        bookingDoc?.meta && typeof bookingDoc.meta === "object"
          ? bookingDoc.meta
          : null;

      if (types.includes("contract")) {
        const meta = hasContractMeta(metaRef) ? metaRef : metaDoc;
        if (hasContractMeta(meta)) {
          items.push({
            id: `doc:${bid}:contract`,
            bookingId: bid,
            type: "contract",
            title: `${offerTitle} – Vertrag`,
            issuedAt: meta.contractSignedAt,
            href: bookingDocHref(bid, "contract"),
            offerTitle,
            offerType: b.offerType || "",
            customerNumber,
          });
        }
      }

      if (types.includes("invoice")) {
        const resolved = await resolveAmountsFromBookingRef(b);

        const startISO = b.date
          ? new Date(b.date).toISOString().slice(0, 10)
          : null;

        const hasRefs =
          Array.isArray(b.invoiceRefs) && b.invoiceRefs.length > 0;

        if (hasRefs) {
          for (const r of b.invoiceRefs) {
            if (!r?.number) continue;

            items.push({
              id: `doc:${bid}:invoice:${r.number}`,
              bookingId: bid,
              type: "invoice",
              title: `${offerTitle} – Rechnung (${r.number})`,
              issuedAt: r.date || startISO || b.createdAt || new Date(),
              href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=ref&no=${encodeURIComponent(
                r.number,
              )}`,
              offerTitle,
              offerType: b.offerType || "",
              invoiceNo: r.number,
              invoiceNumber: r.number,
              customerNumber,
            });
          }
        } else {
          const monthly = resolved.priceMonthly;
          const oneOff =
            typeof b.priceAtBooking === "number"
              ? Number(b.priceAtBooking)
              : monthly != null
                ? Number(monthly)
                : null;

          const isWeekly = (b.priceFirstMonth ?? b.firstMonthAmount) != null;

          if (isWeekly && startISO && monthly != null) {
            items.push({
              id: `doc:${bid}:invoice:first`,
              bookingId: bid,
              type: "invoice",
              title: `${offerTitle} – Rechnung (1. Monat)`,
              issuedAt: startISO,
              href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=weekly&type=first`,
              offerTitle,
              offerType: b.offerType || "",
              invoiceNo: invNo,
              invoiceNumber: invNo,
              customerNumber,
            });

            const recurISO = nextPeriodStart(startISO);
            if (recurISO) {
              items.push({
                id: `doc:${bid}:invoice:recurring`,
                bookingId: bid,
                type: "invoice",
                title: `${offerTitle} – Rechnung (monatlich)`,
                issuedAt: recurISO,
                href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=weekly&type=recurring`,
                offerTitle,
                offerType: b.offerType || "",
                invoiceNo: invNo,
                invoiceNumber: invNo,
                customerNumber,
              });
            }
          } else if (oneOff != null) {
            items.push({
              id: `doc:${bid}:invoice:oneoff`,
              bookingId: bid,
              type: "invoice",
              title: `${offerTitle} – Rechnung`,
              issuedAt: startISO || b.createdAt || new Date(),
              href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=oneoff`,
              offerTitle,
              offerType: b.offerType || "",
              invoiceNo: invNo,
              invoiceNumber: invNo,
              customerNumber,
            });
          }
        }
      }

      if (types.includes("participation")) {
        items.push({
          id: `doc:${bid}:participation`,
          bookingId: bid,
          type: "participation",
          title: `${offerTitle} – Teilnahmebestätigung`,
          issuedAt: b.date || b.createdAt || new Date(),
          href: bookingDocHref(bid, "participation"),
          offerTitle,
          offerType: b.offerType || "",
          invoiceNo: invNo,
          invoiceNumber: invNo,
          customerNumber,
        });
      }

      const isCancelled =
        b.status === "cancelled" || b.cancelDate || b.cancellationDate;

      if (types.includes("cancellation") && isCancelled) {
        items.push({
          id: `doc:${bid}:cancellation`,
          bookingId: bid,
          type: "cancellation",
          title: `${offerTitle} – Kündigungsbestätigung`,
          issuedAt:
            b.cancelDate || b.cancellationDate || b.updatedAt || new Date(),
          href: bookingDocHref(bid, "cancellation"),
          offerTitle,
          offerType: b.offerType || "",
          cancellationNo: cancNo,
          customerNumber,
        });
      }

      const hasStorno =
        storNo ||
        typeof b.stornoAmount === "number" ||
        safeLower(b.cancelReason).includes("storno");

      if (types.includes("storno") && hasStorno) {
        items.push({
          id: `doc:${bid}:storno`,
          bookingId: bid,
          type: "storno",
          title: `${offerTitle} – Stornorechnung`,
          issuedAt: b.cancelDate || b.updatedAt || new Date(),
          href: bookingDocHref(bid, "storno"),
          offerTitle,
          offerType: b.offerType || "",
          stornoNo: storNo,
          stornoNumber: storNo,
          customerNumber,
        });
      }
    }

    const filtered = dedupeById(items).filter((it) => {
      const text = `${it.title} ${it.offerTitle} ${it.offerType} ${it.type}`;
      const docNo = extractDocNo(it);

      if (!matchesDocsQuery({ q, customerNumber, docNo, text })) return false;

      if (from) {
        const d = new Date(it.issuedAt);
        if (isFinite(+from) && isFinite(+d) && d < from) return false;
      }

      if (to) {
        const d = new Date(it.issuedAt);
        if (isFinite(+to) && isFinite(+d) && d > to) return false;
      }

      return true;
    });

    if (sortField === "issuedAt") {
      const mul = sortDir === "asc" ? 1 : -1;

      filtered.sort((a, b) => {
        const ta = issuedTime(a.issuedAt);
        const tb = issuedTime(b.issuedAt);
        if (ta !== tb) return (ta - tb) * mul;

        const dn = docNoCompare(a, b);
        if (dn !== 0) return dn * mul;

        return safeText(a.id).localeCompare(safeText(b.id)) * mul;
      });
    }

    const total = filtered.length;
    const start = (page - 1) * limit;
    const pageItems = filtered.slice(start, start + limit);

    return res.json({ ok: true, items: pageItems, total, page, limit });
  } catch (err) {
    console.error("[customers/:cid/documents] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = { listCustomerDocumentsAction };

// "use strict";

// const mongoose = require("mongoose");

// const Customer = require("../../../models/Customer");
// const Booking = require("../../../models/Booking");

// const { nextPeriodStart } = require("../../../utils/billing");

// const { requireOwner } = require("../helpers/provider");
// const { resolveAmountsFromBookingRef } = require("../helpers/amounts");

// function safeLower(v) {
//   return String(v ?? "")
//     .trim()
//     .toLowerCase();
// }

// function childUidFrom(bookingRef, bookingDoc) {
//   const a = bookingRef || {};
//   const d = bookingDoc || {};
//   return (
//     String(a.childUid || "").trim() ||
//     String(a.child?.uid || "").trim() ||
//     String(a.child || "").trim() ||
//     String(d.childUid || "").trim() ||
//     String(d.child?.uid || "").trim() ||
//     String(d.child || "").trim()
//   );
// }

// function childNameFrom(bookingRef, bookingDoc) {
//   const a = bookingRef || {};
//   const d = bookingDoc || {};
//   const first =
//     String(
//       a.childFirstName || a.firstName || a.child?.firstName || "",
//     ).trim() ||
//     String(d.childFirstName || d.firstName || d.child?.firstName || "").trim();
//   const last =
//     String(a.childLastName || a.lastName || a.child?.lastName || "").trim() ||
//     String(d.childLastName || d.lastName || d.child?.lastName || "").trim();
//   return { first: safeLower(first), last: safeLower(last) };
// }

// function matchesChildFilter({ qUid, qFirst, qLast, bookingRef, bookingDoc }) {
//   const wantUid = String(qUid || "").trim();
//   const wantFirst = safeLower(qFirst);
//   const wantLast = safeLower(qLast);

//   if (!wantUid && !wantFirst && !wantLast) return true;

//   const gotUid = childUidFrom(bookingRef, bookingDoc);
//   if (wantUid && gotUid && wantUid === gotUid) return true;

//   const got = childNameFrom(bookingRef, bookingDoc);
//   if (wantFirst && wantFirst !== got.first) return false;
//   if (wantLast && wantLast !== got.last) return false;

//   return Boolean(wantFirst || wantLast);
// }

// function norm(v) {
//   return String(v ?? "")
//     .trim()
//     .toLowerCase();
// }

// function isDigitsOnly(s) {
//   return /^\d+$/.test(String(s || "").trim());
// }

// function firstNonEmpty(...vals) {
//   for (const v of vals) {
//     const s = String(v ?? "").trim();
//     if (s) return s;
//   }
//   return "";
// }

// function extractDocNo(it) {
//   const href = String(it?.href || "");
//   const m = /[?&]no=([^&]+)/.exec(href);
//   if (m && m[1]) {
//     try {
//       return decodeURIComponent(m[1]);
//     } catch {
//       return m[1];
//     }
//   }

//   return firstNonEmpty(
//     it?.invoiceNo,
//     it?.invoiceNumber,
//     it?.cancellationNo,
//     it?.stornoNo,
//     it?.stornoNumber,
//   );
// }

// function matchesDocsQuery({ q, customerNumber, docNo, text }) {
//   const raw = String(q || "").trim();
//   if (!raw) return true;

//   if (isDigitsOnly(raw)) {
//     return String(customerNumber ?? "").trim() === raw;
//   }

//   const qq = norm(raw);

//   const dn = norm(docNo);
//   if (dn && dn.includes(qq)) return true;

//   return norm(text).includes(qq);
// }

// // function participationHref(bid) {
// //   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/participation`;
// // }

// // function cancellationHref(bid) {
// //   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/cancellation`;
// // }

// // function stornoHref(bid) {
// //   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/storno`;
// // }

// // function contractHref(bid) {
// //   return `/api/admin/bookings/${encodeURIComponent(bid)}/documents/contract`;
// // }

// function participationHref(bid) {
//   return `/api/admin/customers/bookings/${encodeURIComponent(bid)}/documents/participation`;
// }

// function cancellationHref(bid) {
//   return `/api/admin/customers/bookings/${encodeURIComponent(bid)}/documents/cancellation`;
// }

// function stornoHref(bid) {
//   return `/api/admin/customers/bookings/${encodeURIComponent(bid)}/documents/storno`;
// }

// function contractHref(bid) {
//   return `/api/admin/customers/bookings/${encodeURIComponent(bid)}/documents/contract`;
// }

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function hasContractMeta(meta) {
//   const signedAt = safeText(meta?.contractSignedAt);
//   const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
//   return Boolean(signedAt && html);
// }

// async function listCustomerDocumentsAction(req, res) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const cid = String(req.params.cid || "").trim();
//     if (!mongoose.isValidObjectId(cid)) {
//       return res.status(400).json({ ok: false, error: "Invalid customer id" });
//     }

//     const page = Math.max(1, Number(req.query.page || 1));
//     const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));

//     const types = String(
//       req.query.type || "participation,cancellation,storno,invoice,contract",
//     )
//       .split(",")
//       .map((s) => s.trim().toLowerCase())
//       .filter(Boolean);

//     const from = req.query.from ? new Date(String(req.query.from)) : null;
//     const to = req.query.to ? new Date(String(req.query.to)) : null;
//     const q = String(req.query.q || "");
//     const sort = String(req.query.sort || "issuedAt:desc");

//     const childUid = String(req.query.childUid || "").trim();
//     const childFirst = String(req.query.childFirst || "").trim();
//     const childLast = String(req.query.childLast || "").trim();

//     const customer = await Customer.findOne({ _id: cid, owner }).lean();
//     if (!customer) {
//       return res.status(404).json({ ok: false, error: "Customer not found" });
//     }

//     const customerNumber = customer.userId ?? null;

//     const bookingIds = (customer.bookings || [])
//       .map((b) => (b?._id ? String(b._id) : ""))
//       .filter(Boolean);

//     const bookingDocs = bookingIds.length
//       ? await Booking.find(
//           { _id: { $in: bookingIds }, owner },
//           {
//             invoiceNumber: 1,
//             invoiceNo: 1,
//             cancellationNo: 1,
//             cancellationNumber: 1,
//             stornoNo: 1,
//             stornoNumber: 1,
//             childUid: 1,
//             childFirstName: 1,
//             childLastName: 1,
//             child: 1,
//             firstName: 1,
//             lastName: 1,
//             "meta.contractSignedAt": 1,
//             "meta.contractSnapshot.contractDoc": 1,
//           },
//         ).lean()
//       : [];

//     const bookingMap = new Map();
//     for (const b of bookingDocs) bookingMap.set(String(b._id), b);

//     const items = [];

//     for (const b of customer.bookings || []) {
//       if (!b?._id) continue;

//       const bid = String(b._id);
//       const offerTitle = b.offerTitle || b.offerType || b.offer || "-";

//       const bookingDoc = bookingMap.get(bid) || {};

//       if (
//         !matchesChildFilter({
//           qUid: childUid,
//           qFirst: childFirst,
//           qLast: childLast,
//           bookingRef: b,
//           bookingDoc,
//         })
//       ) {
//         continue;
//       }

//       const metaFromRef = b?.meta && typeof b.meta === "object" ? b.meta : null;
//       const metaFromDoc =
//         bookingDoc?.meta && typeof bookingDoc.meta === "object"
//           ? bookingDoc.meta
//           : null;

//       const invNo = firstNonEmpty(
//         b.invoiceNumber,
//         b.invoiceNo,
//         bookingDoc.invoiceNumber,
//         bookingDoc.invoiceNo,
//       );

//       const cancNo = firstNonEmpty(
//         b.cancellationNo,
//         b.cancellationNumber,
//         bookingDoc.cancellationNo,
//         bookingDoc.cancellationNumber,
//       );

//       const storNo = firstNonEmpty(
//         b.stornoNo,
//         b.stornoNumber,
//         bookingDoc.stornoNo,
//         bookingDoc.stornoNumber,
//       );

//       if (types.includes("contract")) {
//         const meta = hasContractMeta(metaFromRef) ? metaFromRef : metaFromDoc;
//         if (hasContractMeta(meta)) {
//           items.push({
//             id: `doc:${bid}:contract`,
//             bookingId: bid,
//             type: "contract",
//             title: `${offerTitle} – Vertrag`,
//             issuedAt: meta.contractSignedAt,
//             href: contractHref(bid),
//             offerTitle,
//             offerType: b.offerType || "",
//             customerNumber,
//           });
//         }
//       }

//       if (types.includes("invoice")) {
//         const resolved = await resolveAmountsFromBookingRef(b);

//         const startISO = b.date
//           ? new Date(b.date).toISOString().slice(0, 10)
//           : null;

//         const hasRefs =
//           Array.isArray(b.invoiceRefs) && b.invoiceRefs.length > 0;

//         if (hasRefs) {
//           for (const r of b.invoiceRefs) {
//             if (!r?.number) continue;

//             items.push({
//               id: `doc:${bid}:invoice:${r.number}`,
//               bookingId: bid,
//               type: "invoice",
//               title: `${offerTitle} – Rechnung (${r.number})`,
//               issuedAt: r.date || startISO || b.createdAt || new Date(),
//               href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=ref&no=${encodeURIComponent(
//                 r.number,
//               )}`,
//               offerTitle,
//               offerType: b.offerType || "",
//               invoiceNo: r.number,
//               invoiceNumber: r.number,
//               customerNumber,
//             });
//           }
//         } else {
//           const monthly = resolved.priceMonthly;
//           const oneOff =
//             typeof b.priceAtBooking === "number"
//               ? Number(b.priceAtBooking)
//               : monthly != null
//                 ? Number(monthly)
//                 : null;

//           const isWeekly = (b.priceFirstMonth ?? b.firstMonthAmount) != null;

//           if (isWeekly && startISO && monthly != null) {
//             items.push({
//               id: `doc:${bid}:invoice:first`,
//               bookingId: bid,
//               type: "invoice",
//               title: `${offerTitle} – Rechnung (1. Monat)`,
//               issuedAt: startISO,
//               href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=weekly&type=first`,
//               offerTitle,
//               offerType: b.offerType || "",
//               invoiceNo: invNo,
//               invoiceNumber: invNo,
//               customerNumber,
//             });

//             const recurISO = nextPeriodStart(startISO);
//             if (recurISO) {
//               items.push({
//                 id: `doc:${bid}:invoice:recurring`,
//                 bookingId: bid,
//                 type: "invoice",
//                 title: `${offerTitle} – Rechnung (monatlich)`,
//                 issuedAt: recurISO,
//                 href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=weekly&type=recurring`,
//                 offerTitle,
//                 offerType: b.offerType || "",
//                 invoiceNo: invNo,
//                 invoiceNumber: invNo,
//                 customerNumber,
//               });
//             }
//           } else if (oneOff != null) {
//             items.push({
//               id: `doc:${bid}:invoice:oneoff`,
//               bookingId: bid,
//               type: "invoice",
//               title: `${offerTitle} – Rechnung`,
//               issuedAt: startISO || b.createdAt || new Date(),
//               href: `/api/admin/customers/${customer._id}/bookings/${bid}/invoice.pdf?mode=oneoff`,
//               offerTitle,
//               offerType: b.offerType || "",
//               invoiceNo: invNo,
//               invoiceNumber: invNo,
//               customerNumber,
//             });
//           }
//         }
//       }

//       if (types.includes("participation")) {
//         items.push({
//           id: `doc:${bid}:participation`,
//           bookingId: bid,
//           type: "participation",
//           title: `${offerTitle} – Teilnahmebestätigung`,
//           issuedAt: b.date || b.createdAt || new Date(),
//           href: participationHref(bid),
//           offerTitle,
//           offerType: b.offerType || "",
//           invoiceNo: invNo,
//           invoiceNumber: invNo,
//           customerNumber,
//         });
//       }

//       const isCancelled =
//         b.status === "cancelled" || b.cancelDate || b.cancellationDate;

//       if (types.includes("cancellation") && isCancelled) {
//         items.push({
//           id: `doc:${bid}:cancellation`,
//           bookingId: bid,
//           type: "cancellation",
//           title: `${offerTitle} – Kündigungsbestätigung`,
//           issuedAt:
//             b.cancelDate || b.cancellationDate || b.updatedAt || new Date(),
//           href: cancellationHref(bid),
//           offerTitle,
//           offerType: b.offerType || "",
//           cancellationNo: cancNo,
//           customerNumber,
//         });
//       }

//       const hasStorno =
//         storNo ||
//         typeof b.stornoAmount === "number" ||
//         String(b.cancelReason || "")
//           .toLowerCase()
//           .includes("storno");

//       if (types.includes("storno") && hasStorno) {
//         items.push({
//           id: `doc:${bid}:storno`,
//           bookingId: bid,
//           type: "storno",
//           title: `${offerTitle} – Stornorechnung`,
//           issuedAt: b.cancelDate || b.updatedAt || new Date(),
//           href: stornoHref(bid),
//           offerTitle,
//           offerType: b.offerType || "",
//           stornoNo: storNo,
//           stornoNumber: storNo,
//           customerNumber,
//         });
//       }
//     }

//     const filtered = items.filter((it) => {
//       const text = `${it.title} ${it.offerTitle} ${it.offerType} ${it.type}`;
//       const docNo = extractDocNo(it);

//       if (!matchesDocsQuery({ q, customerNumber, docNo, text })) return false;

//       if (from) {
//         const d = new Date(it.issuedAt);
//         if (isFinite(+from) && isFinite(+d) && d < from) return false;
//       }

//       if (to) {
//         const d = new Date(it.issuedAt);
//         if (isFinite(+to) && isFinite(+d) && d > to) return false;
//       }

//       return true;
//     });

//     function issuedTime(v) {
//       if (!v) return 0;
//       const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
//       return Number.isFinite(t) ? t : 0;
//     }

//     function docNoKey(it) {
//       return String(extractDocNo(it) || "").trim();
//     }

//     function docNoCompare(a, b) {
//       return docNoKey(a).localeCompare(docNoKey(b), "de", {
//         numeric: true,
//         sensitivity: "base",
//       });
//     }

//     const [field, dirRaw] = String(sort || "issuedAt:desc").split(":");
//     const dir = dirRaw === "asc" ? "asc" : "desc";

//     if (field === "issuedAt") {
//       const mul = dir === "asc" ? 1 : -1;

//       filtered.sort((a, b) => {
//         const ta = issuedTime(a.issuedAt);
//         const tb = issuedTime(b.issuedAt);
//         if (ta !== tb) return (ta - tb) * mul;

//         const dn = docNoCompare(a, b);
//         if (dn !== 0) return dn * mul;

//         return String(a.id || "").localeCompare(String(b.id || "")) * mul;
//       });
//     }

//     const total = filtered.length;
//     const start = (page - 1) * limit;
//     const end = start + limit;
//     const pageItems = filtered.slice(start, end);

//     return res.json({ ok: true, items: pageItems, total, page, limit });
//   } catch (err) {
//     console.error("[customers/:cid/documents] error:", err);
//     return res.status(500).json({ ok: false, error: "Server error" });
//   }
// }

// module.exports = { listCustomerDocumentsAction };
