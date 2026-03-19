// // routes/customers/handlers/email/sendConfirmationEmail.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const Booking = require("../../../../models/Booking");

function offerLikeFromBooking(booking) {
  const v = String(booking?.offerType || "").trim();
  const isPersonalSubtype = /^Einzeltraining_/i.test(v);
  const isPower = /^Powertraining$/i.test(v);

  if (isPower) {
    return {
      _id: String(booking?.offerId || booking?._id || "missing"),
      type: "Camp",
      sub_type: "Powertraining",
      category: "Holiday",
      title: booking?.offerTitle || "Power Training",
      location: booking?.venue || "",
      price: booking?.priceAtBooking,
    };
  }

  if (isPersonalSubtype) {
    return {
      _id: String(booking?.offerId || booking?._id || "missing"),
      type: "PersonalTraining",
      sub_type: v,
      category: "Individual",
      title: booking?.offerTitle || v,
      location: booking?.venue || "",
      price: booking?.priceAtBooking,
    };
  }

  return {
    _id: String(booking?.offerId || booking?._id || "missing"),
    type: v || "Angebot",
    sub_type: "",
    category: booking?.offerCategory,
    title: booking?.offerTitle || v || "Angebot",
    location: booking?.venue || "",
    price: booking?.priceAtBooking,
  };
}

function bookingEmailOf(booking, customer) {
  const bookingParentEmail = safeText(booking?.invoiceTo?.parent?.email);
  const bookingEmail = safeText(booking?.email);
  const customerParentEmail = safeText(customer?.parent?.email);
  const customerEmail = safeText(customer?.email);

  return (
    bookingParentEmail ||
    bookingEmail ||
    customerParentEmail ||
    customerEmail
  ).toLowerCase();
}

function bookingParentSnapshot(booking, customer) {
  const bookingParent = booking?.invoiceTo?.parent || {};
  const customerParent = customer?.parent || {};

  return {
    salutation: safeText(bookingParent.salutation || customerParent.salutation),
    firstName: safeText(bookingParent.firstName || customerParent.firstName),
    lastName: safeText(bookingParent.lastName || customerParent.lastName),
    email: bookingEmailOf(booking, customer),
    phone: safeText(bookingParent.phone || customerParent.phone),
    phone2: safeText(bookingParent.phone2 || customerParent.phone2),
  };
}

