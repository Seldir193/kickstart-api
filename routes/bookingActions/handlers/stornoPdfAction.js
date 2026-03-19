//routes\bookingActions\handlers\stornoPdfAction.js
const Customer = require("../../../models/Customer");

const { buildStornoPdfHTML } = require("../../../utils/pdfHtml");

const { requireOwner } = require("../helpers/provider");
const { requireIds } = require("../helpers/ids");

async function stornoPdfAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const ids = requireIds(req, res);
    if (!ids) return;

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const amount =
      req.query.amount != null
        ? Number(req.query.amount)
        : Number(
            booking.stornoAmount ??
              booking.priceAtBooking ??
              booking.priceMonthly ??
              0,
          );

    const currency = req.query.currency
      ? String(req.query.currency)
      : booking.currency || "EUR";

    const buf = await buildStornoPdfHTML({
      customer: customer.toObject ? customer.toObject() : customer,
      booking: booking.toObject ? booking.toObject() : booking,
      offer: null,
      amount,
      currency,
      stornoNo: booking.stornoNo || booking.stornoNumber,
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
      `inline; filename="storno-${ids.bid}.pdf"`,
    );
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("[storno.pdf] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { stornoPdfAction };
