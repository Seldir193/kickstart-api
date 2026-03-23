//utils\weeklyRecurringInvoices.js
"use strict";

const Customer = require("../models/Customer");
const { renderMjmlFile } = require("./mjmlRenderer");
const { sendMail } = require("./mailer");
const { buildWeeklyRecurringInvoicePdf } = require("./pdf");
const { normalizeInvoiceNo } = require("./pdfData");
const {
  nextSequence,
  yearFrom,
  typeCodeFromOffer,
  formatNumber,
} = require("./sequences");

const fs = require("fs/promises");
const path = require("path");
const BillingDocument = require("../models/BillingDocument");

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

function asObj(v) {
  return v && typeof v === "object" ? v : {};
}

function asList(v) {
  return Array.isArray(v) ? v : [];
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(v) {
  const d = toDate(v);
  return d ? d.toISOString() : "";
}

function toMonthKey(v) {
  const d = toDate(v);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toMonthLabel(v) {
  const d = toDate(v);
  if (!d) return "";
  return new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
  }).format(d);
}

function toDe(v) {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "";
}

function eur(v, currency = "EUR") {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
  }).format(n);
}

function minusOneDay(v) {
  const d = toDate(v);
  if (!d) return null;
  return new Date(d.getTime() - 24 * 60 * 60 * 1000);
}

function displayPeriodStart(periodStart) {
  return toDate(periodStart);
}

function displayPeriodEnd(periodEnd) {
  return minusOneDay(periodEnd);
}

function getBrandAndLogo() {
  return {
    company: process.env.BRAND_COMPANY || "Münchner Fussball Schule NRW",
    addr1: process.env.BRAND_ADDR_LINE1 || "Hochfelder Str. 33",
    addr2: process.env.BRAND_ADDR_LINE2 || "47226 Duisburg",
    email: process.env.BRAND_EMAIL || "info@muenchner-fussball-schule.ruhr",
    website:
      process.env.BRAND_WEBSITE_URL ||
      "https://www.muenchner-fussball-schule.ruhr",
    logoUrl: process.env.BRAND_LOGO_URL || "",
  };
}

function bookingRecipientEmail(booking, customer) {
  return pickFirst(
    booking?.invoiceTo?.parent?.email,
    booking?.email,
    customer?.parent?.email,
    customer?.email,
  ).toLowerCase();
}

function bookingParentSnapshot(customer, booking, recipientEmail) {
  const bookingParent = asObj(booking?.invoiceTo?.parent);
  const customerParent = asObj(customer?.parent);

  return {
    ...customer,
    parent: {
      salutation: pickFirst(
        bookingParent.salutation,
        customerParent.salutation,
      ),
      firstName: pickFirst(bookingParent.firstName, customerParent.firstName),
      lastName: pickFirst(bookingParent.lastName, customerParent.lastName),
      email: recipientEmail,
      phone: pickFirst(bookingParent.phone, customerParent.phone),
      phone2: pickFirst(bookingParent.phone2, customerParent.phone2),
    },
    email: recipientEmail,
    emailLower: recipientEmail,
  };
}

async function findCustomerByBooking(ownerId, booking) {
  const byRef = await Customer.findOne({
    owner: ownerId,
    "bookings.bookingId": booking._id,
  });

  if (byRef) return byRef;

  if (!booking?.customerId) return null;

  return Customer.findOne({
    owner: ownerId,
    _id: booking.customerId,
  });
}

function parseBookingDate(booking) {
  const d = booking?.date
    ? new Date(booking.date)
    : booking?.createdAt || new Date();

  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveVenue(offer, booking) {
  if (safeText(booking?.venue)) return booking.venue;
  if (typeof offer?.location === "string") return offer.location;
  return offer?.location?.name || offer?.location?.title || "";
}

function ensureCustomerBookingRef(customer, offer, booking) {
  let ref = customer.bookings.find(
    (item) => String(item.bookingId) === String(booking._id),
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
    venue: resolveVenue(offer, booking),
    date: parseBookingDate(booking),
    status: "active",
    priceAtBooking:
      typeof booking?.priceMonthly === "number"
        ? booking.priceMonthly
        : typeof offer?.price === "number"
          ? offer.price
          : null,
  });

  return customer.bookings[customer.bookings.length - 1];
}

function isWeeklyOffer(offer, booking) {
  const category = safeText(offer?.category);
  const offerType = safeText(offer?.type);
  const bookingType = safeText(booking?.offerType);

  return (
    category === "Weekly" ||
    offerType === "Foerdertraining" ||
    offerType === "Kindergarten" ||
    bookingType === "Foerdertraining" ||
    bookingType === "Kindergarten"
  );
}

function isRecurringStripeInvoice(stripeInvoice) {
  const reason = safeText(stripeInvoice?.billing_reason);
  return (
    reason === "subscription_cycle" ||
    (!reason && !!stripeInvoice?.subscription)
  );
}

function stripePeriod(stripeInvoice) {
  const line = stripeInvoice?.lines?.data?.[0];
  const start = Number(line?.period?.start);
  const end = Number(line?.period?.end);

  return {
    periodStart: Number.isFinite(start) ? new Date(start * 1000) : null,
    periodEnd: Number.isFinite(end) ? new Date(end * 1000) : null,
  };
}

