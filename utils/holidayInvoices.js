//utils\holidayInvoices.js
"use strict";

const Customer = require("../models/Customer");
const Booking = require("../models/Booking");

const { buildParticipationPdf } = require("./pdf");
const { sendParticipationEmail } = require("./mailer");
const { normalizeInvoiceNo } = require("./pdfData");

function asObj(v) {
  return v && typeof v === "object" ? v : {};
}

function pickFirst(...vals) {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function bookingRecipientEmail(booking, customer) {
  return (
    pickFirst(
      booking?.invoiceTo?.parent?.email,
      booking?.email,
      customer?.parent?.email,
      customer?.email,
    ).toLowerCase() || ""
  );
}

function bookingCustomerSnapshot(customer, booking, recipientEmail) {
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

function lineValue(message, label) {
  const text = String(message || "");
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`(?:^|\\n)${escaped}\\s*:\\s*(.+)`, "i");
  const m = text.match(rx);
  return m && m[1] ? String(m[1]).trim() : "";
}

function parseBillingFromMessage(message) {
  const contact = lineValue(message, "Kontakt");
  const address = lineValue(message, "Adresse");
  const phone = lineValue(message, "Telefon");

  let salutation = "";
  let firstName = "";
  let lastName = "";

  if (contact) {
    const parts = contact.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === "Frau" || parts[0] === "Herr") {
      salutation = parts.shift() || "";
    }
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ");
  }

  let street = "";
  let houseNo = "";
  let zip = "";
  let city = "";

  if (address) {
    const [left, right] = String(address).split(",");
    const leftParts = String(left || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (leftParts.length > 1) {
      houseNo = leftParts.pop() || "";
      street = leftParts.join(" ");
    } else if (leftParts.length === 1) {
      street = leftParts[0];
    }

    const rightParts = String(right || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (rightParts.length) {
      zip = rightParts.shift() || "";
      city = rightParts.join(" ");
    }
  }

  return {
    salutation,
    firstName,
    lastName,
    phone,
    street,
    houseNo,
    zip,
    city,
  };
}

function mapWpBilling(payload) {
  const p = asObj(payload);
  const billing = asObj(p.billing || p.customer || p.parent || p.invoice);
  const addr = asObj(billing.address || billing.billing_address || billing);

  return {
    salutation: pickFirst(billing.salutation, billing.title, p.salutation),
    firstName: pickFirst(
      billing.firstName,
      billing.first_name,
      p.parentFirst,
      p.parentFirstName,
    ),
    lastName: pickFirst(
      billing.lastName,
      billing.last_name,
      p.parentLast,
      p.parentLastName,
    ),
    email: pickFirst(billing.email, p.parentEmail, p.email),
    phone: pickFirst(billing.phone, billing.phone_number, p.phone, p.phone2),
    phone2: pickFirst(billing.phone2, p.phone2),
    street: pickFirst(addr.street, addr.address_1, p.street, p.address1),
    houseNo: pickFirst(
      addr.houseNo,
      addr.house_no,
      addr.houseNumber,
      addr.house_number,
      p.houseNo,
      p.houseNumber,
    ),
    zip: pickFirst(addr.zip, addr.postcode, p.zip, p.plz),
    city: pickFirst(addr.city, p.city, p.stadt),
  };
}

function resolveBilling({ payload, booking }) {
  const fromPayload = mapWpBilling(payload);
  const fromMessage = parseBillingFromMessage(booking?.message || "");

  return {
    salutation: fromPayload.salutation || fromMessage.salutation || "",
    firstName: fromPayload.firstName || fromMessage.firstName || "",
    lastName: fromPayload.lastName || fromMessage.lastName || "",
    email: fromPayload.email || booking?.email || "",
    phone: fromPayload.phone || fromMessage.phone || "",
    phone2: fromPayload.phone2 || "",
    street: fromPayload.street || fromMessage.street || "",
    houseNo: fromPayload.houseNo || fromMessage.houseNo || "",
    zip: fromPayload.zip || fromMessage.zip || "",
    city: fromPayload.city || fromMessage.city || "",
  };
}

function setIfEmpty(obj, key, val) {
  const cur = String(obj?.[key] ?? "").trim();
  const next = String(val ?? "").trim();
  if (!cur && next) {
    obj[key] = next;
    return true;
  }
  return false;
}

function applyBillingToCustomer(customer, billing) {
  if (!customer || !billing) return false;

  if (!customer.parent) customer.parent = {};
  if (!customer.address) customer.address = {};

  let changed = false;

  changed =
    setIfEmpty(customer.parent, "salutation", billing.salutation) || changed;
  changed =
    setIfEmpty(customer.parent, "firstName", billing.firstName) || changed;
  changed =
    setIfEmpty(customer.parent, "lastName", billing.lastName) || changed;
  changed = setIfEmpty(customer.parent, "email", billing.email) || changed;
  changed = setIfEmpty(customer.parent, "phone", billing.phone) || changed;
  changed = setIfEmpty(customer.parent, "phone2", billing.phone2) || changed;

  changed = setIfEmpty(customer.address, "street", billing.street) || changed;
  changed = setIfEmpty(customer.address, "houseNo", billing.houseNo) || changed;
  changed = setIfEmpty(customer.address, "zip", billing.zip) || changed;
  changed = setIfEmpty(customer.address, "city", billing.city) || changed;

  if (
    !String(customer.email || "").trim() &&
    String(billing.email || "").trim()
  ) {
    customer.email = String(billing.email).trim();
    changed = true;
  }

  const emailLower = String(customer.email || "")
    .trim()
    .toLowerCase();

  if (emailLower && customer.emailLower !== emailLower) {
    customer.emailLower = emailLower;
    changed = true;
  }

  return changed;
}

async function findCustomerByBooking(ownerId, bookingId) {
  return Customer.findOne({ owner: ownerId, "bookings.bookingId": bookingId });
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

function computeAmount({ booking, ref, offer, alreadyInvoiced }) {
  if (typeof booking.priceAtBooking === "number")
    return Number(booking.priceAtBooking);
  if (typeof ref?.priceAtBooking === "number")
    return Number(ref.priceAtBooking);
  if (alreadyInvoiced) return null;
  if (typeof offer?.price === "number") return Number(offer.price);
  return null;
}

function buildTypeText(offer, booking) {
  return [
    offer?.title,
    offer?.sub_type,
    offer?.type,
    booking.offerTitle,
    booking.offerType,
    booking.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function detectPrefix(text) {
  const isPower =
    text.includes("powertraining") || text.includes("power training");
  const isCamp =
    text.includes("camp") ||
    text.includes("feriencamp") ||
    text.includes("holiday camp");

  if (isPower) return "PW";
  if (isCamp) return "CA";
  return "CA";
}

function yearShortFrom(d) {
  return String(d.getFullYear()).slice(-2);
}

async function findLastInvoice(ownerId, prefix, yearShort) {
  const pat = `^${prefix}-${yearShort}-\\d{4}$`;

  return Booking.findOne({
    owner: ownerId,
    $or: [{ invoiceNumber: { $regex: pat } }, { invoiceNo: { $regex: pat } }],
  })
    .sort({ invoiceDate: -1, createdAt: -1 })
    .lean();
}

function nextSeqFromLast(lastDoc) {
  if (!lastDoc) return 1;
  const candidate = lastDoc.invoiceNumber || lastDoc.invoiceNo || "";
  const m = candidate.match(/-(\d{4})$/);
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) ? n + 1 : 1;
}

async function ensureInvoiceNo({ ownerId, booking, prefix, yearShort }) {
  let rawNo = booking.invoiceNumber || booking.invoiceNo;
  if (rawNo) return normalizeInvoiceNo(rawNo);

  const last = await findLastInvoice(ownerId, prefix, yearShort);
  const seqStr = String(nextSeqFromLast(last)).padStart(4, "0");
  rawNo = `${prefix}-${yearShort}-${seqStr}`;
  return normalizeInvoiceNo(rawNo);
}

async function persistBookingSnapshot({
  booking,
  offer,
  invoiceNo,
  invoiceDate,
  amount,
}) {
  booking.invoiceNumber = invoiceNo;
  booking.invoiceNo = invoiceNo;
  booking.invoiceDate = invoiceDate;

  if (typeof booking.priceAtBooking !== "number" && amount != null) {
    booking.priceAtBooking = amount;
  }

  booking.currency = booking.currency || "EUR";
  booking.offerTitle =
    booking.offerTitle || offer?.title || offer?.sub_type || offer?.type || "";
  booking.offerType = booking.offerType || offer?.sub_type || offer?.type || "";
  booking.venue = booking.venue || offer?.location || "";

  await booking.save();
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
  if (!hasRef) {
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
      note: "Holiday-Programm (Camp/Powertraining)",
    });
  }
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
      "[holidayInvoice] buildParticipationPdf failed:",
      e?.message || e,
    );
    return null;
  }
}

