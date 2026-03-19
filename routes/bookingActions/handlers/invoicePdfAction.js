//routes\bookingActions\handlers\invoicePdfAction.js
const Customer = require("../../../models/Customer");

const {
  prorateForStart,
  nextPeriodStart,
  fmtAmount,
  normCurrency,
} = require("../../../utils/billing");

const { requireOwner } = require("../helpers/provider");
const { requireIds } = require("../helpers/ids");
const { resolveAmountsFromBookingRef } = require("../helpers/amounts");

async function invoicePdfAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const ids = requireIds(req, res);
    if (!ids) return;

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const resolved = await resolveAmountsFromBookingRef(booking);

    const currency = normCurrency(
      resolved.currency || booking.currency || "EUR",
    );

    const startISO = booking.date
      ? new Date(booking.date).toISOString().slice(0, 10)
      : booking.createdAt
        ? new Date(booking.createdAt).toISOString().slice(0, 10)
        : null;

    const queryMode = String(req.query.mode || "").toLowerCase();
    const queryType = String(req.query.type || "first").toLowerCase();
    const type = queryType === "recurring" ? "recurring" : "first";

    const hasWeeklySignals =
      booking.priceMonthly != null ||
      booking.priceFirstMonth != null ||
      booking.monthlyAmount != null ||
      booking.firstMonthAmount != null;

    const wantsOneOff =
      queryMode === "oneoff" ||
      (!hasWeeklySignals && typeof booking.priceAtBooking === "number");

    let invoiceDateISO = startISO;
    let amount = null;
    let invoiceTitle = booking.offerTitle || booking.offerType || "Rechnung";

    if (wantsOneOff) {
      amount =
        typeof booking.priceAtBooking === "number"
          ? Number(booking.priceAtBooking)
          : resolved.priceMonthly != null
            ? Number(resolved.priceMonthly)
            : null;

      if (!invoiceDateISO || amount == null) {
        return res
          .status(400)
          .json({ error: "Invoice data incomplete for this booking" });
      }
    } else {
      let priceMonthly =
        resolved.priceMonthly != null ? Number(resolved.priceMonthly) : null;

      let priceFirstMonth =
        resolved.priceFirstMonth != null
          ? Number(resolved.priceFirstMonth)
          : null;

      if (priceMonthly == null && typeof booking.priceAtBooking === "number") {
        priceMonthly = Number(booking.priceAtBooking);
      }

      if (!invoiceDateISO || priceMonthly == null) {
        return res
          .status(400)
          .json({ error: "Invoice data incomplete for this booking" });
      }

      if (priceFirstMonth == null) {
        priceFirstMonth = prorateForStart(
          invoiceDateISO,
          priceMonthly,
        ).firstMonthPrice;
      }

      if (type === "recurring") {
        invoiceDateISO = nextPeriodStart(invoiceDateISO);
        amount = priceMonthly;
        invoiceTitle =
          (booking.offerTitle || booking.offerType || "Subscription") +
          " – monthly";
      } else {
        amount = priceFirstMonth;
        invoiceTitle =
          booking.offerTitle ||
          booking.offerType ||
          "Subscription – first month";
      }

      if (!invoiceDateISO || amount == null) {
        return res
          .status(400)
          .json({ error: "Invoice data incomplete for this booking" });
      }
    }

    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ size: "A4", margin: 50 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="invoice-${wantsOneOff ? "oneoff" : type}-${ids.bid}.pdf"`,
    );

    doc.fontSize(20).text("Invoice", { align: "left" });
    doc.moveDown(0.5);
    doc
      .fontSize(10)
      .fillColor("#666")
      .text("KickStart Academy", { align: "right" })
      .text("Duisburg, NRW", { align: "right" })
      .text("info@kickstart-academy.de", { align: "right" })
      .fillColor("#000");

    doc.moveDown();

    const parentName =
      [customer.parent?.firstName, customer.parent?.lastName]
        .filter(Boolean)
        .join(" ") || "—";
    const childName =
      [customer.child?.firstName, customer.child?.lastName]
        .filter(Boolean)
        .join(" ") || "—";

    doc.fontSize(12).text(`Customer: ${parentName}`);
    doc.text(`Child: ${childName}`);
    doc.text(
      `Booking: ${booking.offerTitle || booking.offerType || booking._id}`,
    );
    doc.text(`Invoice date: ${invoiceDateISO}`);
    doc.moveDown();

    doc.text(`Description: ${invoiceTitle}`);
    doc.text(`Amount: ${fmtAmount(amount)} ${currency}`);

    doc.moveDown(2);
    doc
      .fontSize(10)
      .fillColor("#666")
      .text("This invoice is generated automatically.", { align: "center" })
      .fillColor("#000");

    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error("[invoice.pdf] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { invoicePdfAction };
