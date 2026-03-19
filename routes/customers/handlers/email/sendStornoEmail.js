//routes\customers\handlers\email\sendStornoEmail.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const Booking = require("../../../../models/Booking");
const Offer = require("../../../../models/Offer");

function safeText(value) {
  return String(value ?? "").trim();
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function findCustomerBookingRef(customer, bid) {
  const bySubId = customer.bookings?.id ? customer.bookings.id(bid) : null;
  if (bySubId) return bySubId;
  const id = safeText(bid);
  return customer.bookings?.find((b) => safeText(b?.bookingId) === id) || null;
}

function isValidObjectId(value) {
  return mongoose.isValidObjectId(safeText(value));
}

function buildBookingSet(stornoNo, stornoDate, stornoAmount) {
  const set = { stornoNo, stornoDate };
  if (typeof stornoAmount === "number") set.stornoAmount = stornoAmount;
  return set;
}

function buildMailBooking(ref, bookingDoc) {
  const refObj = ref?.toObject ? ref.toObject() : { ...(ref || {}) };
  const docObj = bookingDoc?.toObject
    ? bookingDoc.toObject()
    : { ...(bookingDoc || {}) };

  return {
    ...refObj,
    ...docObj,
    _id: docObj?._id || refObj?._id || refObj?.bookingId,
    bookingId: docObj?._id || refObj?.bookingId || refObj?._id,
    offerId: docObj?.offerId || refObj?.offerId,
    offerTitle: docObj?.offerTitle || refObj?.offerTitle,
    offerType: docObj?.offerType || refObj?.offerType,
    venue: docObj?.venue || refObj?.venue,
    date: docObj?.date || refObj?.date,
    invoiceNo: docObj?.invoiceNo || refObj?.invoiceNo,
    invoiceNumber: docObj?.invoiceNumber || refObj?.invoiceNumber,
    invoiceDate: docObj?.invoiceDate || refObj?.invoiceDate,
    stornoNo: refObj?.stornoNo || docObj?.stornoNo,
    stornoDate: refObj?.stornoDate || docObj?.stornoDate,
    stornoAmount:
      typeof refObj?.stornoAmount === "number"
        ? refObj.stornoAmount
        : docObj?.stornoAmount,
    childUid: docObj?.childUid || refObj?.childUid,
    childFirstName: docObj?.childFirstName || refObj?.childFirstName,
    childLastName: docObj?.childLastName || refObj?.childLastName,
    childName:
      docObj?.childName ||
      refObj?.childName ||
      [
        docObj?.childFirstName || refObj?.childFirstName,
        docObj?.childLastName || refObj?.childLastName,
      ]
        .filter(Boolean)
        .join(" "),
  };
}

async function loadBookingDoc(owner, lookupId) {
  if (!isValidObjectId(lookupId)) return null;
  return Booking.findOne({ _id: lookupId, owner });
}

async function loadOffer(owner, offerId) {
  if (!isValidObjectId(offerId)) return null;
  return Offer.findOne({ _id: offerId, owner }).lean();
}

async function persistStornoToBooking(
  owner,
  lookupId,
  stornoNo,
  stornoDate,
  stornoAmount,
) {
  if (!isValidObjectId(lookupId)) return;
  const set = buildBookingSet(stornoNo, stornoDate, stornoAmount);
  await Booking.findOneAndUpdate(
    { _id: lookupId, owner },
    { $set: set },
    { new: true },
  );
}

async function sendStornoEmailHandler(
  req,
  res,
  requireOwner,
  requireId,
  formatStornoNo,
  buildStornoPdf,
  sendStornoEmail,
) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const bid = safeText(req.params.bid);
    if (!isValidObjectId(bid)) {
      return res.status(400).json({ ok: false, code: "INVALID_BOOKING_ID" });
    }

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) {
      return res.status(404).json({ ok: false, code: "CUSTOMER_NOT_FOUND" });
    }

    const ref = findCustomerBookingRef(customer, bid);
    if (!ref) {
      return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });
    }

    const lookupId = safeText(ref.bookingId || ref._id);
    const bookingDoc = await loadBookingDoc(owner, lookupId);

    const stornoDate = ref.stornoDate || new Date();
    const amount = toFiniteNumber(req.body?.amount);
    if (amount != null) ref.stornoAmount = amount;

    let stornoNo = safeText(ref.stornoNo);
    if (!stornoNo) {
      stornoNo = safeText(
        typeof formatStornoNo === "function" ? formatStornoNo() : "",
      );
      if (!stornoNo) {
        return res.status(500).json({ ok: false, code: "MISSING_STORNO_NO" });
      }
      ref.stornoNo = stornoNo;
    }

    ref.stornoDate = stornoDate;

    if (req.body?.note != null) {
      ref.stornoReason = safeText(req.body.note);
    }

    await customer.save();
    await persistStornoToBooking(
      owner,
      lookupId,
      stornoNo,
      stornoDate,
      ref.stornoAmount,
    );

    const booking = buildMailBooking(ref, bookingDoc);
    const offer = await loadOffer(owner, booking.offerId);
    const pdfBuffer = await buildStornoPdf({
      customer,
      booking,
      offer,
      amount:
        typeof booking.stornoAmount === "number" ? booking.stornoAmount : null,
      currency: safeText(booking.currency || "EUR") || "EUR",
      stornoNo,
      refInvoiceNo: booking.invoiceNo || booking.invoiceNumber || "",
      refInvoiceDate: booking.invoiceDate || null,
    });

    const to = safeText(customer?.parent?.email) || safeText(booking?.email);
    if (!to) {
      return res.status(400).json({ ok: false, code: "MISSING_RECIPIENT" });
    }

    await sendStornoEmail({
      to,
      customer: customer.toObject ? customer.toObject() : customer,
      booking,
      offer,
      pdfBuffer,
      amount:
        typeof booking.stornoAmount === "number" ? booking.stornoAmount : null,
      currency: safeText(booking.currency || "EUR") || "EUR",
    });

    return res.json({ ok: true, stornoNo });
  } catch (err) {
    console.error("sendStornoEmailHandler error:", err);

    if (err && err.name === "ValidationError") {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        message: safeText(err.message),
        errors: err.errors || {},
      });
    }

    return res.status(500).json({
      ok: false,
      code: "SERVER_ERROR",
      name: safeText(err?.name),
      message: safeText(err?.message),
    });
  }
}

