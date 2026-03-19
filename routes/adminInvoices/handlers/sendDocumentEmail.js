// routes/adminInvoices/handlers/sendDocumentEmail.js
"use strict";

function makeSendDocumentEmailHandler(deps) {
  const {
    mongoose,
    Types,
    getModels,
    requireOwner,
    loadOwnedBooking,
    findCustomerAndBookingByBookingId,
    getMailer,
  } = deps;

  return async function sendDocumentEmailHandler(req, res) {
    try {
      const owner = requireOwner(req, res);
      if (!owner) return;

      const bookingId = String(req.params.bookingId || "").trim();
      if (!mongoose.isValidObjectId(bookingId)) {
        return res.status(400).json({ ok: false, error: "Invalid bookingId" });
      }

      const body = req.body || {};
      const docType = String(body.docType || "")
        .trim()
        .toLowerCase();

      if (!["participation", "storno", "cancellation"].includes(docType)) {
        return res.status(400).json({ ok: false, error: "Invalid docType" });
      }

      const { Customer, Booking } = getModels(req);

      const booking = await loadOwnedBooking({
        Booking,
        owner,
        bookingId: new Types.ObjectId(bookingId),
      });

      if (!booking) {
        return res.status(404).json({ ok: false, error: "Booking not found" });
      }

      const { customer, bookingRef } = await findCustomerAndBookingByBookingId({
        Customer,
        owner,
        bookingId: booking._id,
      });

      if (!customer) {
        return res.status(404).json({
          ok: false,
          error: "Customer for booking not found",
        });
      }

      const mergedBooking = {
        ...(booking.toObject ? booking.toObject() : booking),
        ...(bookingRef || {}),
      };

      const toEmail = String(
        body.toEmail ||
          customer?.parent?.email ||
          mergedBooking?.email ||
          booking?.email ||
          "",
      ).trim();

      if (!toEmail) {
        return res.status(400).json({ ok: false, error: "No recipient email" });
      }

      const Offer =
        req.app?.locals?.models?.Offer || require("../../../models/Offer");

      let offer = null;
      const offerId = mergedBooking?.offerId || booking?.offerId || null;

      if (offerId && mongoose.isValidObjectId(String(offerId))) {
        offer = await Offer.findOne({
          _id: new Types.ObjectId(String(offerId)),
        }).lean();
      }

      const mailer = getMailer();

      if (docType === "participation") {
        await mailer.sendParticipationEmail({
          to: toEmail,
          customer,
          booking: mergedBooking,
          offer,
        });
      }

      if (docType === "storno") {
        const amount = Number.isFinite(Number(mergedBooking?.stornoAmount))
          ? Number(mergedBooking.stornoAmount)
          : Number.isFinite(Number(booking?.stornoAmount))
            ? Number(booking.stornoAmount)
            : Number.isFinite(Number(mergedBooking?.priceAtBooking))
              ? Number(mergedBooking.priceAtBooking)
              : 0;

        const currency = String(
          mergedBooking?.currency || booking?.currency || "EUR",
        );

        await mailer.sendStornoEmail({
          to: toEmail,
          customer,
          booking: mergedBooking,
          offer,
          amount,
          currency,
        });
      }

      if (docType === "cancellation") {
        await mailer.sendCancellationEmail({
          to: toEmail,
          customer,
          booking: mergedBooking,
          offer,
        });
      }

      return res.json({
        ok: true,
        bookingId: String(booking._id),
        docType,
        toEmail,
      });
    } catch (err) {
      console.error(
        "[adminInvoices] POST /:bookingId/send-document-email error:",
        err,
      );
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  };
}

module.exports = { makeSendDocumentEmailHandler };
