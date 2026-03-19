//utils\oneTimeInvoices.js
"use strict";

const Customer = require("../models/Customer");

const { buildParticipationPdf } = require("./pdf");
const { sendParticipationEmail } = require("./mailer");
const { assignInvoiceData } = require("./billing");
const { normalizeInvoiceNo } = require("./pdfData");

function safeText(v) {
  return String(v ?? "").trim();
}

function pickFirst(...vals) {
  for (const v of vals) {
    const s = safeText(v);
    if (s) return s;
  }
  return "";
}

function bookingRecipientEmail(booking, customer) {
  return pickFirst(
    booking?.invoiceTo?.parent?.email,
    booking?.email,
    customer?.parent?.email,
    customer?.email,
  ).toLowerCase();
}

function bookingParentSnapshot(booking, customer, recipientEmail) {
  const bookingParent = booking?.invoiceTo?.parent || {};
  const customerParent = customer?.parent || {};

  return {
    ...customer,
    parent: {
      salutation: pickFirst(
        bookingParent?.salutation,
        customerParent?.salutation,
      ),
      firstName: pickFirst(bookingParent?.firstName, customerParent?.firstName),
      lastName: pickFirst(bookingParent?.lastName, customerParent?.lastName),
      email: recipientEmail,
      phone: pickFirst(bookingParent?.phone, customerParent?.phone),
      phone2: pickFirst(bookingParent?.phone2, customerParent?.phone2),
    },
    email: recipientEmail,
    emailLower: recipientEmail,
  };
}

