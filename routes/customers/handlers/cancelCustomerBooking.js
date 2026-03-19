//routes\customers\handlers\cancelCustomerBooking.js
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../models/Customer");
const Offer = require("../../../models/Offer");
const Booking = require("../../../models/Booking");

const { stripeClient } = require("../../payments/stripe/lib/stripeClient");
const {
  ensureMeta,
  ensureStripeShape,
} = require("../../payments/stripe/lib/bookingStripe");

function safeText(v) {
  return String(v ?? "").trim();
}

function endOfDay(value) {
  const date = value ? new Date(value) : new Date();
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  );
}

function safeLower(v) {
  return safeText(v).toLowerCase();
}

function pickRecipient(customer, bookingDoc, booking) {
  return (
    safeText(bookingDoc?.invoiceTo?.parent?.email) ||
    safeText(booking?.parentEmail) ||
    safeText(customer?.parent?.email) ||
    safeText(customer?.email)
  );
}

async function syncStripeCancellation(bookingDoc, endAt) {
  if (!bookingDoc) return;
  ensureStripeShape(bookingDoc);

  const isSubscription =
    safeText(bookingDoc?.stripe?.mode) === "subscription" &&
    safeText(bookingDoc?.stripe?.subscriptionId);

  if (!isSubscription) return;

  const stripe = stripeClient();
  const effectiveAt = endOfDay(endAt);
  const cancelAt = Math.floor(effectiveAt.getTime() / 1000);
  const updated = await stripe.subscriptions.update(
    safeText(bookingDoc.stripe.subscriptionId),
    { cancel_at: cancelAt },
  );

  const meta = ensureMeta(bookingDoc);
  bookingDoc.status = "cancelled";
  bookingDoc.cancelDate = bookingDoc.cancelDate || new Date();
  bookingDoc.cancellationDate = bookingDoc.cancellationDate || new Date();
  bookingDoc.endDate = bookingDoc.endDate || effectiveAt;
  bookingDoc.stripe.subStatus = safeText(updated?.status);
  bookingDoc.stripe.cancelRequestedAt =
    bookingDoc.stripe.cancelRequestedAt || new Date();
  bookingDoc.stripe.cancelEffectiveAt = new Date(
    (updated?.cancel_at || cancelAt) * 1000,
  );
  meta.subscriptionCancelSource = "admin_dialog";
  meta.subscriptionCancelStatus = "requested";
  meta.subscriptionCancelRequestedAt = new Date().toISOString();
  meta.subscriptionCancelEffectiveAt =
    bookingDoc.stripe.cancelEffectiveAt.toISOString();
  bookingDoc.markModified("meta");
  await bookingDoc.save();
}

// if (!bookingDoc) {
//   return res.status(404).json({ error: "Booking document not found" });
// }

function offerLikeFromBooking(booking) {
  const v = String(booking?.offerType || "").trim();
  const title = String(booking?.offerTitle || "").trim();
  const venue = String(booking?.venue || "").trim();

  const isPersonalSubtype = /^Einzeltraining_/i.test(v);
  const isPower = /^Powertraining$/i.test(v);
  const isWeeklySubtype =
    v === "Torwarttraining" || v === "Foerdertraining_Athletik";
  const isRent = v === "RentACoach_Generic";
  const isClub = v === "ClubProgram_Generic" || v === "CoachEducation";

  if (isPower) {
    return {
      _id: String(booking?.offerId || booking?._id || "missing"),
      category: "Holiday",
      type: "Camp",
      sub_type: "Powertraining",
      title: title || "Power Training",
      location: venue,
    };
  }

  if (isPersonalSubtype) {
    return {
      _id: String(booking?.offerId || booking?._id || "missing"),
      category: "Individual",
      type: "PersonalTraining",
      sub_type: v,
      title: title || v,
      location: venue,
    };
  }

  if (isWeeklySubtype) {
    return {
      _id: String(booking?.offerId || booking?._id || "missing"),
      category: "Weekly",
      type: "Foerdertraining",
      sub_type: v,
      title: title || v,
      location: venue,
    };
  }

  if (isRent) {
    return {
      _id: String(booking?.offerId || booking?._id || "missing"),
      category: "RentACoach",
      type: "RentACoach",
      sub_type: "RentACoach_Generic",
      title: title || "Rent-a-Coach",
      location: venue,
    };
  }

  if (isClub) {
    return {
      _id: String(booking?.offerId || booking?._id || "missing"),
      category: "ClubPrograms",
      type: "ClubPrograms",
      sub_type: v,
      title: title || v,
      location: venue,
    };
  }

  return {
    _id: String(booking?.offerId || booking?._id || "missing"),
    title: title || v || "Angebot",
    type: v || "Angebot",
    sub_type: "",
    location: venue,
  };
}