module.exports = { sendStornoEmailHandler };

// //routes\customers\handlers\email\sendStornoEmail.js
// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const Booking = require("../../../../models/Booking");

// function safeText(value) {
//   return String(value ?? "").trim();
// }

// function toFiniteNumber(value) {
//   const n = Number(value);
//   return Number.isFinite(n) ? n : null;
// }

// function findCustomerBookingRef(customer, bid) {
//   const bySubId = customer.bookings?.id ? customer.bookings.id(bid) : null;
//   if (bySubId) return bySubId;
//   const id = safeText(bid);
//   return customer.bookings?.find((b) => safeText(b?.bookingId) === id) || null;
// }

// function isValidObjectId(value) {
//   return mongoose.isValidObjectId(safeText(value));
// }

// function buildBookingSet(stornoNo, stornoDate, stornoAmount) {
//   const set = { stornoNo, stornoDate };
//   if (typeof stornoAmount === "number") set.stornoAmount = stornoAmount;
//   return set;
// }

// async function loadBookingDoc(owner, lookupId) {
//   if (!isValidObjectId(lookupId)) return null;
//   return Booking.findOne({ _id: lookupId, owner }).lean();
// }

// async function persistStornoToBooking(
//   owner,
//   lookupId,
//   stornoNo,
//   stornoDate,
//   stornoAmount,
// ) {
//   if (!isValidObjectId(lookupId)) return;
//   const set = buildBookingSet(stornoNo, stornoDate, stornoAmount);
//   await Booking.findOneAndUpdate(
//     { _id: lookupId, owner },
//     { $set: set },
//     { new: true },
//   );
// }

// async function sendStornoEmailHandler(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   formatStornoNo,
//   buildStornoPdf,
//   sendStornoEmail,
// ) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const bid = safeText(req.params.bid);
//     if (!isValidObjectId(bid)) {
//       return res.status(400).json({ ok: false, code: "INVALID_BOOKING_ID" });
//     }

//     const customer = await Customer.findOne({ _id: id, owner });
//     if (!customer) {
//       return res.status(404).json({ ok: false, code: "CUSTOMER_NOT_FOUND" });
//     }

//     const ref = findCustomerBookingRef(customer, bid);
//     if (!ref) {
//       return res.status(404).json({ ok: false, code: "BOOKING_NOT_FOUND" });
//     }

//     const lookupId = safeText(ref.bookingId || ref._id);
//     const bookingDoc = await loadBookingDoc(owner, lookupId);

//     const stornoDate = ref.stornoDate || new Date();
//     const amount = toFiniteNumber(req.body?.amount);
//     if (amount != null) ref.stornoAmount = amount;

//     let stornoNo = safeText(ref.stornoNo);
//     if (!stornoNo) {
//       stornoNo = safeText(
//         typeof formatStornoNo === "function" ? formatStornoNo() : "",
//       );
//       if (!stornoNo) {
//         return res.status(500).json({ ok: false, code: "MISSING_STORNO_NO" });
//       }
//       ref.stornoNo = stornoNo;
//     }

//     ref.stornoDate = stornoDate;

//     if (req.body?.note != null) {
//       ref.stornoReason = safeText(req.body.note);
//     }

//     await customer.save();
//     await persistStornoToBooking(
//       owner,
//       lookupId,
//       stornoNo,
//       stornoDate,
//       ref.stornoAmount,
//     );

//     const pdfPayload = {
//       customer,
//       bookingRef: ref,
//       booking: bookingDoc || null,
//       stornoNo,
//       stornoDate,
//       stornoAmount:
//         typeof ref.stornoAmount === "number" ? ref.stornoAmount : null,
//     };

//     const pdf = await buildStornoPdf(pdfPayload);
//     await sendStornoEmail({
//       customer,
//       booking: bookingDoc,
//       bookingRef: ref,
//       pdf,
//     });

//     return res.json({ ok: true, stornoNo });
//   } catch (err) {
//     console.error("sendStornoEmailHandler error:", err);

//     if (err && err.name === "ValidationError") {
//       return res.status(400).json({
//         ok: false,
//         code: "VALIDATION_ERROR",
//         message: safeText(err.message),
//         errors: err.errors || {},
//       });
//     }

//     return res.status(500).json({
//       ok: false,
//       code: "SERVER_ERROR",
//       name: safeText(err?.name),
//       message: safeText(err?.message),
//     });
//   }
// }

// module.exports = { sendStornoEmailHandler };
