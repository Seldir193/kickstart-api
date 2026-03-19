//routes\bookingActions\handlers\stornoBookingAction.js
const Customer = require("../../../models/Customer");

const { buildStornoPdf } = require("../../../utils/pdf");
const { sendStornoEmail } = require("../../../utils/mailer");

const { requireOwner } = require("../helpers/provider");
const { requireIds } = require("../helpers/ids");

async function stornoBookingAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const ids = requireIds(req, res);
    if (!ids) return;

    const { note } = req.body || {};

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    booking.status = "cancelled";
    booking.cancelDate = new Date();
    booking.cancelReason = note ? `storno: ${note}` : "storno";

    await customer.save();

    (async () => {
      try {
        const pdf = await buildStornoPdf({
          customer: {
            parentFirst: customer.parent?.firstName,
            parentLast: customer.parent?.lastName,
            childFirst: customer.child?.firstName,
            childLast: customer.child?.lastName,
          },
          booking: {
            _id: booking._id,
            offerTitle: booking.offerTitle,
            type: booking.offerType,
            date: booking.date,
          },
          note,
        });

        await sendStornoEmail({
          customer: customer.toObject ? customer.toObject() : customer,
          booking: {
            _id: booking._id,
            offerTitle: booking.offerTitle,
            offerType: booking.offerType,
            date: booking.date,
          },
          pdfBuffer: pdf,
          note,
        });
      } catch (e) {
        console.warn("[storno] email/pdf failed:", e?.message || e);
      }
    })();

    res.json({ ok: true, booking });
  } catch (err) {
    console.error("[storno] error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { stornoBookingAction };