function findCustomerChild(customer, booking, bookingDoc) {
  const children = Array.isArray(customer?.children) ? customer.children : [];
  const uid = safeText(booking?.childUid) || safeText(bookingDoc?.childUid);

  if (uid) {
    const byUid = children.find((ch) => safeText(ch?.uid) === uid);
    if (byUid) return byUid;
  }

  const first =
    safeText(booking?.childFirstName) ||
    safeText(bookingDoc?.childFirstName) ||
    safeText(booking?.firstName) ||
    safeText(bookingDoc?.firstName);

  const last =
    safeText(booking?.childLastName) ||
    safeText(bookingDoc?.childLastName) ||
    safeText(booking?.lastName) ||
    safeText(bookingDoc?.lastName);

  if (!first && !last) return null;

  const byName = children.find((ch) => {
    return (
      safeText(ch?.firstName).toLowerCase() === first.toLowerCase() &&
      safeText(ch?.lastName).toLowerCase() === last.toLowerCase()
    );
  });

  return byName || null;
}

function splitChildName(fullName) {
  const raw = safeText(fullName);
  if (!raw) return { firstName: "", lastName: "" };

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function buildEffectiveBooking(
  customer,
  booking,
  bookingDoc,
  offer,
  cancelAt,
  reason,
  endAt,
) {
  const matchedChild = findCustomerChild(customer, booking, bookingDoc);

  const childUid =
    safeText(booking?.childUid) ||
    safeText(bookingDoc?.childUid) ||
    safeText(matchedChild?.uid);

  const bookingChildName = splitChildName(
    safeText(booking?.childName) || safeText(bookingDoc?.childName),
  );

  const childFirstName =
    safeText(booking?.childFirstName) ||
    safeText(bookingDoc?.childFirstName) ||
    safeText(bookingChildName.firstName) ||
    safeText(matchedChild?.firstName);

  const childLastName =
    safeText(booking?.childLastName) ||
    safeText(bookingDoc?.childLastName) ||
    safeText(bookingChildName.lastName) ||
    safeText(matchedChild?.lastName);

  return {
    ...(booking?.toObject ? booking.toObject() : booking),
    childUid,
    childFirstName,
    childLastName,
    childName:
      safeText(booking?.childName) ||
      [childFirstName, childLastName].filter(Boolean).join(" "),

    firstName:
      safeText(booking?.firstName) || safeText(bookingDoc?.firstName) || "",
    lastName:
      safeText(booking?.lastName) || safeText(bookingDoc?.lastName) || "",
    offerTitle:
      safeText(booking?.offerTitle) ||
      safeText(bookingDoc?.offerTitle) ||
      safeText(offer?.title) ||
      safeText(offer?.sub_type) ||
      safeText(offer?.type),
    offerType:
      safeText(booking?.offerType) ||
      safeText(bookingDoc?.offerType) ||
      safeText(offer?.sub_type) ||
      safeText(offer?.type),
    venue:
      safeText(booking?.venue) ||
      safeText(bookingDoc?.venue) ||
      safeText(offer?.location),
    cancelDate: booking?.cancelDate || cancelAt,
    cancelReason: safeText(booking?.cancelReason) || safeText(reason),
    endDate: booking?.endDate || endAt || null,
    invoiceNumber:
      safeText(booking?.invoiceNumber) || safeText(bookingDoc?.invoiceNumber),
    invoiceNo: safeText(booking?.invoiceNo) || safeText(bookingDoc?.invoiceNo),
    invoiceDate: booking?.invoiceDate || bookingDoc?.invoiceDate || null,
    refInvoiceNo:
      safeText(booking?.refInvoiceNo) ||
      safeText(bookingDoc?.refInvoiceNo) ||
      safeText(booking?.invoiceNumber) ||
      safeText(booking?.invoiceNo) ||
      safeText(bookingDoc?.invoiceNumber) ||
      safeText(bookingDoc?.invoiceNo),
    refInvoiceDate:
      booking?.refInvoiceDate ||
      bookingDoc?.refInvoiceDate ||
      booking?.invoiceDate ||
      bookingDoc?.invoiceDate ||
      null,
  };
}

async function cancelCustomerBooking(
  req,
  res,
  requireOwner,
  requireId,
  isCancelAllowed,
  formatCancellationNo,
  typeCodeFromOffer,
  nextSequence,
  yearFrom,
  formatInvoiceShort,
  buildCancellationPdf,
  sendCancellationEmail,
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

    const { date, reason, endDate } = req.body || {};
    const cancelAt = date ? new Date(date) : new Date();
    const endAt = endDate ? new Date(endDate) : null;

    const customer = await Customer.findOne({ _id: id, owner });
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const booking = customer.bookings.id(bid);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const lookupId = booking.bookingId || booking._id;
    // const bookingDoc = await Booking.findOne({ _id: lookupId, owner }).lean();

    const bookingDoc = await Booking.findOne({ _id: lookupId, owner });

    if (!bookingDoc) {
      return res.status(404).json({ error: "Booking document not found" });
    }

    const offerDb = booking.offerId
      ? await Offer.findById(booking.offerId).lean()
      : bookingDoc?.offerId
        ? await Offer.findById(bookingDoc.offerId).lean()
        : null;

    const offer = offerDb || offerLikeFromBooking(bookingDoc || booking);

    if (!isCancelAllowed(offer)) {
      return res.status(400).json({ error: "This offer cannot be cancelled" });
    }

    const docInvNo = String(
      bookingDoc?.invoiceNumber || bookingDoc?.invoiceNo || "",
    ).trim();

    if (!booking.invoiceNumber && !booking.invoiceNo && docInvNo) {
      booking.invoiceNumber = docInvNo;
      if (!booking.invoiceDate && bookingDoc?.invoiceDate) {
        booking.invoiceDate = bookingDoc.invoiceDate;
      }
    }

    if (!booking.cancellationNo) {
      booking.cancellationNo = formatCancellationNo();
    }

    booking.status = "cancelled";
    booking.cancelDate = cancelAt;
    booking.cancelReason = String(reason || "");
    if (endAt) booking.endDate = endAt;

    booking.offerTitle =
      booking.offerTitle || offer.title || offer.sub_type || offer.type || "";
    booking.offerType = booking.offerType || offer.sub_type || offer.type || "";
    booking.venue = booking.venue || offer.location || "";

    if (!booking.invoiceNumber && !booking.invoiceNo) {
      const code = (
        offer.code ||
        typeCodeFromOffer(offer) ||
        "INV"
      ).toUpperCase();

      const seq = await nextSequence(
        `invoice:${code}:${yearFrom((bookingDoc && bookingDoc.date) || booking.date || new Date())}`,
      );

      const when =
        (bookingDoc && bookingDoc.date) || booking.date || new Date();

      booking.invoiceNumber = formatInvoiceShort(code, seq, when);
      booking.invoiceDate = when instanceof Date ? when : new Date(when);
    }

    await customer.save();

    await syncStripeCancellation(bookingDoc, endAt || cancelAt);

    const refNo =
      docInvNo ||
      String(booking.invoiceNumber || booking.invoiceNo || "").trim() ||
      "";

    const refDate = bookingDoc?.invoiceDate || booking.invoiceDate || null;

    const effectiveBooking = buildEffectiveBooking(
      customer,
      booking,
      bookingDoc,
      offer,
      cancelAt,
      reason,
      endAt,
    );

    effectiveBooking.cancellationNo =
      safeText(booking.cancellationNo) ||
      safeText(effectiveBooking.cancellationNo);

    const recipient = pickRecipient(customer, bookingDoc, booking);

    if (recipient) {
      const pdf = await buildCancellationPdf({
        customer: customer.toObject?.() || customer,
        booking: effectiveBooking,
        offer,
        date: cancelAt,
        endDate: effectiveBooking.endDate || null,
        reason,
        cancellationNo: effectiveBooking.cancellationNo,
        refInvoiceNo: refNo,
        refInvoiceDate: refDate,
      });

      await Booking.findByIdAndUpdate(
        lookupId,
        {
          $set: {
            status: "cancelled",
            cancellationNo: booking.cancellationNo,
            cancellationDate: booking.cancelDate,
            cancellationReason: booking.cancelReason,
          },
        },
        { new: true },
      );

      await sendCancellationEmail({
        to: recipient,
        customer: customer.toObject?.() || customer,
        booking: effectiveBooking,
        offer,
        date: cancelAt,
        endDate: effectiveBooking.endDate || null,
        reason,
        pdfBuffer: pdf,
        refInvoiceNo: refNo,
        refInvoiceDate: refDate,
      });
    }

    res.json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { cancelCustomerBooking };

// //routes\customers\handlers\cancelCustomerBooking.js
// "use strict";

// const mongoose = require("mongoose");
// const Customer = require("../../../models/Customer");
// const Offer = require("../../../models/Offer");
// const Booking = require("../../../models/Booking");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function offerLikeFromBooking(booking) {
//   const v = String(booking?.offerType || "").trim();
//   const title = String(booking?.offerTitle || "").trim();
//   const venue = String(booking?.venue || "").trim();

//   const isPersonalSubtype = /^Einzeltraining_/i.test(v);
//   const isPower = /^Powertraining$/i.test(v);
//   const isWeeklySubtype =
//     v === "Torwarttraining" || v === "Foerdertraining_Athletik";
//   const isRent = v === "RentACoach_Generic";
//   const isClub = v === "ClubProgram_Generic" || v === "CoachEducation";

//   if (isPower) {
//     return {
//       _id: String(booking?.offerId || booking?._id || "missing"),
//       category: "Holiday",
//       type: "Camp",
//       sub_type: "Powertraining",
//       title: title || "Power Training",
//       location: venue,
//     };
//   }

//   if (isPersonalSubtype) {
//     return {
//       _id: String(booking?.offerId || booking?._id || "missing"),
//       category: "Individual",
//       type: "PersonalTraining",
//       sub_type: v,
//       title: title || v,
//       location: venue,
//     };
//   }

//   if (isWeeklySubtype) {
//     return {
//       _id: String(booking?.offerId || booking?._id || "missing"),
//       category: "Weekly",
//       type: "Foerdertraining",
//       sub_type: v,
//       title: title || v,
//       location: venue,
//     };
//   }

//   if (isRent) {
//     return {
//       _id: String(booking?.offerId || booking?._id || "missing"),
//       category: "RentACoach",
//       type: "RentACoach",
//       sub_type: "RentACoach_Generic",
//       title: title || "Rent-a-Coach",
//       location: venue,
//     };
//   }

//   if (isClub) {
//     return {
//       _id: String(booking?.offerId || booking?._id || "missing"),
//       category: "ClubPrograms",
//       type: "ClubPrograms",
//       sub_type: v,
//       title: title || v,
//       location: venue,
//     };
//   }

//   return {
//     _id: String(booking?.offerId || booking?._id || "missing"),
//     title: title || v || "Angebot",
//     type: v || "Angebot",
//     sub_type: "",
//     location: venue,
//   };
// }

// function findCustomerChild(customer, booking, bookingDoc) {
//   const children = Array.isArray(customer?.children) ? customer.children : [];
//   const uid = safeText(booking?.childUid) || safeText(bookingDoc?.childUid);

//   if (uid) {
//     const byUid = children.find((ch) => safeText(ch?.uid) === uid);
//     if (byUid) return byUid;
//   }

//   const first =
//     safeText(booking?.childFirstName) ||
//     safeText(bookingDoc?.childFirstName) ||
//     safeText(booking?.firstName) ||
//     safeText(bookingDoc?.firstName);

//   const last =
//     safeText(booking?.childLastName) ||
//     safeText(bookingDoc?.childLastName) ||
//     safeText(booking?.lastName) ||
//     safeText(bookingDoc?.lastName);

//   if (!first && !last) return null;

//   const byName = children.find((ch) => {
//     return (
//       safeText(ch?.firstName).toLowerCase() === first.toLowerCase() &&
//       safeText(ch?.lastName).toLowerCase() === last.toLowerCase()
//     );
//   });

//   return byName || null;
// }

// function splitChildName(fullName) {
//   const raw = safeText(fullName);
//   if (!raw) return { firstName: "", lastName: "" };

//   const parts = raw.split(/\s+/).filter(Boolean);
//   if (parts.length === 1) {
//     return { firstName: parts[0], lastName: "" };
//   }

//   return {
//     firstName: parts[0],
//     lastName: parts.slice(1).join(" "),
//   };
// }

// function buildEffectiveBooking(
//   customer,
//   booking,
//   bookingDoc,
//   offer,
//   cancelAt,
//   reason,
//   endAt,
// ) {
//   const matchedChild = findCustomerChild(customer, booking, bookingDoc);

//   const childUid =
//     safeText(booking?.childUid) ||
//     safeText(bookingDoc?.childUid) ||
//     safeText(matchedChild?.uid);

//   const bookingChildName = splitChildName(
//     safeText(booking?.childName) || safeText(bookingDoc?.childName),
//   );

//   const childFirstName =
//     safeText(booking?.childFirstName) ||
//     safeText(bookingDoc?.childFirstName) ||
//     safeText(bookingChildName.firstName) ||
//     safeText(matchedChild?.firstName);

//   const childLastName =
//     safeText(booking?.childLastName) ||
//     safeText(bookingDoc?.childLastName) ||
//     safeText(bookingChildName.lastName) ||
//     safeText(matchedChild?.lastName);

//   return {
//     ...(booking?.toObject ? booking.toObject() : booking),
//     childUid,
//     childFirstName,
//     childLastName,
//     childName:
//       safeText(booking?.childName) ||
//       [childFirstName, childLastName].filter(Boolean).join(" "),

//     firstName:
//       safeText(booking?.firstName) || safeText(bookingDoc?.firstName) || "",
//     lastName:
//       safeText(booking?.lastName) || safeText(bookingDoc?.lastName) || "",
//     offerTitle:
//       safeText(booking?.offerTitle) ||
//       safeText(bookingDoc?.offerTitle) ||
//       safeText(offer?.title) ||
//       safeText(offer?.sub_type) ||
//       safeText(offer?.type),
//     offerType:
//       safeText(booking?.offerType) ||
//       safeText(bookingDoc?.offerType) ||
//       safeText(offer?.sub_type) ||
//       safeText(offer?.type),
//     venue:
//       safeText(booking?.venue) ||
//       safeText(bookingDoc?.venue) ||
//       safeText(offer?.location),
//     cancelDate: booking?.cancelDate || cancelAt,
//     cancelReason: safeText(booking?.cancelReason) || safeText(reason),
//     endDate: booking?.endDate || endAt || null,
//     invoiceNumber:
//       safeText(booking?.invoiceNumber) || safeText(bookingDoc?.invoiceNumber),
//     invoiceNo: safeText(booking?.invoiceNo) || safeText(bookingDoc?.invoiceNo),
//     invoiceDate: booking?.invoiceDate || bookingDoc?.invoiceDate || null,
//     refInvoiceNo:
//       safeText(booking?.refInvoiceNo) ||
//       safeText(bookingDoc?.refInvoiceNo) ||
//       safeText(booking?.invoiceNumber) ||
//       safeText(booking?.invoiceNo) ||
//       safeText(bookingDoc?.invoiceNumber) ||
//       safeText(bookingDoc?.invoiceNo),
//     refInvoiceDate:
//       booking?.refInvoiceDate ||
//       bookingDoc?.refInvoiceDate ||
//       booking?.invoiceDate ||
//       bookingDoc?.invoiceDate ||
//       null,
//   };
// }

// async function cancelCustomerBooking(
//   req,
//   res,
//   requireOwner,
//   requireId,
//   isCancelAllowed,
//   formatCancellationNo,
//   typeCodeFromOffer,
//   nextSequence,
//   yearFrom,
//   formatInvoiceShort,
//   buildCancellationPdf,
//   sendCancellationEmail,
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

//     const { date, reason, endDate } = req.body || {};
//     const cancelAt = date ? new Date(date) : new Date();
//     const endAt = endDate ? new Date(endDate) : null;

//     const customer = await Customer.findOne({ _id: id, owner });
//     if (!customer) {
//       return res.status(404).json({ error: "Customer not found" });
//     }

//     const booking = customer.bookings.id(bid);
//     if (!booking) {
//       return res.status(404).json({ error: "Booking not found" });
//     }

//     const lookupId = booking.bookingId || booking._id;
//     const bookingDoc = await Booking.findOne({ _id: lookupId, owner }).lean();

//     const offerDb = booking.offerId
//       ? await Offer.findById(booking.offerId).lean()
//       : bookingDoc?.offerId
//         ? await Offer.findById(bookingDoc.offerId).lean()
//         : null;

//     const offer = offerDb || offerLikeFromBooking(bookingDoc || booking);

//     if (!isCancelAllowed(offer)) {
//       return res.status(400).json({ error: "This offer cannot be cancelled" });
//     }

//     const docInvNo = String(
//       bookingDoc?.invoiceNumber || bookingDoc?.invoiceNo || "",
//     ).trim();

//     if (!booking.invoiceNumber && !booking.invoiceNo && docInvNo) {
//       booking.invoiceNumber = docInvNo;
//       if (!booking.invoiceDate && bookingDoc?.invoiceDate) {
//         booking.invoiceDate = bookingDoc.invoiceDate;
//       }
//     }

//     if (!booking.cancellationNo) {
//       booking.cancellationNo = formatCancellationNo();
//     }

//     booking.status = "cancelled";
//     booking.cancelDate = cancelAt;
//     booking.cancelReason = String(reason || "");
//     if (endAt) booking.endDate = endAt;

//     booking.offerTitle =
//       booking.offerTitle || offer.title || offer.sub_type || offer.type || "";
//     booking.offerType = booking.offerType || offer.sub_type || offer.type || "";
//     booking.venue = booking.venue || offer.location || "";

//     if (!booking.invoiceNumber && !booking.invoiceNo) {
//       const code = (
//         offer.code ||
//         typeCodeFromOffer(offer) ||
//         "INV"
//       ).toUpperCase();

//       const seq = await nextSequence(
//         `invoice:${code}:${yearFrom((bookingDoc && bookingDoc.date) || booking.date || new Date())}`,
//       );

//       const when =
//         (bookingDoc && bookingDoc.date) || booking.date || new Date();

//       booking.invoiceNumber = formatInvoiceShort(code, seq, when);
//       booking.invoiceDate = when instanceof Date ? when : new Date(when);
//     }

//     await customer.save();

//     const refNo =
//       docInvNo ||
//       String(booking.invoiceNumber || booking.invoiceNo || "").trim() ||
//       "";

//     const refDate = bookingDoc?.invoiceDate || booking.invoiceDate || null;

//     const effectiveBooking = buildEffectiveBooking(
//       customer,
//       booking,
//       bookingDoc,
//       offer,
//       cancelAt,
//       reason,
//       endAt,
//     );

//     effectiveBooking.cancellationNo =
//       safeText(booking.cancellationNo) ||
//       safeText(effectiveBooking.cancellationNo);

//     if (customer.parent?.email) {
//       const pdf = await buildCancellationPdf({
//         customer: customer.toObject?.() || customer,
//         booking: effectiveBooking,
//         offer,
//         date: cancelAt,
//         endDate: effectiveBooking.endDate || null,
//         reason,
//         cancellationNo: effectiveBooking.cancellationNo,
//         refInvoiceNo: refNo,
//         refInvoiceDate: refDate,
//       });

//       await Booking.findByIdAndUpdate(
//         lookupId,
//         {
//           $set: {
//             status: "cancelled",
//             cancellationNo: booking.cancellationNo,
//             cancellationDate: booking.cancelDate,
//             cancellationReason: booking.cancelReason,
//           },
//         },
//         { new: true },
//       );

//       await sendCancellationEmail({
//         to: customer.parent.email,
//         customer: customer.toObject?.() || customer,
//         booking: effectiveBooking,
//         offer,
//         date: cancelAt,
//         endDate: effectiveBooking.endDate || null,
//         reason,
//         pdfBuffer: pdf,
//         refInvoiceNo: refNo,
//         refInvoiceDate: refDate,
//       });
//     }

//     res.json({ ok: true, booking });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { cancelCustomerBooking };