function recurringAmount(stripeInvoice, booking, offer) {
  const paid = Number(stripeInvoice?.amount_paid);

  if (Number.isFinite(paid) && paid > 0) {
    return Math.round(paid) / 100;
  }

  if (typeof booking?.priceMonthly === "number") {
    return Number(booking.priceMonthly);
  }

  if (typeof offer?.price === "number") {
    return Number(offer.price);
  }

  return null;
}

function paidAtFromInvoice(stripeInvoice) {
  const paidAt = Number(stripeInvoice?.status_transitions?.paid_at);

  if (Number.isFinite(paidAt) && paidAt > 0) {
    return new Date(paidAt * 1000);
  }

  return new Date();
}

function ensureMeta(booking) {
  const meta = asObj(booking?.meta);
  booking.meta = meta;
  return meta;
}

function ensureRecurringList(meta) {
  const list = asList(meta.weeklyRecurringInvoices);
  meta.weeklyRecurringInvoices = list;
  return list;
}

function hasStripeInvoice(meta, stripeInvoiceId) {
  return ensureRecurringList(meta).some(
    (item) => safeText(item?.stripeInvoiceId) === stripeInvoiceId,
  );
}

async function createRecurringInvoiceIdentity({ ownerId, offer, invoiceDate }) {
  const providerId = String(ownerId || "1").trim() || "1";
  const code = (offer && typeCodeFromOffer(offer)) || "FO";
  const year = yearFrom(invoiceDate);
  const seq = await nextSequence(`invoice:${code}:${year}`);

  return {
    invoiceNo: normalizeInvoiceNo(formatNumber(providerId, code, year, seq)),
    invoiceDate,
  };
}

function buildRecurringMetaEntry({
  stripeInvoice,
  stripeSubscriptionId,
  invoiceNo,
  invoiceDate,
  amount,
  billingMonth,
  billingMonthLabel,
  periodStart,
  periodEnd,
}) {
  return {
    stripeInvoiceId: safeText(stripeInvoice?.id),
    stripePaymentIntentId: safeText(stripeInvoice?.payment_intent),
    stripeSubscriptionId: safeText(stripeSubscriptionId),
    stripeBillingReason: safeText(stripeInvoice?.billing_reason),
    number: invoiceNo,
    date: invoiceDate,
    amount,
    billingMonth,
    billingMonthLabel,
    periodStart,
    periodEnd,
    currency: safeText(stripeInvoice?.currency || "EUR").toUpperCase(),
    createdAt: new Date().toISOString(),
    mailSentAt: "",
  };
}

// function buildRecurringMetaEntry({
//   stripeInvoice,
//   invoiceNo,
//   invoiceDate,
//   amount,
//   billingMonth,
//   billingMonthLabel,
//   periodStart,
//   periodEnd,
// }) {
//   return {
//     stripeInvoiceId: safeText(stripeInvoice?.id),
//     stripePaymentIntentId: safeText(stripeInvoice?.payment_intent),
//     //stripeSubscriptionId: safeText(stripeInvoice?.subscription),

//     stripeSubscriptionId,
//     stripeBillingReason: safeText(stripeInvoice?.billing_reason),
//     number: invoiceNo,
//     date: invoiceDate,
//     amount,
//     billingMonth,
//     billingMonthLabel,
//     periodStart,
//     periodEnd,
//     currency: safeText(stripeInvoice?.currency || "EUR").toUpperCase(),
//     createdAt: new Date().toISOString(),
//     mailSentAt: "",
//   };
// }

function updateCustomerInvoiceRefs({
  ref,
  offer,
  booking,
  stripeInvoice,
  invoiceNo,
  invoiceDate,
  amount,
  billingMonth,
  billingMonthLabel,
  periodStart,
  periodEnd,
}) {
  ref.currency = ref.currency || "EUR";
  ref.offerTitle =
    ref.offerTitle ||
    offer?.title ||
    offer?.sub_type ||
    booking.offerTitle ||
    "";
  ref.offerType =
    ref.offerType || offer?.sub_type || offer?.type || booking.offerType || "";
  ref.venue = ref.venue || resolveVenue(offer, booking);

  if (!Array.isArray(ref.invoiceRefs)) ref.invoiceRefs = [];

  const stripeInvoiceId = safeText(stripeInvoice?.id);
  const exists = ref.invoiceRefs.some(
    (item) => safeText(item?.stripeInvoiceId) === stripeInvoiceId,
  );

  if (exists) return;

  ref.invoiceRefs.push({
    number: invoiceNo,
    date: invoiceDate,
    amount,
    billingMonth,
    billingMonthLabel,
    periodStart,
    periodEnd,
    stripeInvoiceId,
    note: "Weekly Monthly Invoice",
    basePrice: amount,
    siblingDiscount: 0,
    memberDiscount: 0,
    totalDiscount: 0,
    finalPrice: amount,
  });
}

function buildPdfBookingSnapshot({
  booking,
  invoiceNo,
  invoiceDate,
  amount,
  periodStart,
}) {
  const raw = booking?.toObject ? booking.toObject() : { ...booking };
  const meta = asObj(raw.meta);

  return {
    ...raw,
    invoiceNumber: invoiceNo,
    invoiceNo,
    invoiceDate,
    date: periodStart || invoiceDate,
    priceAtBooking: amount,
    meta: {
      ...meta,
    },
  };
}

