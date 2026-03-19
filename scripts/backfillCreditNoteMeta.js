"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Customer = require("../models/Customer");
const { assignCreditNoteData } = require("../utils/billing");
const { normalizeInvoiceNo } = require("../utils/pdfData");

function pickMongoUri() {
  const uri =
    process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
  return String(uri || "").trim();
}

function safeText(v) {
  return String(v ?? "").trim();
}

function asNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isLegacyCreditNo(no) {
  const s = safeText(no);
  if (!s) return true;
  if (s.startsWith("GSCLB/")) return false;
  if (/^[a-f0-9]{24}\//i.test(s)) return true;
  if (s.includes("/GS")) return true;
  if (s.includes("GSCED") || s.includes("GSETA") || s.includes("GSKID"))
    return true;
  return true;
}

function findBookingRef(customer, bookingId) {
  const id = safeText(bookingId);
  const list = Array.isArray(customer?.bookings) ? customer.bookings : [];
  return list.find((b) => safeText(b?.bookingId) === id) || null;
}

function normalizeCandidates(noRaw) {
  const raw = safeText(noRaw);
  const dash = raw.replace(/\//g, "-");
  const pdf = safeText(normalizeInvoiceNo(raw));
  const out = new Set([raw, dash, pdf].filter(Boolean));
  return [...out];
}

function updateInvoiceRefs(ref, oldNos, newNo) {
  if (!ref) return { changed: 0, added: 0 };
  if (!Array.isArray(ref.invoiceRefs)) ref.invoiceRefs = [];

  let changed = 0;
  for (const r of ref.invoiceRefs) {
    const n = safeText(r?.number);
    if (!n) continue;
    if (oldNos.includes(n)) {
      r.number = newNo;
      changed += 1;
    }
  }

  const exists = ref.invoiceRefs.some((r) => safeText(r?.number) === newNo);
  if (exists) return { changed, added: 0 };

  const old = ref.invoiceRefs.find((r) => oldNos.includes(safeText(r?.number)));
  if (!old) return { changed, added: 0 };

  ref.invoiceRefs.push({
    number: newNo,
    date: old.date,
    amount: old.amount,
    finalPrice: old.finalPrice,
    note: old.note,
  });

  return { changed, added: 1 };
}

async function connectDb() {
  const uri = pickMongoUri();
  if (!uri) throw new Error("Missing MONGODB_URI / MONGO_URI");
  await mongoose.connect(uri);
}

async function loadOfferMaybe(booking) {
  try {
    const Offer = require("../models/Offer");
    const id = safeText(booking?.offerId);
    if (id && mongoose.isValidObjectId(id)) {
      const doc = await Offer.findById(id).lean();
      return doc || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function backfillOne(booking) {
  const meta =
    booking.meta && typeof booking.meta === "object" ? booking.meta : {};
  booking.meta = meta;

  const oldRaw = safeText(meta.creditNoteNo);
  if (!isLegacyCreditNo(oldRaw)) return { touched: false };

  const offer = await loadOfferMaybe(booking);

  const amount =
    asNumber(meta.creditNoteAmount, null) ??
    asNumber(booking.priceAtBooking, 0) ??
    0;

  const creditDate = meta.creditNoteDate
    ? new Date(meta.creditNoteDate)
    : new Date();

  const beforeNos = normalizeCandidates(oldRaw);

  await assignCreditNoteData({
    booking,
    offer,
    amount,
    providerId: "1",
    creditDate,
  });

  const newNo = safeText(booking?.meta?.creditNoteNo);
  if (!newNo) return { touched: false };

  booking.markModified("meta");
  await booking.save();

  const owner = safeText(booking.owner);
  const cid = safeText(booking.customerId);

  let customer = null;
  if (cid && mongoose.isValidObjectId(cid)) {
    customer = await Customer.findOne({ _id: cid, owner });
  }
  if (!customer) {
    customer = await Customer.findOne({
      owner,
      "bookings.bookingId": booking._id,
    });
  }
  if (!customer) return { touched: true, newNo, customerUpdated: false };

  const ref = findBookingRef(customer, booking._id);
  if (!ref) return { touched: true, newNo, customerUpdated: false };

  const upd = updateInvoiceRefs(ref, beforeNos, newNo);

  if (upd.changed > 0 || upd.added > 0) {
    customer.markModified("bookings");
    await customer.save();
    return { touched: true, newNo, customerUpdated: true, ...upd };
  }

  return { touched: true, newNo, customerUpdated: false };
}

async function run() {
  await connectDb();

  const q = {
    paymentStatus: "returned",
    "meta.stripeRefundId": { $exists: true, $ne: "" },
    $or: [
      { "meta.creditNoteNo": { $exists: false } },
      { "meta.creditNoteNo": "" },
      { "meta.creditNoteNo": { $regex: /^[a-f0-9]{24}\//i } },
      { "meta.creditNoteNo": { $regex: /\/GS/i } },
    ],
  };

  const list = await Booking.find(q).limit(5000);

  let touched = 0;
  let customerUpdated = 0;
  let changedRefs = 0;
  let addedRefs = 0;

  for (const booking of list) {
    const r = await backfillOne(booking);
    if (!r.touched) continue;
    touched += 1;

    if (r.customerUpdated) customerUpdated += 1;
    if (r.changed) changedRefs += r.changed;
    if (r.added) addedRefs += r.added;
  }

  console.log("Backfill done:", {
    found: list.length,
    touched,
    customerUpdated,
    changedRefs,
    addedRefs,
  });

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

// "use strict";

// require("dotenv").config();

// const mongoose = require("mongoose");
// const Booking = require("../models/Booking");
// const { assignCreditNoteData } = require("../utils/billing");

// function pickMongoUri() {
//   const uri =
//     process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
//   return String(uri || "").trim();
// }

// function cleanStr(v) {
//   return String(v || "").trim();
// }

// function asNumber(v, fallback = 0) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// async function connectDb() {
//   const uri = pickMongoUri();
//   if (!uri) throw new Error("Missing MONGODB_URI / MONGO_URI");
//   await mongoose.connect(uri);
// }

// function buildQuery() {
//   return {
//     paymentStatus: "returned",
//     "meta.stripeRefundId": { $exists: true, $ne: "" },
//     $or: [
//       { "meta.creditNoteNo": { $exists: false } },
//       { "meta.creditNoteNo": "" },
//       { "meta.creditNoteDate": { $exists: false } },
//       { "meta.creditNoteDate": "" },
//     ],
//   };
// }

// function ensureMetaObject(booking) {
//   booking.meta =
//     booking.meta && typeof booking.meta === "object" ? booking.meta : {};
//   return booking.meta;
// }

// function tryLoadOfferModel() {
//   try {
//     return require("../models/Offer");
//   } catch (_) {
//     return null;
//   }
// }

// async function loadOfferById(Offer, offerId) {
//   if (!Offer) return null;
//   const id = String(offerId || "").trim();
//   if (!id || !mongoose.isValidObjectId(id)) return null;
//   return Offer.findById(id).lean();
// }

// async function backfillOne(booking, Offer) {
//   if (!booking) return false;

//   const meta = ensureMetaObject(booking);

//   const hasNo = cleanStr(meta.creditNoteNo);
//   const hasDate = cleanStr(meta.creditNoteDate);

//   if (!hasNo || !hasDate) {
//     const offer = await loadOfferById(Offer, booking.offerId);
//     const providerId = cleanStr(booking.owner) || "1";

//     await assignCreditNoteData({
//       booking,
//       offer,
//       amount: asNumber(meta.creditNoteAmount, null),
//       providerId,
//     });
//   }

//   if (meta.creditNoteAmount == null) {
//     meta.creditNoteAmount = asNumber(booking.priceAtBooking, 0);
//   }

//   booking.markModified("meta");
//   await booking.save();
//   return true;
// }

// async function run() {
//   await connectDb();

//   const Offer = tryLoadOfferModel();

//   const q = buildQuery();
//   const list = await Booking.find(q).limit(5000);

//   let updated = 0;
//   for (const booking of list) {
//     const ok = await backfillOne(booking, Offer);
//     if (ok) updated += 1;
//   }

//   console.log("Backfill done:", { found: list.length, updated });
//   await mongoose.disconnect();
// }

// run().catch((e) => {
//   console.error(e);
//   process.exit(1);
// });
