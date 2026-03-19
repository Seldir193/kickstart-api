// routes/bookingActions/handlers/creditNotePdfByBookingIdAction.js
"use strict";

const mongoose = require("mongoose");
const Booking = require("../../../models/Booking");
const Customer = require("../../../models/Customer");
const Offer = require("../../../models/Offer");

const { resolveOwner } = require("../../bookings/helpers/owner");
const { buildParticipationPdfHTML } = require("../../../utils/pdfHtml");

function safeText(v) {
  return String(v ?? "").trim();
}

function metaObj(b) {
  return b?.meta && typeof b.meta === "object" ? b.meta : {};
}

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

function isCreditInvoiceRef(ref) {
  const note = safeText(ref?.note).toLowerCase();
  const number = safeText(ref?.number);
  const amount = Number(ref?.amount);

  if (note.includes("gutschrift")) return true;
  if (number.toUpperCase().startsWith("GS")) return true;
  if (Number.isFinite(amount) && amount < 0) return true;
  return false;
}

function findCreditInvoiceRef(bookingLike, wantedNo = "") {
  const refs = Array.isArray(bookingLike?.invoiceRefs)
    ? bookingLike.invoiceRefs
    : [];

  const exact = safeText(wantedNo);
  if (exact) {
    const hit = refs.find((r) => safeText(r?.number) === exact);
    if (hit) return hit;
  }

  return refs.find(isCreditInvoiceRef) || null;
}

function creditAmountAbs(bookingLike, offer, creditRef) {
  const meta = metaObj(bookingLike);

  const n =
    typeof meta.creditNoteAmount === "number"
      ? meta.creditNoteAmount
      : creditRef && Number.isFinite(Number(creditRef.amount))
        ? Number(creditRef.amount)
        : typeof bookingLike?.priceAtBooking === "number"
          ? bookingLike.priceAtBooking
          : typeof offer?.price === "number"
            ? offer.price
            : 0;

  return Math.abs(Math.round(Number(n || 0) * 100) / 100);
}

async function loadOffer(bookingLike) {
  const oid = safeText(bookingLike?.offerId);

  if (oid && mongoose.isValidObjectId(oid)) {
    const doc = await Offer.findById(oid).lean();
    if (doc) return doc;
  }

  return offerLikeFromBooking(bookingLike);
}

async function loadCustomer(ownerStr, booking) {
  const cid = safeText(booking?.customerId);

  if (cid && mongoose.isValidObjectId(cid)) {
    const byId = await Customer.findOne({ _id: cid, owner: ownerStr });
    if (byId) return byId;
  }

  return Customer.findOne({
    owner: ownerStr,
    $or: [
      { "bookings.bookingId": booking._id },
      { "bookings._id": booking._id },
    ],
  });
}

function findCustomerBookingRef(customer, bookingId) {
  const refs = Array.isArray(customer?.bookings) ? customer.bookings : [];

  return (
    refs.find((b) => String(b?.bookingId || "") === String(bookingId || "")) ||
    refs.find((b) => String(b?._id || "") === String(bookingId || "")) ||
    null
  );
}

function mergeBookingData(bookingDoc, customerRef) {
  const docObj = bookingDoc?.toObject
    ? bookingDoc.toObject()
    : bookingDoc || {};
  const refObj = customerRef?.toObject
    ? customerRef.toObject()
    : customerRef || {};

  return {
    ...refObj,
    ...docObj,
    _id: docObj._id || refObj.bookingId || refObj._id,
    offerId: docObj.offerId || refObj.offerId || "",
    offerTitle:
      docObj.offerTitle || refObj.offerTitle || refObj.offerType || "",
    offerType: docObj.offerType || refObj.offerType || "",
    venue: docObj.venue || refObj.venue || "",
    date: docObj.date || refObj.date || docObj.createdAt || refObj.createdAt,
    createdAt: docObj.createdAt || refObj.createdAt || new Date(),
    updatedAt: docObj.updatedAt || refObj.updatedAt || new Date(),
    returnedAt: docObj.returnedAt || refObj.returnedAt || null,
    currency: docObj.currency || refObj.currency || "EUR",
    priceAtBooking:
      docObj.priceAtBooking != null
        ? docObj.priceAtBooking
        : refObj.priceAtBooking != null
          ? refObj.priceAtBooking
          : null,
    invoiceRefs: Array.isArray(refObj.invoiceRefs) ? refObj.invoiceRefs : [],
    meta: {
      ...(refObj.meta && typeof refObj.meta === "object" ? refObj.meta : {}),
      ...(docObj.meta && typeof docObj.meta === "object" ? docObj.meta : {}),
    },
  };
}

async function creditNotePdfByBookingIdAction(req, res) {
  try {
    const owner = resolveOwner(req);
    const ownerStr = safeText(owner);
    const bid = safeText(req.params.bid);

    if (!ownerStr || !mongoose.isValidObjectId(ownerStr)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!mongoose.isValidObjectId(bid)) {
      return res.status(400).json({ error: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: bid, owner: ownerStr });
    if (!booking) {
      const any = await Booking.findById(bid);
      if (!any) return res.status(404).json({ error: "Not Found" });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const customer = await loadCustomer(ownerStr, booking);
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const customerRef = findCustomerBookingRef(customer, booking._id);
    const bookingLike = mergeBookingData(booking, customerRef);
    const meta = metaObj(bookingLike);

    const initialNo = safeText(meta.creditNoteNo);
    const creditRef = findCreditInvoiceRef(bookingLike, initialNo);
    const creditNo = initialNo || safeText(creditRef?.number);

    if (!creditNo) {
      return res.status(404).json({ error: "Credit note not created yet" });
    }

    const offer = await loadOffer(bookingLike);

    const creditDateIso =
      safeText(meta.creditNoteDate) ||
      safeText(creditRef?.date) ||
      (bookingLike.returnedAt
        ? new Date(bookingLike.returnedAt).toISOString()
        : "") ||
      new Date().toISOString();

    const abs = creditAmountAbs(bookingLike, offer, creditRef);
    const currency = String(bookingLike.currency || "EUR");

    const bookingForPdf = {
      ...bookingLike,
      priceAtBooking: -abs,
      currency,
    };

    const buf = await buildParticipationPdfHTML({
      customer: customer.toObject ? customer.toObject() : customer,
      booking: bookingForPdf,
      offer,
      venue:
        bookingForPdf.venue || bookingForPdf.location || offer?.location || "",
      invoiceNo: creditNo,
      invoiceDate: creditDateIso,
      pricing: { currency, monthly: null, firstMonth: null, single: -abs },
      invoice: {
        number: creditNo,
        date: creditDateIso,
        currency,
        monthly: null,
        firstMonth: null,
        single: -abs,
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="credit-note-${bid}.pdf"`,
    );
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("[credit-note-by-bid] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { creditNotePdfByBookingIdAction };