async function buildPdfSafe({
  customer,
  booking,
  offer,
  invoiceNo,
  invoiceDate,
  amount,
  billingMonth,
  billingMonthLabel,
  periodStart,
  periodEnd,
}) {
  try {
    if (typeof buildWeeklyRecurringInvoicePdf !== "function") {
      console.error(
        "[weeklyRecurringInvoice] missing buildWeeklyRecurringInvoicePdf export",
      );
      return null;
    }

    const pdfBooking = buildPdfBookingSnapshot({
      booking,
      invoiceNo,
      invoiceDate,
      amount,
      periodStart,
    });

    const periodStartDisplay = displayPeriodStart(periodStart);
    const periodEndDisplay = displayPeriodEnd(periodEnd);

    return await buildWeeklyRecurringInvoicePdf({
      customer,
      booking: pdfBooking,
      offer,
      invoiceNo,
      invoiceDate,
      amount,
      billingMonth,
      billingMonthLabel,
      periodStart: toIso(periodStart),
      periodEnd: toIso(periodEnd),
      periodStartDisplay: toIso(periodStartDisplay),
      periodEndDisplay: toIso(periodEndDisplay),
      venue: resolveVenue(offer, booking),
    });
  } catch (e) {
    console.error(
      "[weeklyRecurringInvoice] buildWeeklyRecurringInvoicePdf failed:",
      e?.message || e,
    );
    return null;
  }
}

async function sendRecurringInvoiceMail({
  to,
  customer,
  booking,
  offer,
  pdfBuffer,
  invoiceNo,
  invoiceDate,
  billingMonthLabel,
  periodStart,
  periodEnd,
  amount,
}) {
  if (!to || !pdfBuffer) {
    console.log("[weeklyRecurringInvoice] skip mail", {
      to,
      hasPdf: !!pdfBuffer,
    });
    return false;
  }

  const brand = getBrandAndLogo();
  const effectiveCustomer = bookingParentSnapshot(customer, booking, to);
  const parent = effectiveCustomer.parent || {};
  const greetingName =
    [parent.firstName, parent.lastName].filter(Boolean).join(" ").trim() ||
    "Kunde";

  const childFull =
    safeText(booking?.childName) ||
    [safeText(booking?.childFirstName), safeText(booking?.childLastName)]
      .filter(Boolean)
      .join(" ")
      .trim();

  const course =
    booking?.offerTitle ||
    booking?.offerType ||
    offer?.title ||
    offer?.sub_type ||
    offer?.type ||
    "Weekly";

  const periodStartDisplay = displayPeriodStart(periodStart);
  const periodEndDisplay = displayPeriodEnd(periodEnd);

  const invoice = {
    number: invoiceNo,
    dateDE: toDe(invoiceDate),
    billingMonthLabel,
    periodStartDisplayDE: toDe(periodStartDisplay),
    periodEndDisplayDE: toDe(periodEndDisplay),
    amountText: eur(amount),
  };

  const html = renderMjmlFile(
    "templates/emails/weekly-recurring-invoice.mjml",
    {
      brand,
      greetingName,
      booking: {
        offer: course,
        childFull,
        dayTimes:
          booking?.dayTimes || booking?.kurstag || booking?.weekday || "",
        timeDisplay:
          booking?.timeDisplay ||
          booking?.kurszeit ||
          booking?.time ||
          booking?.uhrzeit ||
          "",
        venue: resolveVenue(offer, booking),
      },
      invoice,
      signature: {
        signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
        name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
      },
    },
  );

  await sendMail({
    to,
    subject: invoiceNo ? `Monatsrechnung – ${invoiceNo}` : "Monatsrechnung",
    text: "",
    html,
    attachments: [
      {
        filename: invoiceNo
          ? `Monatsrechnung-${invoiceNo}.pdf`
          : "Monatsrechnung.pdf",
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });

  return true;
}

function archiveRootDir() {
  return path.join(process.cwd(), "uploads", "billingdocuments");
}

function monthFolder(value) {
  const d = toDate(value) || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function safeFilePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim()
    .slice(0, 120);
}

function recurringInvoiceFileName(invoiceNo, invoiceDate) {
  const datePart = toIso(invoiceDate).slice(0, 10) || "undated";
  const noPart = safeFilePart(invoiceNo || "invoice");
  return `rechnung-${noPart}-${datePart}.pdf`;
}

async function archiveRecurringInvoicePdf({
  ownerId,
  booking,
  customer,
  stripeInvoice,
  invoiceNo,
  invoiceDate,
  pdfBuffer,
}) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) return null;

  const ownerStr = safeText(ownerId);
  const folder = path.join(
    archiveRootDir(),
    ownerStr,
    monthFolder(invoiceDate),
  );
  await fs.mkdir(folder, { recursive: true });

  const fileName = recurringInvoiceFileName(invoiceNo, invoiceDate);
  const absPath = path.join(folder, fileName);

  await fs.writeFile(absPath, pdfBuffer);

  return BillingDocument.create({
    owner: ownerStr,
    kind: "invoice",
    category: "billing",
    mimeType: "application/pdf",
    fileName,
    filePath: absPath,
    fileSize: Buffer.byteLength(pdfBuffer),
    bookingId: booking?._id || null,
    customerId: customer?._id || null,
    customerNo: safeText(customer?.userId),
    invoiceNo: safeText(invoiceNo),
    invoiceDate: toDate(invoiceDate),
    offerTitle: pickFirst(
      booking?.offerTitle,
      booking?.offerType,
      stripeInvoice?.description,
    ),
    subject: "Weekly Monthly Invoice",
    sentAt: new Date(),
    dueAt: null,
    searchText: [
      "invoice",
      safeText(invoiceNo),
      safeText(customer?.userId),
      safeText(booking?.offerTitle),
      safeText(booking?.offerType),
      safeText(customer?.parent?.firstName),
      safeText(customer?.parent?.lastName),
      safeText(customer?.parent?.email),
      safeText(booking?.childFirstName),
      safeText(booking?.childLastName),
    ]
      .filter(Boolean)
      .join(" "),
    createdBy: ownerStr,
  });
}

