// // routes/customers/handlers/documents/stornoPdf.js
// routes/customers/handlers/documents/stornoPdf.js
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

async function stornoPdf(
  req,
  res,
  requireOwner,
  requireId,
  typeCodeFromOffer,
  nextSequence,
  yearFrom,
  formatInvoiceShort,
  buildStornoPdf,
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

    const { currency = "EUR" } = req.body || {};
    const rawAmount = req.body?.amount;

    const amountNum =
      rawAmount === undefined ||
      rawAmount === null ||
      String(rawAmount).trim() === ""
        ? undefined
        : Number.isFinite(Number(rawAmount))
          ? Number(rawAmount)
          : undefined;

    const customerDoc = await Customer.findOne({ _id: id, owner }).exec();
    if (!customerDoc) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const bookingRef =
      customerDoc.bookings.id(bid) ||
      customerDoc.bookings.find((b) => String(b?._id) === bid);

    if (!bookingRef) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const lookupId = bookingRef.bookingId || bookingRef._id;

    const bookingDoc = await Booking.findOne({ _id: lookupId, owner }).lean();

    const offerDb = bookingRef.offerId
      ? await Offer.findById(bookingRef.offerId).lean()
      : bookingDoc?.offerId
        ? await Offer.findById(bookingDoc.offerId).lean()
        : null;

    const offer = offerDb || offerLikeFromBooking(bookingDoc || bookingRef);

    const docRefNo = String(
      bookingDoc?.invoiceNumber || bookingDoc?.invoiceNo || "",
    ).trim();

    const refNo =
      docRefNo ||
      String(bookingRef.invoiceNumber || bookingRef.invoiceNo || "").trim() ||
      "";

    const refDate = bookingDoc?.invoiceDate || bookingRef.invoiceDate || null;

    if (!refNo) {
      const code = (
        offer.code ||
        typeCodeFromOffer(offer) ||
        "INV"
      ).toUpperCase();
      const seq = await nextSequence(
        `invoice:${code}:${yearFrom((bookingDoc && bookingDoc.date) || bookingRef.date || new Date())}`,
      );
      const when =
        (bookingDoc && bookingDoc.date) || bookingRef.date || new Date();
      const tmpNo = formatInvoiceShort(code, seq, when);
      const tmpDate = when instanceof Date ? when : new Date(when);
      const customer = customerDoc.toObject
        ? customerDoc.toObject()
        : customerDoc;

      const pdf = await buildStornoPdf({
        customer,
        booking: bookingRef,
        offer,
        amount: amountNum,
        currency,
        stornoNo: bookingRef.stornoNo || undefined,
        refInvoiceNo: tmpNo,
        refInvoiceDate: tmpDate,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'inline; filename="Storno-Rechnung.pdf"',
      );
      return res.status(200).send(pdf);
    }

    const customer = customerDoc.toObject
      ? customerDoc.toObject()
      : customerDoc;

    const pdf = await buildStornoPdf({
      customer,
      booking: bookingRef,
      offer,
      amount: amountNum,
      currency,
      stornoNo: bookingRef.stornoNo || undefined,
      refInvoiceNo: refNo,
      refInvoiceDate: refDate,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="Storno-Rechnung.pdf"',
    );
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { stornoPdf };

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

// async function stornoPdf(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   typeCodeFromOffer,
//   nextSequence,
//   yearFrom,
//   formatInvoiceShort,
//   buildStornoPdf,
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

//     const { currency = "EUR" } = req.body || {};
//     const rawAmount = req.body?.amount;

//     const amountNum =
//       rawAmount === undefined ||
//       rawAmount === null ||
//       String(rawAmount).trim() === ""
//         ? undefined
//         : Number.isFinite(Number(rawAmount))
//           ? Number(rawAmount)
//           : undefined;

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

//     if (!booking.invoiceNumber && !booking.invoiceNo) {
//       const code = (
//         offer.code ||
//         typeCodeFromOffer(offer) ||
//         "INV"
//       ).toUpperCase();
//       const seq = await nextSequence(
//         `invoice:${code}:${yearFrom(booking.date || new Date())}`,
//       );
//       booking.invoiceNumber = formatInvoiceShort(
//         code,
//         seq,
//         booking.date || new Date(),
//       );
//       booking.invoiceDate = booking.date || new Date();
//     }

//     const referenceInvoice = {
//       number: booking.invoiceNumber || booking.invoiceNo || "",
//       date: booking.invoiceDate || null,
//     };

//     const pdf = await buildStornoPdf({
//       customer,
//       booking,
//       offer,
//       amount: amountNum,
//       currency,
//       stornoNo: booking.stornoNo || undefined,
//       refInvoiceNo: referenceInvoice.number,
//       refInvoiceDate: referenceInvoice.date,
//     });

//     res.setHeader("Content-Type", "application/pdf");
//     res.setHeader(
//       "Content-Disposition",
//       'inline; filename="Storno-Rechnung.pdf"',
//     );
//     return res.status(200).send(pdf);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { stornoPdf };