async function sendConfirmationEmailHandler(
  req,
  res,
  requireOwner,
  requireId,
  typeCodeFromOffer,
  nextSequence,
  yearFrom,
  formatInvoiceShort,
  buildParticipationPdf,
  sendParticipationEmail,
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

    const { invoiceNo, monthlyAmount, firstMonthAmount, venue, invoiceDate } =
      req.body || {};

    let customerDoc = await Customer.findOne({ _id: id, owner }).exec();
    if (!customerDoc) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const bookingRef =
      customerDoc.bookings.id(bid) ||
      customerDoc.bookings.find((b) => String(b?._id) === bid);

    if (!bookingRef) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // if (!customerDoc.parent?.email) {
    //   return res.status(400).json({ error: "Customer has no email" });
    // }

    // const effectiveBooking = bookingDoc || bookingRef;
    // const recipientEmail = bookingEmailOf(effectiveBooking, customerDoc);

    // if (!recipientEmail) {
    //   return res.status(400).json({ error: "Booking has no recipient email" });
    // }

    const lookupId = bookingRef.bookingId || bookingRef._id;
    const bookingDoc = await Booking.findOne({ _id: lookupId, owner }).lean();

    const effectiveBooking = bookingDoc || bookingRef;
    const recipientEmail = bookingEmailOf(effectiveBooking, customerDoc);

    if (!recipientEmail) {
      return res.status(400).json({ error: "Booking has no recipient email" });
    }

    const offerDb = bookingRef.offerId
      ? await Offer.findById(bookingRef.offerId).lean()
      : bookingDoc?.offerId
        ? await Offer.findById(bookingDoc.offerId).lean()
        : null;

    const offer = offerDb || offerLikeFromBooking(bookingDoc || bookingRef);

    const oneOff =
      String(offer.type) === "PersonalTraining" ||
      String(offer.sub_type || "").toLowerCase() === "powertraining" ||
      String(bookingRef.offerType || "").toLowerCase() === "powertraining";

    bookingRef.offerTitle =
      bookingRef.offerTitle ||
      offer.title ||
      offer.sub_type ||
      offer.type ||
      "";
    bookingRef.offerType =
      bookingRef.offerType || offer.sub_type || offer.type || "";
    bookingRef.venue = bookingRef.venue || offer.location || "";

    let needsSave = false;

    const mAmt = oneOff
      ? undefined
      : (monthlyAmount ?? "") === ""
        ? undefined
        : Number(monthlyAmount);

    const fAmt = oneOff
      ? undefined
      : (firstMonthAmount ?? "") === ""
        ? undefined
        : Number(firstMonthAmount);

    if (Number.isFinite(mAmt)) {
      bookingRef.monthlyAmount = mAmt;
      needsSave = true;
    }

    if (Number.isFinite(fAmt)) {
      bookingRef.firstMonthAmount = fAmt;
      needsSave = true;
    }

    if (oneOff) {
      bookingRef.monthlyAmount = undefined;
      bookingRef.firstMonthAmount = undefined;
      if (
        bookingRef.priceAtBooking == null &&
        typeof offer.price === "number"
      ) {
        bookingRef.priceAtBooking = offer.price;
      }
      needsSave = true;
    } else if (
      bookingRef.monthlyAmount == null &&
      typeof offer.price === "number"
    ) {
      bookingRef.monthlyAmount = offer.price;
      needsSave = true;
    }

    const docInvoiceNo = String(
      bookingDoc?.invoiceNumber || bookingDoc?.invoiceNo || "",
    ).trim();

    const docInvoiceDate = bookingDoc?.invoiceDate || undefined;

    if (docInvoiceNo && !bookingRef.invoiceNumber && !bookingRef.invoiceNo) {
      bookingRef.invoiceNumber = docInvoiceNo;
      bookingRef.invoiceDate = docInvoiceDate || new Date();
      needsSave = true;
    }

    if (!docInvoiceNo) {
      if (typeof invoiceNo === "string" && invoiceNo.trim()) {
        if (!bookingRef.invoiceNumber && !bookingRef.invoiceNo) {
          bookingRef.invoiceNumber = invoiceNo.trim();
          bookingRef.invoiceDate = invoiceDate
            ? new Date(invoiceDate)
            : new Date();
          if (
            bookingRef.priceAtBooking == null &&
            typeof offer.price === "number"
          ) {
            bookingRef.priceAtBooking = offer.price;
          }
          needsSave = true;
        }
      } else if (!bookingRef.invoiceNumber && !bookingRef.invoiceNo) {
        const code = (
          offer.code ||
          typeCodeFromOffer(offer) ||
          "INV"
        ).toUpperCase();
        const seq = await nextSequence(`invoice:${code}:${yearFrom()}`);
        bookingRef.invoiceNumber = formatInvoiceShort(code, seq, new Date());
        bookingRef.invoiceDate = new Date();
        if (
          bookingRef.priceAtBooking == null &&
          typeof offer.price === "number"
        ) {
          bookingRef.priceAtBooking = offer.price;
        }
        needsSave = true;
      }
    }

    if (needsSave) {
      customerDoc.markModified("bookings");
      await customerDoc.save();
    }

    const effectiveInvoiceNo =
      (typeof invoiceNo === "string" && invoiceNo.trim()) ||
      docInvoiceNo ||
      bookingRef.invoiceNumber ||
      bookingRef.invoiceNo ||
      "";

    const effectiveInvoiceDate =
      invoiceDate || docInvoiceDate || bookingRef.invoiceDate || undefined;

    // const customer = customerDoc.toObject
    //   ? customerDoc.toObject()
    //   : customerDoc;

    const customer = customerDoc.toObject
      ? customerDoc.toObject()
      : customerDoc;

    customer.parent = bookingParentSnapshot(bookingDoc || bookingRef, customer);
    customer.email = recipientEmail;
    customer.emailLower = recipientEmail;

    let pdf;
    try {
      pdf = await buildParticipationPdf({
        customer,
        booking: bookingDoc || bookingRef,
        offer,
        invoiceNo: effectiveInvoiceNo,
        invoiceDate: effectiveInvoiceDate,
        venue: venue || offer?.location,
        monthlyAmount: bookingRef.monthlyAmount,
        firstMonthAmount: bookingRef.firstMonthAmount,
      });
    } catch (e) {
      console.error("buildParticipationPdf failed:", e);
      return res.status(500).json({
        error: "PDF_BUILD_FAILED",
        detail: String(e?.message || e),
      });
    }

    try {
      await sendParticipationEmail({
        to: customer.parent.email,
        //  to: customer.parent.email,
        customer,
        booking: bookingDoc || bookingRef,
        offer: offer || {},
        pdfBuffer: pdf,
        monthlyAmount,
        firstMonthAmount,
      });
    } catch (e) {
      console.error("sendParticipationEmail failed:", e);
      return res.status(502).json({
        error: "MAIL_SEND_FAILED",
        detail: String(e?.message || e),
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      detail: String(err?.message || err),
    });
  }
}