async function createWeeklyRecurringInvoiceForBooking({
  ownerId,
  offer,
  booking,
  stripeInvoice,
}) {
  // console.log("[weeklyRecurringInvoice] enter", {
  //   bookingId: String(booking?._id || ""),
  //   ownerId,
  //   hasOffer: !!offer,
  //   hasBooking: !!booking,
  //   hasStripeInvoice: !!stripeInvoice,
  //   stripeInvoiceId: safeText(stripeInvoice?.id),
  //   subscription: safeText(stripeInvoice?.subscription),
  //   billingReason: safeText(stripeInvoice?.billing_reason),
  //   offerCategory: safeText(offer?.category),
  //   offerType: safeText(offer?.type),
  //   bookingOfferType: safeText(booking?.offerType),
  // });

  if (!ownerId || !offer || !booking || !stripeInvoice) {
    console.log("[weeklyRecurringInvoice] skip: missing input");
    return null;
  }

  if (!isWeeklyOffer(offer, booking)) {
    console.log("[weeklyRecurringInvoice] skip: not weekly");
    return null;
  }

  //   if (!safeText(stripeInvoice?.subscription)) {
  //     console.log("[weeklyRecurringInvoice] skip: missing subscription");
  //     return null;
  //   }

  const stripeSubscriptionId =
    safeText(stripeInvoice?.subscription) ||
    safeText(booking?.stripe?.subscriptionId);

  if (!stripeSubscriptionId) {
    console.log("[weeklyRecurringInvoice] skip: missing subscription", {
      invoiceSubscription: safeText(stripeInvoice?.subscription),
      bookingSubscription: safeText(booking?.stripe?.subscriptionId),
    });
    return null;
  }

  if (!isRecurringStripeInvoice(stripeInvoice)) {
    console.log("[weeklyRecurringInvoice] skip: not recurring billing reason", {
      billingReason: safeText(stripeInvoice?.billing_reason),
    });
    return null;
  }

  const stripeInvoiceId = safeText(stripeInvoice?.id);
  if (!stripeInvoiceId) {
    console.log("[weeklyRecurringInvoice] skip: missing stripe invoice id");
    return null;
  }

  const meta = ensureMeta(booking);
  if (hasStripeInvoice(meta, stripeInvoiceId)) {
    console.log("[weeklyRecurringInvoice] skip: already processed", {
      stripeInvoiceId,
    });
    return null;
  }

  const customer = await findCustomerByBooking(ownerId, booking);
  if (!customer) {
    console.log("[weeklyRecurringInvoice] skip: no customer found", {
      bookingId: String(booking?._id || ""),
      customerId: String(booking?.customerId || ""),
    });
    return null;
  }

  const ref = ensureCustomerBookingRef(customer, offer, booking);
  const { periodStart, periodEnd } = stripePeriod(stripeInvoice);
  const billingMonth = toMonthKey(
    periodStart || paidAtFromInvoice(stripeInvoice),
  );
  const billingMonthLabel = toMonthLabel(
    periodStart || paidAtFromInvoice(stripeInvoice),
  );
  const amount = recurringAmount(stripeInvoice, booking, offer);
  const invoiceDate = paidAtFromInvoice(stripeInvoice);

  const { invoiceNo } = await createRecurringInvoiceIdentity({
    ownerId,
    offer,
    invoiceDate,
  });

  const entry = buildRecurringMetaEntry({
    stripeInvoice,
    stripeSubscriptionId,
    invoiceNo,
    invoiceDate,
    amount,
    billingMonth,
    billingMonthLabel,
    periodStart: toIso(periodStart),
    periodEnd: toIso(periodEnd),
  });

  entry.billingDocumentId = "";
  entry.fileName = "";
  entry.filePath = "";

  ensureRecurringList(meta).push(entry);
  booking.markModified("meta");
  await booking.save();

  console.log("[weeklyRecurringInvoice] saved booking meta", {
    bookingId: String(booking?._id || ""),
    invoiceNo,
    stripeInvoiceId,
    billingMonth,
  });

  updateCustomerInvoiceRefs({
    ref,
    offer,
    booking,
    stripeInvoice,
    invoiceNo,
    invoiceDate,
    amount,
    billingMonth,
    billingMonthLabel,
    periodStart: toIso(periodStart),
    periodEnd: toIso(periodEnd),
  });

  await customer.save();

  console.log("[weeklyRecurringInvoice] saved customer ref", {
    bookingId: String(booking?._id || ""),
    invoiceNo,
    stripeInvoiceId,
  });

  const pdfBuffer = await buildPdfSafe({
    customer,
    booking,
    offer,
    invoiceNo,
    invoiceDate,
    amount,
    billingMonth,
    billingMonthLabel,
    periodStart,
    periodEnd,
  });

  let archivedDocument = null;

  if (pdfBuffer) {
    archivedDocument = await archiveRecurringInvoicePdf({
      ownerId,
      booking,
      customer,
      stripeInvoice,
      invoiceNo,
      invoiceDate,
      pdfBuffer,
    });

    if (archivedDocument) {
      entry.billingDocumentId = String(archivedDocument._id || "");
      entry.fileName = safeText(archivedDocument.fileName);
      entry.filePath = safeText(archivedDocument.filePath);
      booking.markModified("meta");
      await booking.save();
    }

    console.log("[weeklyRecurringInvoice] archived billing document", {
      bookingId: String(booking?._id || ""),
      invoiceNo,
      documentId: String(archivedDocument?._id || ""),
      fileName: archivedDocument?.fileName || "",
    });
  }

  const to = bookingRecipientEmail(booking, customer);
  const sent = await sendRecurringInvoiceMail({
    to,
    customer,
    booking,
    offer,
    pdfBuffer,
    invoiceNo,
    invoiceDate,
    billingMonthLabel,
    periodStart,
    periodEnd,
    amount,
  });

  if (sent) {
    entry.mailSentAt = new Date().toISOString();
    booking.markModified("meta");
    await booking.save();
  }

  console.log("[weeklyRecurringInvoice] done", {
    bookingId: String(booking?._id || ""),
    invoiceNo,
    stripeInvoiceId,
    mailSent: sent,
  });

  return entry;
}

