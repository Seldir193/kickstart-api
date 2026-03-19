// // routes/customers/handlers/documents/cancellationPdf.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const Booking = require("../../../../models/Booking");

async function cancellationPdf(
  req,
  res,
  requireOwner,
  requireId,
  typeCodeFromOffer,
  nextSequence,
  yearFrom,
  formatInvoiceShort,
  buildCancellationPdf,
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

    const offer = offerDb || null;

    const date = bookingRef.cancelDate || new Date();
    const reason = bookingRef.cancelReason || "";

    const endAt = req.body?.endDate
      ? new Date(req.body.endDate)
      : bookingRef.endDate || null;

    if (endAt && !bookingRef.endDate) {
      bookingRef.endDate = endAt;
      customerDoc.markModified("bookings");
      await customerDoc.save();
    }

    const refNo =
      String(bookingDoc?.invoiceNumber || bookingDoc?.invoiceNo || "").trim() ||
      String(bookingRef.invoiceNumber || bookingRef.invoiceNo || "").trim() ||
      "";

    const refDate = bookingDoc?.invoiceDate || bookingRef.invoiceDate || null;

    const customer = customerDoc.toObject
      ? customerDoc.toObject()
      : customerDoc;

    const pdf = await buildCancellationPdf({
      customer,
      booking: bookingRef,
      offer,
      endDate: endAt || bookingRef.endDate || null,
      date,
      reason,
      cancellationNo: bookingRef.cancellationNo || undefined,
      refInvoiceNo: refNo,
      refInvoiceDate: refDate,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="Kuendigungsbestaetigung.pdf"',
    );
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { cancellationPdf };

// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const Offer = require("../../../../models/Offer");

// async function cancellationPdf(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   typeCodeFromOffer,
//   nextSequence,
//   yearFrom,
//   formatInvoiceShort,
//   buildCancellationPdf,
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

//     const offer = booking.offerId
//       ? await Offer.findById(booking.offerId).lean()
//       : null;

//     const date = booking.cancelDate || new Date();
//     const reason = booking.cancelReason || "";

//     if (!booking.invoiceNumber && !booking.invoiceNo && offer) {
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

//     const endAt = req.body?.endDate
//       ? new Date(req.body.endDate)
//       : booking.endDate || null;

//     if (endAt && !booking.endDate) {
//       booking.endDate = endAt;
//     }

//     const referenceInvoice = {
//       number: booking.invoiceNumber || booking.invoiceNo || "",
//       date: booking.invoiceDate || null,
//     };

//     const pdf = await buildCancellationPdf({
//       customer,
//       booking,
//       offer,
//       endDate: endAt || booking.endDate || null,
//       date,
//       reason,
//       cancellationNo: booking.cancellationNo || undefined,
//       refInvoiceNo: referenceInvoice.number,
//       refInvoiceDate: referenceInvoice.date,
//     });

//     res.setHeader("Content-Type", "application/pdf");
//     res.setHeader(
//       "Content-Disposition",
//       'inline; filename="Kuendigungsbestaetigung.pdf"',
//     );
//     return res.status(200).send(pdf);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { cancellationPdf };