module.exports = { sendConfirmationEmailHandler };

// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../../models/Customer");
// const Offer = require("../../../../models/Offer");

// function offerLikeFromBooking(booking) {
//   const v = String(booking?.offerType || "").trim();
//   const isPersonalSubtype = /^Einzeltraining_/i.test(v);
//   const isPower = /^Powertraining$/i.test(v);

//   if (isPower) {
//     return {
//       _id: String(booking?.offerId || booking?._id || "missing"),
//       type: "Camp",
//       sub_type: "Powertraining",
//       category: "Holiday",
//       title: booking?.offerTitle || "Power Training",
//       location: booking?.venue || "",
//       price: booking?.priceAtBooking,
//     };
//   }

//   if (isPersonalSubtype) {
//     return {
//       _id: String(booking?.offerId || booking?._id || "missing"),
//       type: "PersonalTraining",
//       sub_type: v,
//       category: "Individual",
//       title: booking?.offerTitle || v,
//       location: booking?.venue || "",
//       price: booking?.priceAtBooking,
//     };
//   }

//   return {
//     _id: String(booking?.offerId || booking?._id || "missing"),
//     type: v || "Angebot",
//     sub_type: "",
//     category: booking?.offerCategory,
//     title: booking?.offerTitle || v || "Angebot",
//     location: booking?.venue || "",
//     price: booking?.priceAtBooking,
//   };
// }

// async function sendConfirmationEmailHandler(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   typeCodeFromOffer,
//   nextSequence,
//   yearFrom,
//   formatInvoiceShort,
//   buildParticipationPdf,
//   sendParticipationEmail,
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

//     const { invoiceNo, monthlyAmount, firstMonthAmount, venue, invoiceDate } =
//       req.body || {};

//     let customerDoc = await Customer.findOne({ _id: id, owner }).exec();
//     if (!customerDoc)
//       return res.status(404).json({ error: "Customer not found" });

//     let booking =
//       customerDoc.bookings.id(bid) ||
//       customerDoc.bookings.find((b) => String(b?._id) === bid);

//     if (!booking) {
//       customerDoc = await Customer.findOne({ _id: id, owner }).exec();
//       booking =
//         customerDoc?.bookings?.id(bid) ||
//         customerDoc?.bookings?.find((b) => String(b?._id) === bid);
//     }

//     if (!booking) return res.status(404).json({ error: "Booking not found" });

//     if (!customerDoc.parent?.email) {
//       return res.status(400).json({ error: "Customer has no email" });
//     }

//     const offerDb = booking.offerId
//       ? await Offer.findById(booking.offerId).lean()
//       : null;
//     const offer = offerDb || offerLikeFromBooking(booking);

//     const oneOff =
//       String(offer.type) === "PersonalTraining" ||
//       String(offer.sub_type || "").toLowerCase() === "powertraining" ||
//       String(booking.offerType || "").toLowerCase() === "powertraining";