module.exports = { createWeeklyRecurringInvoiceForBooking };

// //utils\weeklyRecurringInvoices.js
// "use strict";

// const Customer = require("../models/Customer");
// const { renderMjmlFile } = require("./mjmlRenderer");
// const { sendMail } = require("./mailer");
// const { buildWeeklyRecurringInvoicePdf } = require("./pdf");
// const { normalizeInvoiceNo } = require("./pdfData");
// const {
//   nextSequence,
//   yearFrom,
//   typeCodeFromOffer,
//   formatNumber,
// } = require("./sequences");

// function safeText(v) {
//   return String(v ?? "").trim();
// }

// function minusOneDay(v) {
//   const d = toDate(v);
//   if (!d) return null;
//   return new Date(d.getTime() - 24 * 60 * 60 * 1000);
// }

// function displayPeriodStart(periodStart) {
//   return toDate(periodStart);
// }

// function displayPeriodEnd(periodEnd) {
//   return minusOneDay(periodEnd);
// }
// function pickFirst(...vals) {
//   for (const v of vals) {
//     const s = safeText(v);
//     if (s) return s;
//   }
//   return "";
// }

// function asObj(v) {
//   return v && typeof v === "object" ? v : {};
// }

// function asList(v) {
//   return Array.isArray(v) ? v : [];
// }

// function toDate(v) {
//   if (!v) return null;
//   const d = v instanceof Date ? v : new Date(v);
//   return Number.isNaN(d.getTime()) ? null : d;
// }

// function toIso(v) {
//   const d = toDate(v);
//   return d ? d.toISOString() : "";
// }

// function toMonthKey(v) {
//   const d = toDate(v);
//   if (!d) return "";
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, "0");
//   return `${y}-${m}`;
// }

// function toMonthLabel(v) {
//   const d = toDate(v);
//   if (!d) return "";
//   return new Intl.DateTimeFormat("de-DE", {
//     month: "long",
//     year: "numeric",
//   }).format(d);
// }

// function toDe(v) {
//   const d = toDate(v);
//   return d ? new Intl.DateTimeFormat("de-DE").format(d) : "";
// }

// function eur(v, currency = "EUR") {
//   const n = Number(v);
//   if (!Number.isFinite(n)) return "";
//   return new Intl.NumberFormat("de-DE", {
//     style: "currency",
//     currency,
//   }).format(n);
// }

// function getBrandAndLogo() {
//   return {
//     company: process.env.BRAND_COMPANY || "Münchner Fussball Schule NRW",
//     addr1: process.env.BRAND_ADDR_LINE1 || "Hochfelder Str. 33",
//     addr2: process.env.BRAND_ADDR_LINE2 || "47226 Duisburg",
//     email: process.env.BRAND_EMAIL || "info@muenchner-fussball-schule.ruhr",
//     website:
//       process.env.BRAND_WEBSITE_URL ||
//       "https://www.muenchner-fussball-schule.ruhr",
//     logoUrl: process.env.BRAND_LOGO_URL || "",
//   };
// }

