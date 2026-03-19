// routes/customers/handlers/documents/participationPdf.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const Booking = require("../../../../models/Booking");

function offerLikeFromBooking(booking) {
  return {
    _id: String(booking?.offerId || booking?._id || "missing"),
    title: booking?.offerTitle || booking?.offerType || "Angebot",
    type: booking?.offerType || "Angebot",
    sub_type: "",
    location: booking?.venue || "",
    price: booking?.priceAtBooking,
  };
}

async function participationPdf(
  req,
  res,
  requireOwner,
  requireId,
  buildParticipationPdf,
) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const bid = String(req.params.bid || "").trim();
    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: "Invalid booking id" });
    }

    const customerDoc = await Customer.findOne({ _id: id, owner }).exec();
    if (!customerDoc) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const bookingRef = customerDoc.bookings.id(bid);
    if (!bookingRef) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const lookupId = bookingRef.bookingId || bookingRef._id;

    const bookingDoc = await Booking.findOne({ _id: lookupId, owner }).lean();
    if (!bookingDoc) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const offerDb = bookingDoc.offerId
      ? await Offer.findById(bookingDoc.offerId).lean()
      : bookingRef.offerId
        ? await Offer.findById(bookingRef.offerId).lean()
        : null;

    const offer = offerDb || offerLikeFromBooking(bookingDoc);

    bookingDoc.offerTitle =
      bookingDoc.offerTitle ||
      offer.title ||
      offer.sub_type ||
      offer.type ||
      "";
    bookingDoc.offerType =
      bookingDoc.offerType || offer.sub_type || offer.type || "";
    bookingDoc.venue = bookingDoc.venue || offer.location || "";

    const customer = customerDoc.toObject
      ? customerDoc.toObject()
      : customerDoc;

    const pdf = await buildParticipationPdf({
      customer,
      booking: bookingDoc,
      offer,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="Teilnahmebestaetigung.pdf"',
    );
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { participationPdf };

// // routes/customers/handlers/documents/participationPdf.js
// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const Offer = require("../../../../models/Offer");

// function offerLikeFromBooking(booking) {
//   return {
//     _id: String(booking?.offerId || booking?._id || "missing"),
//     title: booking?.offerTitle || booking?.offerType || "Angebot",
//     type: booking?.offerType || "Angebot",
//     sub_type: "",
//     location: booking?.venue || "",
//     price: booking?.priceAtBooking,
//   };
// }

// async function participationPdf(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   buildParticipationPdf,
// ) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;

//     const id = requireId(req, res);
//     if (!id) return;

//     const bid = String(req.params.bid || "").trim();
//     if (!mongoose.isValidObjectId(bid)) {
//       return res.status(400).json({ error: "Invalid booking id" });
//     }

//     const customer = await Customer.findOne({ _id: id, owner }).lean();
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const booking = (customer.bookings || []).find(
//       (b) => String(b._id) === bid,
//     );
//     if (!booking) return res.status(404).json({ error: "Booking not found" });

//     const offerDb = booking.offerId
//       ? await Offer.findById(booking.offerId).lean()
//       : null;
//     const offer = offerDb || offerLikeFromBooking(booking);

//     booking.offerTitle =
//       booking.offerTitle || offer.title || offer.sub_type || offer.type || "";
//     booking.offerType = booking.offerType || offer.sub_type || offer.type || "";
//     booking.venue = booking.venue || offer.location || "";

//     const pdf = await buildParticipationPdf({ customer, booking, offer });

//     res.setHeader("Content-Type", "application/pdf");
//     res.setHeader(
//       "Content-Disposition",
//       'inline; filename="Teilnahmebestaetigung.pdf"',
//     );
//     return res.status(200).send(pdf);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { participationPdf };
