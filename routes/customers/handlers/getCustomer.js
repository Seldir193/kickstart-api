"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../models/Customer");
const Booking = require("../../../models/Booking");

function safeText(v) {
  return String(v ?? "").trim();
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function bookingIdOf(ref) {
  return safeText(ref?.bookingId || ref?._id);
}

async function loadBookingMetaMap(owner, bookingRefs) {
  const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
    .map((b) => bookingIdOf(b))
    .filter((v) => v && mongoose.isValidObjectId(v));

  if (!bookingIds.length) return new Map();

  const docs = await Booking.find(
    { _id: { $in: bookingIds }, owner: String(owner) },
    {
      "invoiceTo.parent.email": 1,
      "invoiceTo.parent.firstName": 1,
      "invoiceTo.parent.lastName": 1,
      invoiceNo: 1,
      invoiceNumber: 1,
      invoiceDate: 1,
    },
  ).lean();

  return new Map(
    docs.map((d) => [
      String(d._id),
      {
        parentEmail: safeLower(d?.invoiceTo?.parent?.email),
        parentFirstName: safeText(d?.invoiceTo?.parent?.firstName),
        parentLastName: safeText(d?.invoiceTo?.parent?.lastName),
        invoiceNo: safeText(d?.invoiceNo),
        invoiceNumber: safeText(d?.invoiceNumber),
        invoiceDate: d?.invoiceDate || null,
      },
    ]),
  );
}

function attachBookingMeta(doc, metaMap) {
  const refs = Array.isArray(doc?.bookings) ? doc.bookings : [];

  return refs.map((ref) => {
    const meta = metaMap.get(bookingIdOf(ref)) || {};

    return {
      ...ref,
      parentEmail: safeLower(ref?.parentEmail || meta.parentEmail),
      parentFirstName: safeText(ref?.parentFirstName || meta.parentFirstName),
      parentLastName: safeText(ref?.parentLastName || meta.parentLastName),
      invoiceNo: safeText(ref?.invoiceNo || meta.invoiceNo),
      invoiceNumber: safeText(ref?.invoiceNumber || meta.invoiceNumber),
      invoiceDate: ref?.invoiceDate || meta.invoiceDate || null,
    };
  });
}

async function getCustomer(req, res, requireOwner, requireId) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const doc = await Customer.findOne({ _id: id, owner }).lean();
    if (!doc) return res.status(404).json({ error: "Customer not found" });

    const metaMap = await loadBookingMetaMap(owner, doc.bookings || []);
    const enriched = {
      ...doc,
      bookings: attachBookingMeta(doc, metaMap),
    };

    res.json(enriched);
  } catch {
    res.status(400).json({ error: "Invalid customer id" });
  }
}

module.exports = { getCustomer };

// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../models/Customer");
// const Booking = require("../../../models/Booking");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function safeLower(v) {
//   return safeText(v).toLowerCase();
// }

// function bookingIdOf(ref) {
//   return safeText(ref?.bookingId || ref?._id);
// }

// async function loadBookingParentMap(owner, bookingRefs) {
//   const bookingIds = (Array.isArray(bookingRefs) ? bookingRefs : [])
//     .map((b) => bookingIdOf(b))
//     .filter((v) => v && mongoose.isValidObjectId(v));

//   if (!bookingIds.length) return new Map();

//   const docs = await Booking.find(
//     { _id: { $in: bookingIds }, owner: String(owner) },
//     {
//       "invoiceTo.parent.email": 1,
//       "invoiceTo.parent.firstName": 1,
//       "invoiceTo.parent.lastName": 1,
//     },
//   ).lean();

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

// function attachParentMetaToBookings(doc, parentMap) {
//   const refs = Array.isArray(doc?.bookings) ? doc.bookings : [];

//   return refs.map((ref) => {
//     const meta = parentMap.get(bookingIdOf(ref)) || {};

//     return {
//       ...ref,
//       parentEmail: safeLower(ref?.parentEmail || meta.parentEmail),
//       parentFirstName: safeText(ref?.parentFirstName || meta.parentFirstName),
//       parentLastName: safeText(ref?.parentLastName || meta.parentLastName),
//     };
//   });
// }

// async function getCustomer(req, res, requireOwner, requireId) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const doc = await Customer.findOne({ _id: id, owner }).lean();
//     if (!doc) return res.status(404).json({ error: "Customer not found" });

//     const parentMap = await loadBookingParentMap(owner, doc.bookings || []);
//     const enriched = {
//       ...doc,
//       bookings: attachParentMetaToBookings(doc, parentMap),
//     };

//     res.json(enriched);
//   } catch {
//     res.status(400).json({ error: "Invalid customer id" });
//   }
// }

// module.exports = { getCustomer };

// //routes\customers\handlers\getCustomer.js
// "use strict";

// const Customer = require("../../../models/Customer");

// async function getCustomer(req, res, requireOwner, requireId) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const doc = await Customer.findOne({ _id: id, owner }).lean();
//     if (!doc) return res.status(404).json({ error: "Customer not found" });

//     res.json(doc);
//   } catch {
//     res.status(400).json({ error: "Invalid customer id" });
//   }
// }

// module.exports = { getCustomer };