// function bookingRecipientEmail(booking, customer) {
//   return pickFirst(
//     booking?.invoiceTo?.parent?.email,
//     booking?.email,
//     customer?.parent?.email,
//     customer?.email,
//   ).toLowerCase();
// }

// function bookingParentSnapshot(customer, booking, recipientEmail) {
//   const bookingParent = asObj(booking?.invoiceTo?.parent);
//   const customerParent = asObj(customer?.parent);

//   return {
//     ...customer,
//     parent: {
//       salutation: pickFirst(
//         bookingParent.salutation,
//         customerParent.salutation,
//       ),
//       firstName: pickFirst(bookingParent.firstName, customerParent.firstName),
//       lastName: pickFirst(bookingParent.lastName, customerParent.lastName),
//       email: recipientEmail,
//       phone: pickFirst(bookingParent.phone, customerParent.phone),
//       phone2: pickFirst(bookingParent.phone2, customerParent.phone2),
//     },
//     email: recipientEmail,
//     emailLower: recipientEmail,
//   };
// }

// async function findCustomerByBooking(ownerId, booking) {
//   const byRef = await Customer.findOne({
//     owner: ownerId,
//     "bookings.bookingId": booking._id,
//   });

//   if (byRef) return byRef;
//   if (!booking?.customerId) return null;

//   return Customer.findOne({
//     owner: ownerId,
//     _id: booking.customerId,
//   });
// }

// function parseBookingDate(booking) {
//   const d = booking?.date
//     ? new Date(booking.date)
//     : booking?.createdAt || new Date();

//   return Number.isNaN(d.getTime()) ? null : d;
// }

// function resolveVenue(offer, booking) {
//   if (safeText(booking?.venue)) return booking.venue;
//   if (typeof offer?.location === "string") return offer.location;
//   return offer?.location?.name || offer?.location?.title || "";
// }

// function ensureCustomerBookingRef(customer, offer, booking) {
//   let ref = customer.bookings.find(
//     (item) => String(item.bookingId) === String(booking._id),
//   );

//   if (ref) return ref;

//   customer.bookings.push({
//     bookingId: booking._id,
//     offerId: offer?._id || booking.offerId,
//     offerTitle:
//       offer?.title ||
//       offer?.sub_type ||
//       offer?.type ||
//       booking.offerTitle ||
//       "",
//     offerType: offer?.sub_type || offer?.type || booking.offerType || "",
//     venue: resolveVenue(offer, booking),
//     date: parseBookingDate(booking),
//     status: "active",
//     priceAtBooking:
//       typeof booking?.priceMonthly === "number"
//         ? booking.priceMonthly
//         : typeof offer?.price === "number"
//           ? offer.price
//           : null,
//   });

//   return customer.bookings[customer.bookings.length - 1];
// }

// function isWeeklyOffer(offer, booking) {
//   const category = safeText(offer?.category);
//   const offerType = safeText(offer?.type);
//   const bookingType = safeText(booking?.offerType);

//   return (
//     category === "Weekly" ||
//     offerType === "Foerdertraining" ||
//     offerType === "Kindergarten" ||
//     bookingType === "Foerdertraining" ||
//     bookingType === "Kindergarten"
//   );
// }

// function isRecurringStripeInvoice(stripeInvoice) {
//   return safeText(stripeInvoice?.billing_reason) === "subscription_cycle";
// }

// function stripePeriod(stripeInvoice) {
//   const line = stripeInvoice?.lines?.data?.[0];
//   const start = Number(line?.period?.start);
//   const end = Number(line?.period?.end);

//   return {
//     periodStart: Number.isFinite(start) ? new Date(start * 1000) : null,
//     periodEnd: Number.isFinite(end) ? new Date(end * 1000) : null,
//   };
// }

// function recurringAmount(stripeInvoice, booking, offer) {
//   const paid = Number(stripeInvoice?.amount_paid);

//   if (Number.isFinite(paid) && paid > 0) {
//     return Math.round(paid) / 100;
//   }

//   if (typeof booking?.priceMonthly === "number") {
//     return Number(booking.priceMonthly);
//   }

//   if (typeof offer?.price === "number") {
//     return Number(offer.price);
//   }

//   return null;
// }

// function paidAtFromInvoice(stripeInvoice) {
//   const paidAt = Number(stripeInvoice?.status_transitions?.paid_at);

//   if (Number.isFinite(paidAt) && paidAt > 0) {
//     return new Date(paidAt * 1000);
//   }

//   return new Date();
// }

// function ensureMeta(booking) {
//   const meta = asObj(booking?.meta);
//   booking.meta = meta;
//   return meta;
// }

// function ensureRecurringList(meta) {
//   const list = asList(meta.weeklyRecurringInvoices);
//   meta.weeklyRecurringInvoices = list;
//   return list;
// }

// function hasStripeInvoice(meta, stripeInvoiceId) {
//   return ensureRecurringList(meta).some(
//     (item) => safeText(item?.stripeInvoiceId) === stripeInvoiceId,
//   );
// }

// async function createRecurringInvoiceIdentity({ ownerId, offer, invoiceDate }) {
//   const providerId = String(ownerId || "1").trim() || "1";
//   const code = (offer && typeCodeFromOffer(offer)) || "FO";
//   const year = yearFrom(invoiceDate);
//   const seq = await nextSequence(`invoice:${code}:${year}`);