//     booking.offerTitle =
//       booking.offerTitle || offer.title || offer.sub_type || offer.type || "";
//     booking.offerType = booking.offerType || offer.sub_type || offer.type || "";
//     booking.venue = booking.venue || offer.location || "";

//     let needsSave = false;

//     const mAmt = oneOff
//       ? undefined
//       : (monthlyAmount ?? "") === ""
//         ? undefined
//         : Number(monthlyAmount);

//     const fAmt = oneOff
//       ? undefined
//       : (firstMonthAmount ?? "") === ""
//         ? undefined
//         : Number(firstMonthAmount);

//     if (Number.isFinite(mAmt)) {
//       booking.monthlyAmount = mAmt;
//       needsSave = true;
//     }

//     if (Number.isFinite(fAmt)) {
//       booking.firstMonthAmount = fAmt;
//       needsSave = true;
//     }

//     if (oneOff) {
//       booking.monthlyAmount = undefined;
//       booking.firstMonthAmount = undefined;
//       if (booking.priceAtBooking == null && typeof offer.price === "number") {
//         booking.priceAtBooking = offer.price;
//       }
//       needsSave = true;
//     } else if (
//       booking.monthlyAmount == null &&
//       typeof offer.price === "number"
//     ) {
//       booking.monthlyAmount = offer.price;
//       needsSave = true;
//     }

//     if (typeof invoiceNo === "string" && invoiceNo.trim()) {
//       if (!booking.invoiceNumber && !booking.invoiceNo) {
//         booking.invoiceNumber = invoiceNo.trim();
//         booking.invoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();
//         if (booking.priceAtBooking == null && typeof offer.price === "number") {
//           booking.priceAtBooking = offer.price;
//         }
//         needsSave = true;
//       }
//     } else if (!booking.invoiceNumber && !booking.invoiceNo) {
//       const code = (
//         offer.code ||
//         typeCodeFromOffer(offer) ||
//         "INV"
//       ).toUpperCase();
//       const seq = await nextSequence(`invoice:${code}:${yearFrom()}`);
//       booking.invoiceNumber = formatInvoiceShort(code, seq, new Date());
//       booking.invoiceDate = new Date();
//       if (booking.priceAtBooking == null && typeof offer.price === "number") {
//         booking.priceAtBooking = offer.price;
//       }
//       needsSave = true;
//     }

//     if (needsSave) {
//       customerDoc.markModified("bookings");
//       await customerDoc.save();
//     }

//     const effectiveInvoiceNo =
//       (typeof invoiceNo === "string" && invoiceNo.trim()) ||
//       booking.invoiceNumber ||
//       booking.invoiceNo ||
//       "";

//     const effectiveInvoiceDate =
//       invoiceDate || booking.invoiceDate || undefined;

//     const customer = customerDoc.toObject
//       ? customerDoc.toObject()
//       : customerDoc;

//     let pdf;
//     try {
//       pdf = await buildParticipationPdf({
//         customer,
//         booking,
//         offer,
//         invoiceNo: effectiveInvoiceNo,
//         invoiceDate: effectiveInvoiceDate,
//         venue: venue || offer?.location,
//         monthlyAmount: booking.monthlyAmount,
//         firstMonthAmount: booking.firstMonthAmount,
//       });
//     } catch (e) {
//       console.error("buildParticipationPdf failed:", e);
//       return res.status(500).json({
//         error: "PDF_BUILD_FAILED",
//         detail: String(e?.message || e),
//       });
//     }

//     try {
//       await sendParticipationEmail({
//         to: customer.parent.email,
//         customer,
//         booking,
//         offer: offer || {},
//         pdfBuffer: pdf,
//         monthlyAmount,
//         firstMonthAmount,
//       });
//     } catch (e) {
//       console.error("sendParticipationEmail failed:", e);
//       return res.status(502).json({
//         error: "MAIL_SEND_FAILED",
//         detail: String(e?.message || e),
//       });
//     }

//     return res.json({ ok: true });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({
//       error: "Server error",
//       detail: String(err?.message || err),
//     });
//   }
// }

// module.exports = { sendConfirmationEmailHandler };
