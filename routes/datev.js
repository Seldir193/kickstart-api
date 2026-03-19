// routes/datev.js
"use strict";

const express = require("express");
const { requireOwner } = require("./datev/helpers/ownerHelpers");
const { buildDatevExport } = require("./datev/services/buildDatevExport");

const router = express.Router();

async function handleDatevExport(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;
    await buildDatevExport({ req, res, owner });
  } catch (err) {
    console.error(err);
    res.status(500).json(buildServerError(err));
  }
}

function buildServerError(err) {
  return {
    ok: false,
    error: "Server error",
    detail: String(err?.message || err),
  };
}

router.get("/export", handleDatevExport);

module.exports = router;

// "use strict";

// const express = require("express");
// const mongoose = require("mongoose");
// const archiver = require("archiver");

// const Customer = require("../models/Customer");
// const Offer = require("../models/Offer");
// const BillingDocument = require("../models/BillingDocument");

// const router = express.Router();

// function getProviderIdRaw(req) {
//   const v = req.get("x-provider-id");
//   return v ? String(v).trim() : null;
// }

// function getProviderObjectId(req) {
//   const raw = getProviderIdRaw(req);
//   if (!raw || !mongoose.isValidObjectId(raw)) return null;
//   return new mongoose.Types.ObjectId(raw);
// }

// function requireOwner(req, res) {
//   const owner = getProviderObjectId(req);
//   if (!owner) {
//     res
//       .status(401)
//       .json({ ok: false, error: "Unauthorized: invalid provider id" });
//     return null;
//   }
//   return owner;
// }

// function parseISODate(d, endOfDay = false) {
//   if (!d) return null;
//   const iso = String(d).slice(0, 10);
//   const t = new Date(`${iso}T00:00:00`);
//   if (Number.isNaN(t.getTime())) return null;
//   if (endOfDay) t.setHours(23, 59, 59, 999);
//   return t;
// }

// function yyyymmdd(d) {
//   const dt = new Date(d);
//   if (Number.isNaN(dt.getTime())) return "";
//   const y = dt.getFullYear();
//   const m = String(dt.getMonth() + 1).padStart(2, "0");
//   const day = String(dt.getDate()).padStart(2, "0");
//   return `${y}${m}${day}`;
// }

// function fmtDE(n) {
//   const v = Number(n);
//   if (!Number.isFinite(v)) return "";
//   return (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
// }

// function isInside(date, from, to) {
//   if (!date) return false;
//   const dt = new Date(date);
//   if (Number.isNaN(dt.getTime())) return false;
//   if (from && dt < from) return false;
//   if (to && dt > to) return false;
//   return true;
// }

// function numGT0(v) {
//   const n = Number(v);
//   if (!Number.isFinite(n) || n <= 0) return null;
//   return n;
// }

// function courseOnly(raw = "") {
//   let s = String(raw || "").trim();
//   s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];
//   const commaDigit = s.search(/,\s*\d/);
//   if (commaDigit > 0) s = s.slice(0, commaDigit);
//   const dashAddr = s.search(/\s-\s*\d/);
//   if (dashAddr > 0) s = s.slice(0, dashAddr);
//   return s.trim();
// }

// function cleanText(s = "") {
//   const raw = String(s || "")
//     .replace(/[;\r\n]+/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();
//   return raw.slice(0, 60);
// }

// function pickAmountInvoice(b, offer) {
//   const cand = [
//     b?.firstMonthAmount,
//     b?.monthlyAmount,
//     b?.priceAtBooking,
//     offer?.price,
//   ];

//   for (const v of cand) {
//     const n = Number(v);
//     if (Number.isFinite(n) && n > 0) return n;
//   }

//   return null;
// }

// function pickAmountStorno(b, offer) {
//   const cand = [b?.stornoAmount, b?.priceAtBooking, offer?.price];

//   for (const v of cand) {
//     const n = Number(v);
//     if (Number.isFinite(n) && n > 0) return n;
//   }