//   return {
//     invoiceNo: normalizeInvoiceNo(formatNumber(providerId, code, year, seq)),
//     invoiceDate,
//   };
// }

// function buildRecurringMetaEntry({
//   stripeInvoice,
//   invoiceNo,
//   invoiceDate,
//   amount,
//   billingMonth,
//   billingMonthLabel,
//   periodStart,
//   periodEnd,
// }) {
//   return {
//     stripeInvoiceId: safeText(stripeInvoice?.id),
//     stripePaymentIntentId: safeText(stripeInvoice?.payment_intent),
//     stripeSubscriptionId: safeText(stripeInvoice?.subscription),
//     stripeBillingReason: safeText(stripeInvoice?.billing_reason),
//     number: invoiceNo,
//     date: invoiceDate,
//     amount,
//     billingMonth,
//     billingMonthLabel,
//     periodStart,
//     periodEnd,
//     currency: safeText(stripeInvoice?.currency || "EUR").toUpperCase(),
//     createdAt: new Date().toISOString(),
//     mailSentAt: "",
//   };
// }

// function updateCustomerInvoiceRefs({
//   ref,
//   offer,
//   booking,
//   stripeInvoice,
//   invoiceNo,
//   invoiceDate,
//   amount,
//   billingMonth,
//   billingMonthLabel,
//   periodStart,
//   periodEnd,
// }) {
//   ref.currency = ref.currency || "EUR";
//   ref.offerTitle =
//     ref.offerTitle ||
//     offer?.title ||
//     offer?.sub_type ||
//     booking.offerTitle ||
//     "";
//   ref.offerType =
//     ref.offerType || offer?.sub_type || offer?.type || booking.offerType || "";
//   ref.venue = ref.venue || resolveVenue(offer, booking);

//   if (!Array.isArray(ref.invoiceRefs)) ref.invoiceRefs = [];

//   const stripeInvoiceId = safeText(stripeInvoice?.id);
//   const exists = ref.invoiceRefs.some(
//     (item) => safeText(item?.stripeInvoiceId) === stripeInvoiceId,
//   );

//   if (exists) return;

//   ref.invoiceRefs.push({
//     number: invoiceNo,
//     date: invoiceDate,
//     amount,
//     billingMonth,
//     billingMonthLabel,
//     periodStart,
//     periodEnd,
//     stripeInvoiceId,
//     note: "Weekly Monthly Invoice",
//     basePrice: amount,
//     siblingDiscount: 0,
//     memberDiscount: 0,
//     totalDiscount: 0,
//     finalPrice: amount,
//   });
// }

// function buildPdfBookingSnapshot({
//   booking,
//   invoiceNo,
//   invoiceDate,
//   amount,
//   periodStart,
// }) {
//   const raw = booking?.toObject ? booking.toObject() : { ...booking };
//   const meta = asObj(raw.meta);

//   return {
//     ...raw,
//     invoiceNumber: invoiceNo,
//     invoiceNo,
//     invoiceDate,
//     date: periodStart || invoiceDate,
//     priceAtBooking: amount,
//     meta: {
//       ...meta,
//     },
//   };
// }

// async function buildPdfSafe({
//   customer,
//   booking,
//   offer,
//   invoiceNo,
//   invoiceDate,
//   amount,
//   billingMonth,
//   billingMonthLabel,
//   periodStart,
//   periodEnd,
// }) {
//   try {
//     const pdfBooking = buildPdfBookingSnapshot({
//       booking,
//       invoiceNo,
//       invoiceDate,
//       amount,
//       periodStart,
//     });

//     const periodStartDisplay = displayPeriodStart(periodStart);
//     const periodEndDisplay = displayPeriodEnd(periodEnd);

//     return await buildWeeklyRecurringInvoicePdf({
//       customer,
//       booking: pdfBooking,
//       offer,
//       invoiceNo,
//       invoiceDate,
//       amount,
//       billingMonth,
//       billingMonthLabel,
//       periodStart: toIso(periodStart),
//       periodEnd: toIso(periodEnd),
//       periodStartDisplay: toIso(periodStartDisplay),
//       periodEndDisplay: toIso(periodEndDisplay),
//       venue: resolveVenue(offer, booking),
//     });
//   } catch (e) {
//     console.error(
//       "[weeklyRecurringInvoice] buildWeeklyRecurringInvoicePdf failed:",
//       e?.message || e,
//     );
//     return null;
//   }
// }

// async function sendRecurringInvoiceMail({
//   to,
//   customer,
//   booking,
//   offer,
//   pdfBuffer,
//   invoiceNo,
//   invoiceDate,
//   billingMonthLabel,
//   periodStart,
//   periodEnd,
//   amount,
// }) {
//   if (!to || !pdfBuffer) return false;

//   const brand = getBrandAndLogo();
//   const effectiveCustomer = bookingParentSnapshot(customer, booking, to);
//   const parent = effectiveCustomer.parent || {};
//   const greetingName =
//     [parent.firstName, parent.lastName].filter(Boolean).join(" ").trim() ||
//     "Kunde";