async function sendMailSafe({ booking, customer, offer, pdfBuffer }) {
  try {
    const to = bookingRecipientEmail(booking, customer);
    if (!to) return;

    const effectiveCustomer = bookingCustomerSnapshot(customer, booking, to);

    await sendParticipationEmail({
      to,
      customer: effectiveCustomer,
      booking,
      offer,
      pdfBuffer,
    });
  } catch (e) {
    console.error(
      "[holidayInvoice] sendParticipationEmail failed:",
      e?.message || e,
    );
  }
}

async function createHolidayInvoiceForBooking({
  ownerId,
  offer,
  booking,
  payload,
}) {
  if (!ownerId || !booking) {
    console.warn("[holidayInvoice] missing ownerId or booking");
    return;
  }

  const customer = await findCustomerByBooking(ownerId, booking._id);
  if (!customer) {
    console.warn(
      "[holidayInvoice] no customer found for booking",
      String(booking._id),
    );
    return;
  }

  const billing = resolveBilling({ payload, booking });

  if (!booking.invoiceTo) booking.invoiceTo = {};
  booking.invoiceTo.parent = {
    salutation: billing.salutation || "",
    firstName: billing.firstName || "",
    lastName: billing.lastName || "",
    email: billing.email || booking.email || "",
    phone: billing.phone || "",
    phone2: billing.phone2 || "",
  };
  booking.invoiceTo.address = {
    street: billing.street || "",
    houseNo: billing.houseNo || "",
    zip: billing.zip || "",
    city: billing.city || "",
  };

  // console.log("[holidayInvoice] payload keys:", Object.keys(payload || {}));
  // console.log("[holidayInvoice] billing resolved:", billing);
  // console.log("[holidayInvoice] customer before:", {
  //   parent: customer?.parent,
  //   address: customer?.address,
  // });

  if (applyBillingToCustomer(customer, billing)) {
    try {
      await customer.save();
      console.log("[holidayInvoice] customer after:", {
        parent: customer?.parent,
        address: customer?.address,
      });
    } catch (e) {
      console.warn(
        "[holidayInvoice] customer billing save failed:",
        e?.message || e,
      );
    }
  }

  const ref = ensureCustomerBookingRef(customer, offer, booking);

  const alreadyInvoiced =
    Boolean(booking.invoiceNumber || booking.invoiceNo) ||
    (ref && Array.isArray(ref.invoiceRefs) && ref.invoiceRefs.length > 0);

  const amount = computeAmount({ booking, ref, offer, alreadyInvoiced });

  const now = new Date();
  const text = buildTypeText(offer, booking);
  const prefix = detectPrefix(text);
  const ys = yearShortFrom(now);

  const invoiceNo = await ensureInvoiceNo({
    ownerId,
    booking,
    prefix,
    yearShort: ys,
  });

  const invoiceDate = booking.invoiceDate || now;

  await persistBookingSnapshot({
    booking,
    offer,
    invoiceNo,
    invoiceDate,
    amount,
  });

  if (ref) {
    updateRefSnapshot({ ref, offer, booking, invoiceNo, invoiceDate, amount });
    await customer.save();
  }

  const pdfBuffer = await buildPdfSafe({
    customer,
    booking,
    offer,
    invoiceNo,
    invoiceDate,
  });

  await sendMailSafe({ booking, customer, offer, pdfBuffer });
}

module.exports = { createHolidayInvoiceForBooking };
