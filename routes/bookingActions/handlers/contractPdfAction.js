const Customer = require("../../../models/Customer");
const Booking = require("../../../models/Booking");
const Offer = require("../../../models/Offer");

const { buildWeeklyContractPdf } = require("../../../utils/pdf");

const { requireOwner } = require("../helpers/provider");
const { requireIds } = require("../helpers/ids");

function safeText(v) {
  return String(v ?? "").trim();
}

function hasContractMeta(meta) {
  const signedAt = safeText(meta?.contractSignedAt);
  const html = safeText(meta?.contractSnapshot?.contractDoc?.contentHtml);
  return Boolean(signedAt && html);
}

async function contractPdfAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;

    const ids = requireIds(req, res);
    if (!ids) return;

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const embedded = customer.bookings.id(ids.bid);
    if (!embedded) return res.status(404).json({ error: "Booking not found" });

    const bookingDoc = await Booking.findOne({ _id: ids.bid, owner })
      .lean()
      .catch(() => null);

    const metaFromEmbedded =
      embedded?.meta && typeof embedded.meta === "object"
        ? embedded.meta
        : null;

    const metaFromDoc =
      bookingDoc?.meta && typeof bookingDoc.meta === "object"
        ? bookingDoc.meta
        : null;

    const meta = hasContractMeta(metaFromEmbedded)
      ? metaFromEmbedded
      : metaFromDoc;

    if (!hasContractMeta(meta)) {
      return res.status(404).json({ error: "Contract not found" });
    }

    const offerId =
      safeText(bookingDoc?.offerId) || safeText(embedded?.offerId);

    const offer = offerId
      ? await Offer.findById(offerId)
          .lean()
          .catch(() => null)
      : null;

    const bookingForPdf =
      bookingDoc || (embedded.toObject ? embedded.toObject() : embedded);

    const buf = await buildWeeklyContractPdf({
      booking: bookingForPdf,
      offer,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="contract-${ids.bid}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("[contract.pdf] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = { contractPdfAction };
