"use strict";

const mongoose = require("mongoose");
const Customer = require("../../../../models/Customer");
const Offer = require("../../../../models/Offer");
const Booking = require("../../../../models/Booking");

function safeText(v) {
  return String(v ?? "").trim();
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

function metaObj(booking) {
  return booking?.meta && typeof booking.meta === "object" ? booking.meta : {};
}

function creditAmountAbs(booking, offer) {
  const meta = metaObj(booking);
  const n =
    typeof meta.creditNoteAmount === "number"
      ? meta.creditNoteAmount
      : typeof booking?.priceAtBooking === "number"
        ? booking.priceAtBooking
        : typeof offer?.price === "number"
          ? offer.price
          : 0;
  return Math.abs(Math.round(Number(n || 0) * 100) / 100);
}

async function creditNotePdf(
  req,
  res,
  requireOwner,
  requireId,
  buildParticipationPdf,
) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const id = requireId(req, res);
    if (!id) return;

    const bid = safeText(req.params.bid);
    if (!mongoose.isValidObjectId(bid))
      return res.status(400).json({ error: "Invalid booking id" });

    const customerDoc = await Customer.findOne({ _id: id, owner }).exec();
    if (!customerDoc)
      return res.status(404).json({ error: "Customer not found" });

    const bookingRef =
      customerDoc.bookings.id(bid) ||
      customerDoc.bookings.find(
        (b) =>
          String(b?.bookingId || "") === bid || String(b?._id || "") === bid,
      );

    if (!bookingRef) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const lookupId = bookingRef.bookingId || bookingRef._id || bid;

    const bookingDoc = await Booking.findOne({ _id: lookupId, owner }).exec();
    if (!bookingDoc)
      return res.status(404).json({ error: "Booking not found" });

    const offerDb = bookingDoc.offerId
      ? await Offer.findById(bookingDoc.offerId).lean()
      : bookingRef.offerId
        ? await Offer.findById(bookingRef.offerId).lean()
        : null;

    const offer = offerDb || offerLikeFromBooking(bookingDoc);

    const meta = metaObj(bookingDoc);
    const rawCreditNo = safeText(meta.creditNoteNo);
    if (!rawCreditNo) {
      return res.status(404).json({ error: "Credit note not found" });
    }

    const abs = creditAmountAbs(bookingDoc, offer);

    const creditNo = rawCreditNo;
    const creditDateIso =
      safeText(meta.creditNoteDate) ||
      bookingDoc.returnedAt ||
      new Date().toISOString();

    const bookingForPdf = {
      ...(bookingDoc.toObject ? bookingDoc.toObject() : bookingDoc),
      priceAtBooking: -abs,
    };

    const customer = customerDoc.toObject
      ? customerDoc.toObject()
      : customerDoc;

    const pdf = await buildParticipationPdf({
      customer,
      booking: bookingForPdf,
      offer,
      invoiceNo: creditNo,
      invoiceDate: creditDateIso,
      venue: bookingForPdf.venue || offer?.location || "",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="Gutschrift.pdf"');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { creditNotePdf };
