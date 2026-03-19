const Customer = require("../../../models/Customer");
const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");

const { buildParticipationPdf } = require("../../../utils/pdf");

const { requireOwner } = require("../helpers/provider");
const { requireIds } = require("../helpers/ids");
const { resolveAmountsFromBookingRef } = require("../helpers/amounts");

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
    _id: main?._id || ref?._id || ref?.bookingId,
    bookingId: main?._id || ref?.bookingId || ref?._id,
    offerId: main?.offerId || ref?.offerId,
    offerTitle: main?.offerTitle || ref?.offerTitle,
    offerType: main?.offerType || ref?.offerType,
    venue: main?.venue || ref?.venue,
    date: main?.date || ref?.date,
    createdAt: main?.createdAt || ref?.createdAt,
    invoiceNo: main?.invoiceNo || ref?.invoiceNo,
    invoiceNumber: main?.invoiceNumber || ref?.invoiceNumber,
    invoiceDate: main?.invoiceDate || ref?.invoiceDate,
    priceAtBooking:
      typeof main?.priceAtBooking === "number"
        ? main.priceAtBooking
        : ref?.priceAtBooking,
    priceMonthly:
      typeof main?.priceMonthly === "number"
        ? main.priceMonthly
        : ref?.priceMonthly,
    priceFirstMonth:
      typeof main?.priceFirstMonth === "number"
        ? main.priceFirstMonth
        : ref?.priceFirstMonth,
    monthlyAmount:
      typeof main?.monthlyAmount === "number"
        ? main.monthlyAmount
        : ref?.monthlyAmount,
    firstMonthAmount:
      typeof main?.firstMonthAmount === "number"
        ? main.firstMonthAmount
        : ref?.firstMonthAmount,
    currency: main?.currency || ref?.currency,
    childUid: main?.childUid || ref?.childUid,
    childFirstName: main?.childFirstName || ref?.childFirstName,
    childLastName: main?.childLastName || ref?.childLastName,
    childName: main?.childName || ref?.childName,
    invoiceRefs: Array.isArray(main?.invoiceRefs)
      ? main.invoiceRefs
      : Array.isArray(ref?.invoiceRefs)
        ? ref.invoiceRefs
        : [],
    meta:
      main?.meta && typeof main.meta === "object"
        ? main.meta
        : ref?.meta && typeof ref.meta === "object"
          ? ref.meta
          : {},
  };
}

async function participationPdfAction(req, res) {
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
      owner,
    });

    const booking = mergeBookingData(customerBooking, primaryBooking);

    const offer = booking.offerId
      ? await Offer.findById(booking.offerId).lean()
      : null;

    const resolved = await resolveAmountsFromBookingRef(booking);
    const currency = String(resolved?.currency || booking.currency || "EUR");

    const monthly =
      resolved?.priceMonthly != null
        ? Number(resolved.priceMonthly)
        : undefined;

    const firstMonth =
      resolved?.priceFirstMonth != null
        ? Number(resolved.priceFirstMonth)
        : undefined;

    const invoiceNo = booking.invoiceNo || booking.invoiceNumber || "";
    const invoiceDate = booking.invoiceDate || null;

    const buf = await buildParticipationPdf({
      customer: customer.toObject ? customer.toObject() : customer,
      booking,
      offer,
      invoiceNo,
      invoiceDate,
      monthlyAmount: monthly,
      firstMonthAmount: firstMonth,
      venue: booking.venue || booking.location || "",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="participation-${ids.bid}.pdf"`,
    );

    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("[participation.pdf] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { participationPdfAction };

// //routes\bookingActions\handlers\participationPdfAction.js
// const Customer = require("../../../models/Customer");
// const Offer = require("../../../models/Offer");

// const { prorateForStart } = require("../../../utils/billing");

// const { buildParticipationPdfHTML } = require("../../../utils/pdfHtml");

// const { requireOwner } = require("../helpers/provider");
// const { requireIds } = require("../helpers/ids");
// const { resolveAmountsFromBookingRef } = require("../helpers/amounts");

// async function participationPdfAction(req, res) {
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

//     const toMoney = (v) => {
//       const n = typeof v === "string" ? Number(v) : v;
//       return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
//     };

//     const pickMoney = (...vals) => {
//       for (const v of vals) {
//         const n = toMoney(v);
//         if (n != null) return n;
//       }
//       return null;
//     };

//     const startISO = booking.date
//       ? new Date(booking.date).toISOString().slice(0, 10)
//       : null;

//     const invNo = booking.invoiceNo || booking.invoiceNumber || "";

//     const refs = Array.isArray(booking.invoiceRefs) ? booking.invoiceRefs : [];
//     const ref =
//       (invNo
//         ? refs.find(
//             (r) => String(r?.number || "").trim() === String(invNo).trim(),
//           )
//         : null) || (refs.length ? refs[refs.length - 1] : null);

//     const resolved = await resolveAmountsFromBookingRef(booking);
//     const currency = String(resolved?.currency || booking.currency || "EUR");

//     const monthly = pickMoney(
//       booking.priceMonthly,
//       booking.monthlyAmount,
//       booking.monthly,
//       ref?.monthly,
//       ref?.monthlyAmount,
//       ref?.priceMonthly,
//       resolved?.priceMonthly,
//     );

//     let firstMonth = pickMoney(
//       booking.priceFirstMonth,
//       booking.firstMonthAmount,
//       booking.firstMonth,
//       ref?.firstMonth,
//       ref?.firstMonthAmount,
//       ref?.priceFirstMonth,
//       resolved?.priceFirstMonth,
//     );

//     if (firstMonth == null && startISO && monthly != null) {
//       const pr = prorateForStart(startISO, monthly);
//       firstMonth = toMoney(pr?.firstMonthPrice) || null;
//     }

//     const singleAmount = pickMoney(
//       booking.priceAtBooking,
//       ref?.single,
//       ref?.oneOff,
//       ref?.amount,
//       monthly,
//     );

//     const buf = await buildParticipationPdfHTML({
//       customer: customer.toObject ? customer.toObject() : customer,
//       booking: booking.toObject ? booking.toObject() : booking,
//       offer,
//       venue: booking.venue || booking.location,

//       invoiceNo: invNo,
//       invoiceDate: booking.invoiceDate,

//       monthlyAmount: monthly != null ? monthly : undefined,
//       firstMonthAmount: firstMonth != null ? firstMonth : undefined,

//       pricing: {
//         currency,
//         monthly: monthly != null ? monthly : null,
//         firstMonth: firstMonth != null ? firstMonth : null,
//         single: singleAmount,
//       },
//       invoice: {
//         number: invNo || "",
//         date: booking.invoiceDate || null,
//         currency,
//         monthly: monthly != null ? monthly : null,
//         firstMonth: firstMonth != null ? firstMonth : null,
//         single: singleAmount,
//       },
//     });

//     res.setHeader("Content-Type", "application/pdf");
//     res.setHeader(
//       "Content-Disposition",
//       `inline; filename="participation-${ids.bid}.pdf"`,
//     );
//     return res.status(200).send(Buffer.from(buf));
//   } catch (err) {
//     console.error("[participation.pdf] error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { participationPdfAction };
