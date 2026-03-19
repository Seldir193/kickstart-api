const Customer = require("../../../models/Customer");
const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");

const { buildCancellationPdfHTML } = require("../../../utils/pdfHtml");

const { requireOwner } = require("../helpers/provider");
const { requireIds } = require("../helpers/ids");

function mergeBookingData(customerBooking, primaryBooking) {
  const ref = customerBooking?.toObject
    ? customerBooking.toObject()
    : { ...(customerBooking || {}) };

  const main = primaryBooking?.toObject
    ? primaryBooking.toObject()
    : { ...(primaryBooking || {}) };

  return {
    ...ref,
    ...main,
    _id: main?._id || ref?._id,
    offerId: main?.offerId || ref?.offerId,
    offerTitle: main?.offerTitle || ref?.offerTitle,
    offerType: main?.offerType || ref?.offerType,
    venue: main?.venue || ref?.venue,
    date: main?.date || ref?.date,
    cancelDate: main?.cancelDate || ref?.cancelDate,
    cancellationDate: main?.cancellationDate || ref?.cancellationDate,
    endDate: main?.endDate || ref?.endDate,
    cancelReason: main?.cancelReason || ref?.cancelReason,
    cancellationReason: main?.cancellationReason || ref?.cancellationReason,
    cancellationNo:
      main?.cancellationNo ||
      main?.cancellationNumber ||
      ref?.cancellationNo ||
      ref?.cancellationNumber,
    invoiceNo: main?.invoiceNo || ref?.invoiceNo,
    invoiceNumber: main?.invoiceNumber || ref?.invoiceNumber,
    invoiceDate: main?.invoiceDate || ref?.invoiceDate,
    childFirstName: main?.childFirstName || ref?.childFirstName,
    childLastName: main?.childLastName || ref?.childLastName,
    childName: main?.childName || ref?.childName,
    childUid: main?.childUid || ref?.childUid,
  };
}

async function cancellationPdfAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const ids = requireIds(req, res);
    if (!ids) return;

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const customerBooking = customer.bookings.id(ids.bid);
    if (!customerBooking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const primaryBooking = await Booking.findOne({
      _id: ids.bid,
      customerId: customer._id,
    });

    const booking = mergeBookingData(customerBooking, primaryBooking);

    const offer = booking.offerId
      ? await Offer.findById(booking.offerId).lean()
      : null;

    const date = req.query.date
      ? new Date(String(req.query.date))
      : booking.cancelDate || booking.cancellationDate || null;

    const requestDate = req.query.requestDate
      ? new Date(String(req.query.requestDate))
      : booking.cancelDate || booking.cancellationDate || null;

    const endDate = req.query.endDate
      ? new Date(String(req.query.endDate))
      : booking.endDate || null;

    const reason = req.query.reason
      ? String(req.query.reason)
      : booking.cancelReason || booking.cancellationReason || "";

    // console.log("[cancellationPdfAction] admin pdf input", {
    //   bookingId: String(booking?._id || ""),
    //   cancelDate: booking?.cancelDate,
    //   cancellationDate: booking?.cancellationDate,
    //   endDate: booking?.endDate,
    //   requestDate: req.query.requestDate || null,
    //   primaryBookingFound: Boolean(primaryBooking),
    // });

    const buf = await buildCancellationPdfHTML({
      customer: customer.toObject ? customer.toObject() : customer,
      booking,
      offer,
      date,
      requestDate,
      endDate,
      reason,
      cancellationNo: booking.cancellationNo || booking.cancellationNumber,
      referenceInvoice:
        booking.invoiceNo || booking.invoiceNumber
          ? {
              number: booking.invoiceNo || booking.invoiceNumber,
              date: booking.invoiceDate || null,
            }
          : undefined,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="cancellation-${ids.bid}.pdf"`,
    );

    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("[cancellation.pdf] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { cancellationPdfAction };
// //routes\bookingActions\handlers\cancellationPdfAction.js
// const Customer = require("../../../models/Customer");
// const Offer = require("../../../models/Offer");

// const { buildCancellationPdfHTML } = require("../../../utils/pdfHtml");

// const { requireOwner } = require("../helpers/provider");
// const { requireIds } = require("../helpers/ids");

// async function cancellationPdfAction(req, res) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;
//     const ids = requireIds(req, res);
//     if (!ids) return;

//     const customer = await Customer.findOne({ _id: ids.cid, owner });
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const booking = customer.bookings.id(ids.bid);
//     if (!booking) return res.status(404).json({ error: "Booking not found" });

//     const offer = booking.offerId
//       ? await Offer.findById(booking.offerId).lean()
//       : null;

//     const date = req.query.date
//       ? new Date(String(req.query.date))
//       : booking.cancelDate || booking.cancellationDate;
//     const reason = req.query.reason
//       ? String(req.query.reason)
//       : booking.cancelReason || "";

//     const buf = await buildCancellationPdfHTML({
//       customer: customer.toObject ? customer.toObject() : customer,
//       booking: booking.toObject ? booking.toObject() : booking,
//       offer,
//       date,
//       reason,
//       cancellationNo: booking.cancellationNo || booking.cancellationNumber,
//       referenceInvoice:
//         booking.invoiceNo || booking.invoiceNumber
//           ? {
//               number: booking.invoiceNo || booking.invoiceNumber,
//               date: booking.invoiceDate || null,
//             }
//           : undefined,
//     });

//     res.setHeader("Content-Type", "application/pdf");
//     res.setHeader(
//       "Content-Disposition",
//       `inline; filename="cancellation-${ids.bid}.pdf"`,
//     );
//     return res.status(200).send(Buffer.from(buf));
//   } catch (err) {
//     console.error("[cancellation.pdf] error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { cancellationPdfAction };