function parseBookingDate(booking) {
  const d = booking?.date
    ? new Date(booking.date)
    : booking?.createdAt || new Date();
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveVenue(offer) {
  if (typeof offer?.location === "string") return offer.location;
  return offer?.location?.name || offer?.location?.title || "";
}

// async function findCustomerByBooking(ownerId, bookingId) {
//   return Customer.findOne({ owner: ownerId, "bookings.bookingId": bookingId });
// }

// async function findCustomerByBooking(ownerId, booking) {
//   const byRef = await Customer.findOne({
//     owner: ownerId,
//     "bookings.bookingId": booking._id,
//   });

//   if (byRef) return byRef;

//   if (booking?.customerId) {
//     return Customer.findOne({
//       owner: ownerId,
//       _id: booking.customerId,
//     });
//   }

//   return null;
// }

async function findCustomerByBooking(ownerId, booking) {
  const byRef = await Customer.findOne({
    owner: ownerId,
    "bookings.bookingId": booking._id,
  });

  if (byRef) return byRef;

  if (booking?.customerId) {
    return Customer.findOne({
      owner: ownerId,
      _id: booking.customerId,
    });
  }

  return null;
}

function ensureCustomerBookingRef(customer, offer, booking) {
  let ref = customer.bookings.find(
    (b) => String(b.bookingId) === String(booking._id),
  );
  if (ref) return ref;

  customer.bookings.push({
    bookingId: booking._id,
    offerId: offer?._id || booking.offerId,
    offerTitle:
      offer?.title ||
      offer?.sub_type ||
      offer?.type ||
      booking.offerTitle ||
      "",
    offerType: offer?.sub_type || offer?.type || booking.offerType || "",
    venue: resolveVenue(offer),
    date: parseBookingDate(booking),
    status: "active",
    priceAtBooking:
      typeof booking.priceAtBooking === "number"
        ? booking.priceAtBooking
        : typeof offer?.price === "number"
          ? offer.price
          : null,
  });

  return customer.bookings[customer.bookings.length - 1];
}

function noteForOffer(offer) {
  const cat = safeText(offer?.category);
  if (cat === "ClubPrograms") return "Club Program (One-Time)";
  if (cat === "Individual") return "Individual Course (One-Time)";
  if (cat === "RentACoach") return "Club Program (One-Time)";
  return "One-Time Program";
}

function discountsFromBooking(booking, amount) {
  const basePrice =
    typeof booking?.meta?.basePrice === "number"
      ? booking.meta.basePrice
      : null;

  const siblingDiscount =
    typeof booking?.meta?.siblingDiscount === "number"
      ? booking.meta.siblingDiscount
      : null;

  const memberDiscount =
    typeof booking?.meta?.memberDiscount === "number"
      ? booking.meta.memberDiscount
      : null;

  const totalDiscount =
    typeof booking?.meta?.totalDiscount === "number"
      ? booking.meta.totalDiscount
      : Number(booking?.meta?.siblingDiscount || 0) +
        Number(booking?.meta?.memberDiscount || 0);

  return {
    basePrice,
    siblingDiscount,
    memberDiscount,
    totalDiscount,
    finalPrice: amount != null ? Number(amount) : null,
  };
}

function updateRefSnapshot({
  ref,
  offer,
  booking,
  invoiceNo,
  invoiceDate,
  amount,
}) {
  ref.invoiceNumber = ref.invoiceNumber || invoiceNo;
  ref.invoiceNo = ref.invoiceNo || invoiceNo;
  ref.invoiceDate = ref.invoiceDate || invoiceDate;

  if (typeof ref.priceAtBooking !== "number" && amount != null) {
    ref.priceAtBooking = amount;
  }

  ref.currency = ref.currency || "EUR";
  ref.offerTitle =
    ref.offerTitle ||
    offer?.title ||
    offer?.sub_type ||
    booking.offerTitle ||
    "";
  ref.offerType =
    ref.offerType || offer?.sub_type || offer?.type || booking.offerType || "";
  ref.venue = ref.venue || offer?.location || booking.venue || "";

  if (!Array.isArray(ref.invoiceRefs)) ref.invoiceRefs = [];

  const hasRef = ref.invoiceRefs.some((r) => r.number === invoiceNo);
  if (hasRef) return;

  const d = discountsFromBooking(booking, amount);
  ref.invoiceRefs.push({
    number: invoiceNo,
    date: invoiceDate,
    amount: amount != null ? amount : null,
    basePrice: d.basePrice,
    siblingDiscount: d.siblingDiscount,
    memberDiscount: d.memberDiscount,
    totalDiscount: d.totalDiscount,
    finalPrice: d.finalPrice,
    note: noteForOffer(offer),
  });
}

async function buildPdfSafe({
  customer,
  booking,
  offer,
  invoiceNo,
  invoiceDate,
}) {
  try {
    return await buildParticipationPdf({
      customer,
      booking,
      offer,
      invoiceNo,
      invoiceDate,
      firstMonthAmount: null,
      venue: booking.venue || offer?.location || "",
    });
  } catch (e) {
    console.error(
      "[oneTimeInvoice] buildParticipationPdf failed:",
      e?.message || e,
    );
    return null;
  }
}

// async function sendMailSafe({ booking, customer, offer, pdfBuffer }) {
//   try {
//     const to = pickFirst(
//       customer?.parent?.email,
//       customer?.email,
//       booking?.invoiceTo?.parent?.email,
//       booking?.email,
//     ).toLowerCase();

//     if (!to) return;

//     await sendParticipationEmail({
//       to,
//       customer,
//       booking,
//       offer,
//       pdfBuffer,
//     });
//   } catch (e) {
//     console.error(
//       "[oneTimeInvoice] sendParticipationEmail failed:",
//       e?.message || e,
//     );
//   }
// }

// async function sendMailSafe({ booking, customer, offer, pdfBuffer }) {
//   try {
//     const to = pickFirst(
//       customer?.parent?.email,
//       customer?.email,
//       booking?.invoiceTo?.parent?.email,
//       booking?.email,
//     ).toLowerCase();

//     if (!to) return false;

//     await sendParticipationEmail({
//       to,
//       customer,
//       booking,
//       offer,
//       pdfBuffer,
//     });

//     return true;
//   } catch (e) {
//     console.error(
//       "[oneTimeInvoice] sendParticipationEmail failed:",
//       e?.message || e,
//     );
//     return false;
//   }
// }

async function sendMailSafe({ booking, customer, offer, pdfBuffer }) {
  try {
    const to = bookingRecipientEmail(booking, customer);
    if (!to) return false;

    const effectiveCustomer = bookingParentSnapshot(booking, customer, to);

    await sendParticipationEmail({
      to,
      customer: effectiveCustomer,
      booking,
      offer,
      pdfBuffer,
    });

    return true;
  } catch (e) {
    console.error(
      "[oneTimeInvoice] sendParticipationEmail failed:",
      e?.message || e,
    );
    return false;
  }
}
async function createOneTimeInvoiceForBooking({ ownerId, offer, booking }) {
  if (!ownerId || !offer || !booking) return;

  //const customer = await findCustomerByBooking(ownerId, booking._id);
  const customer = await findCustomerByBooking(ownerId, booking);
  if (!customer) {
    console.warn(
      "[oneTimeInvoice] no customer found for booking",
      String(booking._id),
    );
    return;
  }

  const ref = ensureCustomerBookingRef(customer, offer, booking);

  const alreadyInvoiced =
    Boolean(booking.invoiceNumber || booking.invoiceNo) ||
    (ref && Array.isArray(ref.invoiceRefs) && ref.invoiceRefs.length > 0);

  const providerId = String(ownerId || "1").trim() || "1";

  if (!alreadyInvoiced) {
    await assignInvoiceData({ booking, offer, providerId });
  }

  const invoiceNo = normalizeInvoiceNo(
    booking.invoiceNumber || booking.invoiceNo || "",
  );
  const invoiceDate = booking.invoiceDate || new Date();

  const amount =
    typeof booking.priceAtBooking === "number"
      ? Number(booking.priceAtBooking)
      : typeof offer?.price === "number"
        ? Number(offer.price)
        : null;

  updateRefSnapshot({
    ref,
    offer,
    booking,
    invoiceNo,
    invoiceDate,
    amount,
  });

  await customer.save();

  const pdfBuffer = await buildPdfSafe({
    customer,
    booking,
    offer,
    invoiceNo,
    invoiceDate,
  });

  //await sendMailSafe({ booking, customer, offer, pdfBuffer });
  const sent = await sendMailSafe({ booking, customer, offer, pdfBuffer });

  if (!booking.meta || typeof booking.meta !== "object") booking.meta = {};
  if (sent) {
    booking.meta.oneTimeParticipationEmailSentAt = new Date().toISOString();
    booking.markModified("meta");
    await booking.save();
  }
}

module.exports = { createOneTimeInvoiceForBooking };