//   const childFull =
//     safeText(booking?.childName) ||
//     [safeText(booking?.childFirstName), safeText(booking?.childLastName)]
//       .filter(Boolean)
//       .join(" ")
//       .trim();

//   const course =
//     booking?.offerTitle ||
//     booking?.offerType ||
//     offer?.title ||
//     offer?.sub_type ||
//     offer?.type ||
//     "Weekly";

//   const periodStartDisplay = displayPeriodStart(periodStart);
//   const periodEndDisplay = displayPeriodEnd(periodEnd);

//   const invoice = {
//     number: invoiceNo,
//     dateDE: toDe(invoiceDate),
//     billingMonthLabel,
//     periodStartDE: toDe(periodStartDisplay),
//     periodEndDE: toDe(periodEndDisplay),
//     amountText: eur(amount),
//   };

//   const html = renderMjmlFile(
//     "templates/emails/weekly-recurring-invoice.mjml",
//     {
//       brand,
//       greetingName,
//       booking: {
//         offer: course,
//         childFull,
//         dayTimes:
//           booking?.dayTimes || booking?.kurstag || booking?.weekday || "",
//         timeDisplay:
//           booking?.timeDisplay ||
//           booking?.kurszeit ||
//           booking?.time ||
//           booking?.uhrzeit ||
//           "",
//         venue: resolveVenue(offer, booking),
//       },
//       invoice,
//       signature: {
//         signoff: process.env.MAIL_SIGNOFF || "Mit sportlichen Grüßen",
//         name: process.env.MAIL_SIGNER || "Selcuk Kocyigit",
//       },
//     },
//   );

//   await sendMail({
//     to,
//     subject: invoiceNo ? `Monatsrechnung – ${invoiceNo}` : "Monatsrechnung",
//     text: "",
//     html,
//     attachments: [
//       {
//         filename: invoiceNo
//           ? `Monatsrechnung-${invoiceNo}.pdf`
//           : "Monatsrechnung.pdf",
//         content: pdfBuffer,
//         contentType: "application/pdf",
//       },
//     ],
//   });

//   return true;
// }

// async function createWeeklyRecurringInvoiceForBooking({
//   ownerId,
//   offer,
//   booking,
//   stripeInvoice,
// }) {
//   if (!ownerId || !offer || !booking || !stripeInvoice) return null;
//   if (!isWeeklyOffer(offer, booking)) return null;
//   if (!safeText(stripeInvoice?.subscription)) return null;
//   if (!isRecurringStripeInvoice(stripeInvoice)) return null;

//   const stripeInvoiceId = safeText(stripeInvoice?.id);
//   if (!stripeInvoiceId) return null;

//   const meta = ensureMeta(booking);
//   if (hasStripeInvoice(meta, stripeInvoiceId)) return null;

//   const customer = await findCustomerByBooking(ownerId, booking);
//   if (!customer) {
//     console.warn(
//       "[weeklyRecurringInvoice] no customer found for booking",
//       String(booking._id),
//     );
//     return null;
//   }

//   const ref = ensureCustomerBookingRef(customer, offer, booking);
//   const { periodStart, periodEnd } = stripePeriod(stripeInvoice);
//   const billingMonth = toMonthKey(
//     periodStart || paidAtFromInvoice(stripeInvoice),
//   );
//   const billingMonthLabel = toMonthLabel(
//     periodStart || paidAtFromInvoice(stripeInvoice),
//   );
//   const amount = recurringAmount(stripeInvoice, booking, offer);
//   const invoiceDate = paidAtFromInvoice(stripeInvoice);

//   const { invoiceNo } = await createRecurringInvoiceIdentity({
//     ownerId,
//     offer,
//     invoiceDate,
//   });

//   const entry = buildRecurringMetaEntry({
//     stripeInvoice,
//     invoiceNo,
//     invoiceDate,
//     amount,
//     billingMonth,
//     billingMonthLabel,
//     periodStart: toIso(periodStart),
//     periodEnd: toIso(periodEnd),
//   });

//   ensureRecurringList(meta).push(entry);
//   booking.markModified("meta");
//   await booking.save();

//   updateCustomerInvoiceRefs({
//     ref,
//     offer,
//     booking,
//     stripeInvoice,
//     invoiceNo,
//     invoiceDate,
//     amount,
//     billingMonth,
//     billingMonthLabel,
//     periodStart: toIso(periodStart),
//     periodEnd: toIso(periodEnd),
//   });

//   await customer.save();

//   const pdfBuffer = await buildPdfSafe({
//     customer,
//     booking,
//     offer,
//     invoiceNo,
//     invoiceDate,
//     amount,
//     billingMonth,
//     billingMonthLabel,
//     periodStart,
//     periodEnd,
//   });

//   const to = bookingRecipientEmail(booking, customer);
//   const sent = await sendRecurringInvoiceMail({
//     to,
//     customer,
//     booking,
//     offer,
//     pdfBuffer,
//     invoiceNo,
//     invoiceDate,
//     billingMonthLabel,
//     periodStart,
//     periodEnd,
//     amount,
//   });

//   if (sent) {
//     entry.mailSentAt = new Date().toISOString();
//     booking.markModified("meta");
//     await booking.save();
//   }

//   return entry;
// }

// module.exports = { createWeeklyRecurringInvoiceForBooking };