//   return null;
// }

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function safeLower(v) {
//   return safeText(v).toLowerCase();
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

// function creditRefDateValue(value) {
//   const time = new Date(value || 0).getTime();
//   return Number.isFinite(time) ? time : 0;
// }

// function normalizeCreditRef(ref) {
//   const number = safeText(ref?.number);
//   const amount = Math.abs(Number(ref?.amount || ref?.finalPrice || 0));
//   const date = ref?.date || null;

//   if (!number) return null;
//   if (!Number.isFinite(amount) || amount <= 0) return null;

//   return { number, amount, date };
// }

// function pickFinalCreditRefFromBooking(booking, offer) {
//   const metaNo = safeText(booking?.meta?.creditNoteNo);
//   const metaDate =
//     booking?.meta?.creditNoteDate ||
//     booking?.returnedAt ||
//     booking?.updatedAt ||
//     booking?.createdAt ||
//     null;

//   const metaAmount = Math.abs(
//     Number(
//       booking?.meta?.creditNoteAmount ??
//         booking?.priceAtBooking ??
//         booking?.stornoAmount ??
//         offer?.price ??
//         0,
//     ),
//   );

//   if (metaNo && Number.isFinite(metaAmount) && metaAmount > 0) {
//     return {
//       number: metaNo,
//       amount: metaAmount,
//       date: metaDate,
//     };
//   }

//   const invoiceRefs = Array.isArray(booking?.invoiceRefs)
//     ? booking.invoiceRefs
//     : [];

//   const creditRefs = invoiceRefs
//     .filter(isCreditInvoiceRef)
//     .map(normalizeCreditRef)
//     .filter(Boolean)
//     .sort((a, b) => creditRefDateValue(b.date) - creditRefDateValue(a.date));

//   if (creditRefs.length) return creditRefs[0];

//   return null;
// }

// function safeStage(doc) {
//   const s = String(doc?.stage || "").trim();
//   return s || "reminder";
// }

// function dunningLink(doc) {
//   const id = String(doc?._id || "").trim();
//   if (!id) return "";
//   return `/api/admin/invoices/dunning-documents/${id}/download`;
// }

// function buildDunningBelegnummer(doc, suffix) {
//   const inv = String(doc?.invoiceNo || "").trim() || "NO-INVOICE";
//   const stage = safeStage(doc);
//   return `DUN-${inv}-${stage}-${suffix}`;
// }

// function buildDunningText(doc, label) {
//   const inv = String(doc?.invoiceNo || "").trim() || "NO-INVOICE";
//   const stage = safeStage(doc);
//   return cleanText(`${label} – ${inv} – ${stage}`);
// }

// function pushExtfRow(extfRows, row) {
//   extfRows.push(
//     [
//       row.Umsatz,
//       row.SH,
//       row.WKZ,
//       row.Konto,
//       row.Gegenkonto,
//       row.BU,
//       row.Belegdatum,
//       row.Belegnummer,
//       row.Buchungstext,
//       "",
//     ].join(";"),
//   );
// }

// function pushReadableRow(readable, extfRows, row) {
//   readable.push(row);
//   pushExtfRow(extfRows, row);
// }

// function buildInvoiceRow(args) {
//   const {
//     amount,
//     currency,
//     arAccount,
//     revAccount,
//     date,
//     number,
//     text,
//     link = "",
//     reverse = false,
//     sh = "S",
//   } = args;

//   return {
//     Umsatz: fmtDE(amount),
//     SH: sh,
//     WKZ: currency,
//     Konto: reverse ? revAccount : arAccount,
//     Gegenkonto: reverse ? arAccount : revAccount,
//     BU: 0,
//     Belegdatum: yyyymmdd(date),
//     Belegnummer: number,
//     Buchungstext: cleanText(text),
//     Beleglink: link,
//   };
// }

// function pushCreditRows(args) {
//   const {
//     readable,
//     extfRows,
//     booking,
//     offer,
//     course,
//     from,
//     to,
//     currency,
//     arAccount,
//     revAccount,
//     stats,
//   } = args;

//   const finalCredit = pickFinalCreditRefFromBooking(booking, offer);

//   if (finalCredit) {
//     const creditNo = safeText(finalCredit.number);
//     const creditDt = finalCredit.date;
//     const creditAmt = Number(finalCredit.amount || 0);

//     if (
//       creditNo &&
//       creditDt &&
//       isInside(creditDt, from, to) &&
//       Number.isFinite(creditAmt) &&
//       creditAmt > 0
//     ) {
//       const row = buildInvoiceRow({
//         amount: creditAmt,
//         currency,
//         arAccount,
//         revAccount,
//         date: creditDt,
//         number: creditNo,
//         text: `Gutschrift – ${course}`,
//         reverse: true,
//       });

//       pushReadableRow(readable, extfRows, row);
//       stats.crOk++;
//       return;
//     }
//   }

//   const stNo = safeText(booking?.stornoNo || booking?.stornoNumber);
//   const stDt =
//     booking?.stornoDate ||
//     booking?.cancelDate ||
//     booking?.cancellationDate ||
//     booking?.invoiceDate ||
//     booking?.date ||
//     booking?.createdAt ||
//     null;
//   const stAmt = pickAmountStorno(booking, offer);

//   if (
//     stNo &&
//     stDt &&
//     isInside(stDt, from, to) &&
//     Number.isFinite(stAmt) &&
//     stAmt > 0
//   ) {
//     const row = buildInvoiceRow({
//       amount: stAmt,
//       currency,
//       arAccount,
//       revAccount,
//       date: stDt,
//       number: stNo,
//       text: `Gutschrift – ${course}`,
//       reverse: true,
//     });

//     pushReadableRow(readable, extfRows, row);
//     stats.stOk++;
//     return;
//   }

//   stats.stSkip++;
// }

// router.get("/export", async (req, res) => {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const from = parseISODate(req.query.from, false);
//     const to = parseISODate(req.query.to, true);

//     const AR_ACCOUNT = Number(process.env.DATEV_AR_ACCOUNT || 10000);
//     const REV_ACCOUNT = Number(process.env.DATEV_REVENUE_ACCOUNT || 8195);
//     const CURRENCY = (process.env.DATEV_CURRENCY || "EUR").toUpperCase();
//     const EXPORT_NAME =
//       process.env.DATEV_EXPORT_NAME || "Münchner Fussball Schule NRW";

//     const customers = await Customer.find({ owner })
//       .select("_id userId parent child address bookings")
//       .lean();

//     const offerIds = [];
//     for (const c of customers) {
//       for (const b of c.bookings || []) {
//         for (const key of ["offerId", "offer_id", "offer", "offerRef"]) {
//           const v = b?.[key];
//           if (v && mongoose.isValidObjectId(String(v))) {
//             offerIds.push(String(v));
//           }
//         }
//       }
//     }

//     const unique = [...new Set(offerIds)];
//     const offers = unique.length
//       ? await Offer.find({ _id: { $in: unique } })
//           .select("_id title type sub_type location price")
//           .lean()
//       : [];

//     const offerById = new Map(offers.map((o) => [String(o._id), o]));
//     const readable = [];
//     const extfRows = [];
//     const stats = {
//       invOk: 0,
//       invSkip: 0,
//       stOk: 0,
//       stSkip: 0,
//       crOk: 0,
//       dunDocs: 0,
//       dunDocsDedup: 0,
//       dunRows: 0,
//     };

//     for (const c of customers) {
//       for (const b of c.bookings || []) {
//         let off = null;

//         for (const key of ["offerId", "offer_id", "offer", "offerRef"]) {
//           const v = b?.[key];
//           if (v && mongoose.isValidObjectId(String(v))) {
//             off = offerById.get(String(v));
//             if (off) break;
//           }
//         }

//         const course = courseOnly(
//           b.offerTitle || b.offerType || off?.sub_type || off?.title || "Kurs",
//         );

//         const invNo = safeText(b?.invoiceNumber || b?.invoiceNo);
//         const invDt = b?.invoiceDate || b?.date || b?.createdAt || null;
//         const invAmt = pickAmountInvoice(b, off);

//         if (
//           invNo &&
//           invDt &&
//           isInside(invDt, from, to) &&
//           Number.isFinite(invAmt) &&
//           invAmt > 0
//         ) {
//           const row = buildInvoiceRow({
//             amount: invAmt,
//             currency: CURRENCY,
//             arAccount: AR_ACCOUNT,
//             revAccount: REV_ACCOUNT,
//             date: invDt,
//             number: invNo,
//             text: `Teilnahme – ${course}`,
//           });

//           pushReadableRow(readable, extfRows, row);
//           stats.invOk++;
//         } else {
//           stats.invSkip++;
//         }

//         pushCreditRows({
//           readable,
//           extfRows,
//           booking: b,
//           offer: off,
//           course,
//           from,
//           to,
//           currency: CURRENCY,
//           arAccount: AR_ACCOUNT,
//           revAccount: REV_ACCOUNT,
//           stats,
//         });
//       }
//     }

//     const batchId = `datev-${yyyymmdd(new Date())}-${Date.now()}`;

//     const dunningDocsRaw = await BillingDocument.find({
//       owner: String(owner),
//       kind: "dunning",
//       sentAt: { $ne: null },
//     })
//       .select(
//         "_id stage invoiceNo sentAt createdAt feesSnapshot voidedAt datevExportedAt datevVoidedExportedAt",
//       )
//       .sort({ createdAt: 1 })
//       .lean();

//     stats.dunDocs = dunningDocsRaw.length;

//     const firstByKey = new Map();
//     for (const doc of dunningDocsRaw) {
//       const inv = String(doc?.invoiceNo || "").trim() || "NO-INVOICE";
//       const stage = safeStage(doc);
//       const key = `${inv}__${stage}`;
//       if (firstByKey.has(key)) continue;
//       firstByKey.set(key, doc);
//     }

//     const dunningFirstDocs = [...firstByKey.values()];
//     stats.dunDocsDedup = dunningFirstDocs.length;

//     const exportedIds = [];
//     const voidedCorrectionIds = [];

//     function pushDunningFeeRowsWithMode({
//       readable,
//       extfRows,
//       doc,
//       AR_ACCOUNT,
//       REV_ACCOUNT,
//       CURRENCY,
//       from,
//       to,
//       mode,
//     }) {
//       const dt =
//         mode === "void-storno" ? doc?.voidedAt || null : doc?.sentAt || null;

//       if (!dt || !isInside(dt, from, to)) return 0;

//       const fees = doc?.feesSnapshot || {};
//       const items = [
//         { key: "returnBankFee", suffix: "RLS", label: "Rücklastschriftgebühr" },
//         { key: "dunningFee", suffix: "MAHN", label: "Mahngebühr" },
//         { key: "processingFee", suffix: "BEARB", label: "Bearbeitungsgebühr" },
//       ];

//       let pushed = 0;

//       for (const it of items) {
//         const amt = numGT0(fees?.[it.key]);
//         if (!amt) continue;

//         const belegSuffix =
//           mode === "void-storno" ? `${it.suffix}-STO` : it.suffix;
//         const belegLabel =
//           mode === "void-storno" ? `${it.label} (Storno)` : it.label;

//         const row = buildInvoiceRow({
//           amount: amt,
//           currency: CURRENCY,
//           arAccount: AR_ACCOUNT,
//           revAccount: REV_ACCOUNT,
//           date: dt,
//           number: buildDunningBelegnummer(doc, belegSuffix),
//           text: buildDunningText(doc, belegLabel),
//           link: dunningLink(doc),
//           sh: mode === "void-storno" ? "H" : "S",
//         });

//         pushReadableRow(readable, extfRows, row);
//         pushed++;
//       }

//       return pushed;
//     }

//     for (const doc of dunningFirstDocs) {
//       if (doc?.voidedAt) continue;

//       const added = pushDunningFeeRowsWithMode({
//         readable,
//         extfRows,
//         doc,
//         AR_ACCOUNT,
//         REV_ACCOUNT,
//         CURRENCY,
//         from,
//         to,
//         mode: "normal",
//       });

//       if (added > 0) exportedIds.push(String(doc._id));
//       stats.dunRows += added;
//     }

//     for (const doc of dunningFirstDocs) {
//       if (!doc?.voidedAt) continue;
//       if (!doc?.datevExportedAt) continue;
//       if (doc?.datevVoidedExportedAt) continue;

//       const voidedAfterExport =
//         new Date(doc.voidedAt).getTime() >
//         new Date(doc.datevExportedAt).getTime();

//       if (!voidedAfterExport) continue;

//       const added = pushDunningFeeRowsWithMode({
//         readable,
//         extfRows,
//         doc,
//         AR_ACCOUNT,
//         REV_ACCOUNT,
//         CURRENCY,
//         from,
//         to,
//         mode: "void-storno",
//       });

//       if (added > 0) voidedCorrectionIds.push(String(doc._id));
//       stats.dunRows += added;
//     }

//     try {
//       const now = new Date();

//       if (exportedIds.length) {
//         await BillingDocument.updateMany(
//           {
//             _id: {
//               $in: exportedIds.map((x) => new mongoose.Types.ObjectId(x)),
//             },
//             datevExportedAt: null,
//             voidedAt: null,
//           },
//           { $set: { datevExportedAt: now, datevBatchId: batchId } },
//         );
//       }

//       if (voidedCorrectionIds.length) {
//         await BillingDocument.updateMany(
//           {
//             _id: {
//               $in: voidedCorrectionIds.map(
//                 (x) => new mongoose.Types.ObjectId(x),
//               ),
//             },
//             datevVoidedExportedAt: null,
//           },
//           { $set: { datevVoidedExportedAt: now, datevVoidedBatchId: batchId } },
//         );
//       }
//     } catch (e) {
//       console.error("[DATEV] tracking update failed:", e);
//     }

//     res.setHeader("Content-Type", "application/zip");

//     const ts = new Date();
//     const y = ts.getFullYear();
//     const m = String(ts.getMonth() + 1).padStart(2, "0");
//     const d = String(ts.getDate()).padStart(2, "0");

//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="datev-export-${y}${m}${d}.zip"`,
//     );

//     const archive = archiver("zip", { zlib: { level: 3 } });

//     archive.on("error", () => {
//       try {
//         res.status(500).end();
//       } catch {}
//     });

//     archive.pipe(res);

//     const readableHeader =
//       "Umsatz;SH;WKZ;Konto;Gegenkonto;BU;Belegdatum;Belegnummer;Buchungstext;Beleglink\n";

//     const readableBody = readable
//       .map((r) =>
//         [
//           r.Umsatz,
//           r.SH,
//           r.WKZ,
//           r.Konto,
//           r.Gegenkonto,
//           r.BU,
//           r.Belegdatum,
//           r.Belegnummer,
//           r.Buchungstext,
//           r.Beleglink,
//         ].join(";"),
//       )
//       .join("\n");

//     archive.append(Buffer.from(readableHeader + readableBody, "utf8"), {
//       name: "buchungen_readable.csv",
//     });

//     const TS = `${y}${m}${d}${String(ts.getHours()).padStart(2, "0")}${String(
//       ts.getMinutes(),
//     ).padStart(2, "0")}${String(ts.getSeconds()).padStart(2, "0")}000`;

//     const extfHead = `EXTF;700;21;Buchungsstapel;13;${TS};;${EXPORT_NAME};1;${CURRENCY}\n`;
//     const extfBody = extfRows.join("\n");

//     archive.append(Buffer.from(extfHead + extfBody, "utf8"), {
//       name: "buchungen_extf.csv",
//     });

//     await archive.finalize();

//     console.log("[DATEV/OPOS simple] stats", stats, "rows:", extfRows.length);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({
//       ok: false,
//       error: "Server error",
//       detail: String(err?.message || err),
//     });
//   }
// });

// module.exports = router;

// //routes / datev.js;
// ("use strict");

// const express = require("express");
// const mongoose = require("mongoose");
// const archiver = require("archiver");

// const Customer = require("../models/Customer");
// const Offer = require("../models/Offer");
// const BillingDocument = require("../models/BillingDocument");

// const router = express.Router();

// /* ===== Owner helpers ===== */
// function getProviderIdRaw(req) {
//   const v = req.get("x-provider-id");
//   return v ? String(v).trim() : null;
// }
// function getProviderObjectId(req) {
//   const raw = getProviderIdRaw(req);
//   if (!raw || !mongoose.isValidObjectId(raw)) return null;
//   return new mongoose.Types.ObjectId(raw);
// }
// function requireOwner(req, res) {
//   const owner = getProviderObjectId(req);
//   if (!owner) {
//     res
//       .status(401)
//       .json({ ok: false, error: "Unauthorized: invalid provider id" });
//     return null;
//   }
//   return owner;
// }

// /* ===== Helpers ===== */
// function parseISODate(d, endOfDay = false) {
//   if (!d) return null;
//   const iso = String(d).slice(0, 10);
//   const t = new Date(`${iso}T00:00:00`);
//   if (Number.isNaN(t.getTime())) return null;
//   if (endOfDay) t.setHours(23, 59, 59, 999);
//   return t;
// }
// function yyyymmdd(d) {
//   const dt = new Date(d);
//   if (Number.isNaN(dt.getTime())) return "";
//   const y = dt.getFullYear();
//   const m = String(dt.getMonth() + 1).padStart(2, "0");
//   const day = String(dt.getDate()).padStart(2, "0");
//   return `${y}${m}${day}`;
// }
// function fmtDE(n) {
//   const v = Number(n);
//   if (!Number.isFinite(v)) return "";
//   return (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
// }
// function isInside(date, from, to) {
//   if (!date) return false;
//   const dt = new Date(date);
//   if (Number.isNaN(dt.getTime())) return false;
//   if (from && dt < from) return false;
//   if (to && dt > to) return false;
//   return true;
// }
// function numGT0(v) {
//   const n = Number(v);
//   if (!Number.isFinite(n) || n <= 0) return null;
//   return n;
// }

// /* Kursname nur Name (ohne Adresse) */
// function courseOnly(raw = "") {
//   let s = String(raw || "").trim();
//   s = s.split(/\s*(?:[•|]|—|–)\s*/)[0];
//   const commaDigit = s.search(/,\s*\d/);
//   if (commaDigit > 0) s = s.slice(0, commaDigit);
//   const dashAddr = s.search(/\s-\s*\d/);
//   if (dashAddr > 0) s = s.slice(0, dashAddr);
//   return s.trim();
// }
// /* Buchungstext kurz/sauber */
// function cleanText(s = "") {
//   const raw = String(s || "")
//     .replace(/[;\r\n]+/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();
//   return raw.slice(0, 60);
// }

// /* Beträge bestimmen */
// function pickAmountInvoice(b, offer) {
//   const cand = [
//     b?.firstMonthAmount,
//     b?.monthlyAmount,
//     b?.priceAtBooking,
//     offer?.price,
//   ];
//   for (const v of cand) {
//     const n = Number(v);
//     if (Number.isFinite(n) && n > 0) return n;
//   }
//   return null;
// }
// function pickAmountStorno(b, offer) {
//   const cand = [b?.stornoAmount, b?.priceAtBooking, offer?.price];
//   for (const v of cand) {
//     const n = Number(v);
//     if (Number.isFinite(n) && n > 0) return n;
//   }
//   return null;
// }

// /* ===== Dunning helpers ===== */
// function safeStage(doc) {
//   const s = String(doc?.stage || "").trim();
//   return s || "reminder";
// }
// function dunningLink(doc) {
//   const id = String(doc?._id || "").trim();
//   if (!id) return "";
//   return `/api/admin/invoices/dunning-documents/${id}/download`;
// }
// function buildDunningBelegnummer(doc, suffix) {
//   const inv = String(doc?.invoiceNo || "").trim() || "NO-INVOICE";
//   const stage = safeStage(doc);
//   return `DUN-${inv}-${stage}-${suffix}`;
// }
// function buildDunningText(doc, label) {
//   const inv = String(doc?.invoiceNo || "").trim() || "NO-INVOICE";
//   const stage = safeStage(doc);
//   return cleanText(`${label} – ${inv} – ${stage}`);
// }
// function pushExtfRow(extfRows, row) {
//   extfRows.push(
//     [
//       row.Umsatz,
//       row.SH,
//       row.WKZ,
//       row.Konto,
//       row.Gegenkonto,
//       row.BU,
//       row.Belegdatum,
//       row.Belegnummer,
//       row.Buchungstext,
//       "",
//     ].join(";"),
//   );
// }
// function pushDunningFeeRows(args) {
//   const {
//     readable,
//     extfRows,
//     doc,
//     AR_ACCOUNT,
//     REV_ACCOUNT,
//     CURRENCY,
//     from,
//     to,
//   } = args;

//   const dt = doc?.sentAt || null;
//   if (!dt || !isInside(dt, from, to)) return 0;

//   const fees = doc?.feesSnapshot || {};
//   const items = [
//     { key: "returnBankFee", suffix: "RLS", label: "Rücklastschriftgebühr" },
//     { key: "dunningFee", suffix: "MAHN", label: "Mahngebühr" },
//     { key: "processingFee", suffix: "BEARB", label: "Bearbeitungsgebühr" },
//   ];

//   let pushed = 0;

//   for (const it of items) {
//     const amt = numGT0(fees?.[it.key]);
//     if (!amt) continue;

//     const row = {
//       Umsatz: fmtDE(amt),
//       SH: "S",
//       WKZ: CURRENCY,
//       Konto: AR_ACCOUNT,
//       Gegenkonto: REV_ACCOUNT,
//       BU: 0,
//       Belegdatum: yyyymmdd(dt),
//       Belegnummer: buildDunningBelegnummer(doc, it.suffix),
//       Buchungstext: buildDunningText(doc, it.label),
//       Beleglink: dunningLink(doc),
//     };

//     readable.push(row);
//     pushExtfRow(extfRows, row);
//     pushed++;
//   }

//   return pushed;
// }

// /* ===== OPOS Export (simple, wie „vorher“) =====
//    GET /api/admin/datev/export?from=YYYY-MM-DD&to=YYYY-MM-DD
// */
// router.get("/export", async (req, res) => {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const from = parseISODate(req.query.from, false);
//     const to = parseISODate(req.query.to, true);

//     const AR_ACCOUNT = Number(process.env.DATEV_AR_ACCOUNT || 10000);
//     const REV_ACCOUNT = Number(process.env.DATEV_REVENUE_ACCOUNT || 8195);
//     const CURRENCY = (process.env.DATEV_CURRENCY || "EUR").toUpperCase();
//     const EXPORT_NAME =
//       process.env.DATEV_EXPORT_NAME || "Münchner Fussball Schule NRW";

//     const customers = await Customer.find({ owner })
//       .select("_id userId parent child address bookings")
//       .lean();

//     const offerIds = [];
//     for (const c of customers) {
//       for (const b of c.bookings || []) {
//         for (const key of ["offerId", "offer_id", "offer", "offerRef"]) {
//           const v = b?.[key];
//           if (v && mongoose.isValidObjectId(String(v)))
//             offerIds.push(String(v));
//         }
//       }
//     }

//     const unique = [...new Set(offerIds)];
//     const offers = unique.length
//       ? await Offer.find({ _id: { $in: unique } })
//           .select("_id title type sub_type location price")
//           .lean()
//       : [];
//     const offerById = new Map(offers.map((o) => [String(o._id), o]));

//     const readable = [];
//     const extfRows = [];
//     const stats = {
//       invOk: 0,
//       invSkip: 0,
//       stOk: 0,
//       stSkip: 0,
//       dunDocs: 0,
//       dunDocsDedup: 0,
//       dunRows: 0,
//     };

//     for (const c of customers) {
//       for (const b of c.bookings || []) {
//         let off = null;
//         for (const key of ["offerId", "offer_id", "offer", "offerRef"]) {
//           const v = b?.[key];
//           if (v && mongoose.isValidObjectId(String(v))) {
//             off = offerById.get(String(v));
//             if (off) break;
//           }
//         }

//         const course = courseOnly(
//           b.offerTitle || b.offerType || off?.sub_type || off?.title || "Kurs",
//         );

//         const invNo = (b?.invoiceNumber || b?.invoiceNo || "")
//           .toString()
//           .trim();
//         const invDt = b?.invoiceDate || b?.date || b?.createdAt || null;
//         const invAmt = pickAmountInvoice(b, off);

//         if (
//           invNo &&
//           invDt &&
//           isInside(invDt, from, to) &&
//           Number.isFinite(invAmt) &&
//           invAmt > 0
//         ) {
//           const text = cleanText(`Teilnahme – ${course}`);
//           const rowReadable = {
//             Umsatz: fmtDE(invAmt),
//             SH: "S",
//             WKZ: CURRENCY,
//             Konto: AR_ACCOUNT,
//             Gegenkonto: REV_ACCOUNT,
//             BU: 0,
//             Belegdatum: yyyymmdd(invDt),
//             Belegnummer: invNo,
//             Buchungstext: text,
//             Beleglink: "",
//           };
//           readable.push(rowReadable);
//           pushExtfRow(extfRows, rowReadable);
//           stats.invOk++;
//         } else {
//           stats.invSkip++;
//         }

//         const stNo = (b?.stornoNo || b?.stornoNumber || "").toString().trim();
//         const stDt =
//           b?.stornoDate ||
//           b?.cancelDate ||
//           b?.cancellationDate ||
//           b?.invoiceDate ||
//           b?.date ||
//           b?.createdAt ||
//           null;
//         const stAmt = pickAmountStorno(b, off);

//         if (
//           stNo &&
//           stDt &&
//           isInside(stDt, from, to) &&
//           Number.isFinite(stAmt) &&
//           stAmt > 0
//         ) {
//           const text = cleanText(`Gutschrift – ${course}`);
//           const rowReadable = {
//             Umsatz: fmtDE(stAmt),
//             SH: "S",
//             WKZ: CURRENCY,
//             Konto: REV_ACCOUNT,
//             Gegenkonto: AR_ACCOUNT,
//             BU: 0,
//             Belegdatum: yyyymmdd(stDt),
//             Belegnummer: stNo,
//             Buchungstext: text,
//             Beleglink: "",
//           };
//           readable.push(rowReadable);
//           pushExtfRow(extfRows, rowReadable);
//           stats.stOk++;
//         } else {
//           stats.stSkip++;
//         }
//       }
//     }

//     // ===== Dunning documents:
//     // only export sent documents (sentAt set)
//     // dedup per invoiceNo+stage: keep the first created only
//     // const dunningDocsRaw = await BillingDocument.find({
//     //   owner: String(owner),
//     //   kind: "dunning",
//     //   sentAt: { $ne: null },
//     // })
//     //   .select("_id stage invoiceNo sentAt createdAt feesSnapshot")
//     //   .sort({ createdAt: 1 })
//     //   .lean();

//     // stats.dunDocs = dunningDocsRaw.length;

//     // const firstByKey = new Map();
//     // for (const doc of dunningDocsRaw) {
//     //   const inv = String(doc?.invoiceNo || "").trim() || "NO-INVOICE";
//     //   const stage = safeStage(doc);
//     //   const key = `${inv}__${stage}`;
//     //   if (firstByKey.has(key)) continue;
//     //   firstByKey.set(key, doc);
//     // }

//     // const dunningDocs = [...firstByKey.values()];
//     // stats.dunDocsDedup = dunningDocs.length;

//     // for (const doc of dunningDocs) {
//     //   const added = pushDunningFeeRows({
//     //     readable,
//     //     extfRows,
//     //     doc,
//     //     AR_ACCOUNT,
//     //     REV_ACCOUNT,
//     //     CURRENCY,
//     //     from,
//     //     to,
//     //   });
//     //   stats.dunRows += added;
//     // }

//     // ===== Dunning documents:
//     // Rules:
//     // - export fees only if sentAt set AND voidedAt == null
//     // - dedupe per invoiceNo+stage: keep the first created only
//     // - if already exported and later voided: export correction (storno) once
//     const batchId = `datev-${yyyymmdd(new Date())}-${Date.now()}`;

//     const dunningDocsRaw = await BillingDocument.find({
//       owner: String(owner),
//       kind: "dunning",
//       sentAt: { $ne: null },
//     })
//       .select(
//         "_id stage invoiceNo sentAt createdAt feesSnapshot voidedAt datevExportedAt datevVoidedExportedAt",
//       )
//       .sort({ createdAt: 1 })
//       .lean();

//     stats.dunDocs = dunningDocsRaw.length;

//     const firstByKey = new Map();
//     for (const doc of dunningDocsRaw) {
//       const inv = String(doc?.invoiceNo || "").trim() || "NO-INVOICE";
//       const stage = safeStage(doc);
//       const key = `${inv}__${stage}`;
//       if (firstByKey.has(key)) continue;
//       firstByKey.set(key, doc);
//     }

//     const dunningFirstDocs = [...firstByKey.values()];
//     stats.dunDocsDedup = dunningFirstDocs.length;

//     const exportedIds = [];
//     const voidedCorrectionIds = [];

//     function pushDunningFeeRowsWithMode({
//       readable,
//       extfRows,
//       doc,
//       AR_ACCOUNT,
//       REV_ACCOUNT,
//       CURRENCY,
//       from,
//       to,
//       mode,
//     }) {
//       const dt =
//         mode === "void-storno" ? doc?.voidedAt || null : doc?.sentAt || null;

//       if (!dt || !isInside(dt, from, to)) return 0;

//       const fees = doc?.feesSnapshot || {};
//       const items = [
//         { key: "returnBankFee", suffix: "RLS", label: "Rücklastschriftgebühr" },
//         { key: "dunningFee", suffix: "MAHN", label: "Mahngebühr" },
//         { key: "processingFee", suffix: "BEARB", label: "Bearbeitungsgebühr" },
//       ];

//       let pushed = 0;

//       for (const it of items) {
//         const amt = numGT0(fees?.[it.key]);
//         if (!amt) continue;

//         const belegSuffix =
//           mode === "void-storno" ? `${it.suffix}-STO` : it.suffix;
//         const belegLabel =
//           mode === "void-storno" ? `${it.label} (Storno)` : it.label;

//         const row = {
//           Umsatz: fmtDE(amt),
//           SH: mode === "void-storno" ? "H" : "S",
//           WKZ: CURRENCY,
//           Konto: AR_ACCOUNT,
//           Gegenkonto: REV_ACCOUNT,
//           BU: 0,
//           Belegdatum: yyyymmdd(dt),
//           Belegnummer: buildDunningBelegnummer(doc, belegSuffix),
//           Buchungstext: buildDunningText(doc, belegLabel),
//           Beleglink: dunningLink(doc),
//         };

//         readable.push(row);
//         pushExtfRow(extfRows, row);
//         pushed++;
//       }

//       return pushed;
//     }

//     // 1) Normal fees export (sentAt + not voided)
//     for (const doc of dunningFirstDocs) {
//       if (doc?.voidedAt) continue;

//       const added = pushDunningFeeRowsWithMode({
//         readable,
//         extfRows,
//         doc,
//         AR_ACCOUNT,
//         REV_ACCOUNT,
//         CURRENCY,
//         from,
//         to,
//         mode: "normal",
//       });

//       if (added > 0) exportedIds.push(String(doc._id));
//       stats.dunRows += added;
//     }

//     // 2) Void corrections (only once):
//     // If doc was exported previously (datevExportedAt set) and later voided,
//     // we export storno rows at voidedAt date and mark datevVoidedExportedAt.
//     for (const doc of dunningFirstDocs) {
//       if (!doc?.voidedAt) continue;
//       if (!doc?.datevExportedAt) continue;
//       if (doc?.datevVoidedExportedAt) continue;

//       const voidedAfterExport =
//         new Date(doc.voidedAt).getTime() >
//         new Date(doc.datevExportedAt).getTime();

//       if (!voidedAfterExport) continue;

//       const added = pushDunningFeeRowsWithMode({
//         readable,
//         extfRows,
//         doc,
//         AR_ACCOUNT,
//         REV_ACCOUNT,
//         CURRENCY,
//         from,
//         to,
//         mode: "void-storno",
//       });

//       if (added > 0) voidedCorrectionIds.push(String(doc._id));
//       stats.dunRows += added;
//     }

//     // Tracking update (best-effort, do not break export)
//     try {
//       const now = new Date();

//       if (exportedIds.length) {
//         await BillingDocument.updateMany(
//           {
//             _id: {
//               $in: exportedIds.map((x) => new mongoose.Types.ObjectId(x)),
//             },
//             datevExportedAt: null,
//             voidedAt: null,
//           },
//           { $set: { datevExportedAt: now, datevBatchId: batchId } },
//         );
//       }

//       if (voidedCorrectionIds.length) {
//         await BillingDocument.updateMany(
//           {
//             _id: {
//               $in: voidedCorrectionIds.map(
//                 (x) => new mongoose.Types.ObjectId(x),
//               ),
//             },
//             datevVoidedExportedAt: null,
//           },
//           { $set: { datevVoidedExportedAt: now, datevVoidedBatchId: batchId } },
//         );
//       }
//     } catch (e) {
//       console.error("[DATEV] tracking update failed:", e);
//     }

//     // ZIP streamen (ohne Belege/PDFs — wie vorher)
//     res.setHeader("Content-Type", "application/zip");
//     const ts = new Date();
//     const y = ts.getFullYear();
//     const m = String(ts.getMonth() + 1).padStart(2, "0");
//     const d = String(ts.getDate()).padStart(2, "0");
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="datev-export-${y}${m}${d}.zip"`,
//     );

//     const archive = archiver("zip", { zlib: { level: 3 } });
//     archive.on("error", () => {
//       try {
//         res.status(500).end();
//       } catch {}
//     });
//     archive.pipe(res);

//     const readableHeader =
//       "Umsatz;SH;WKZ;Konto;Gegenkonto;BU;Belegdatum;Belegnummer;Buchungstext;Beleglink\n";
//     const readableBody = readable
//       .map((r) =>
//         [
//           r.Umsatz,
//           r.SH,
//           r.WKZ,
//           r.Konto,
//           r.Gegenkonto,
//           r.BU,
//           r.Belegdatum,
//           r.Belegnummer,
//           r.Buchungstext,
//           r.Beleglink,
//         ].join(";"),
//       )
//       .join("\n");
//     archive.append(Buffer.from(readableHeader + readableBody, "utf8"), {
//       name: "buchungen_readable.csv",
//     });

//     const TS = `${y}${m}${d}${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(
//       ts.getSeconds(),
//     ).padStart(2, "0")}000`;
//     const extfHead = `EXTF;700;21;Buchungsstapel;13;${TS};;${EXPORT_NAME};1;${CURRENCY}\n`;
//     const extfBody = extfRows.join("\n");
//     archive.append(Buffer.from(extfHead + extfBody, "utf8"), {
//       name: "buchungen_extf.csv",
//     });

//     await archive.finalize();

//     console.log("[DATEV/OPOS simple] stats", stats, "rows:", extfRows.length);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({
//       ok: false,
//       error: "Server error",
//       detail: String(err?.message || err),
//     });
//   }
// });

// module.exports = router;
