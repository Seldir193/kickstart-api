//routes\bookingActions\handlers\cancelBookingAction.js
const Customer = require("../../../models/Customer");

const { buildCancellationPdf } = require("../../../utils/pdf");
const { sendCancellationEmail } = require("../../../utils/mailer");

const { requireOwner } = require("../helpers/provider");
const { requireIds } = require("../helpers/ids");

async function cancelBookingAction(req, res) {
  try {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const ids = requireIds(req, res);
    if (!ids) return;

    const { date, reason } = req.body || {};
    const cancelAt = date ? new Date(date) : new Date();

    const customer = await Customer.findOne({ _id: ids.cid, owner });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const booking = customer.bookings.id(ids.bid);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    booking.status = "cancelled";
    booking.cancelDate = cancelAt;
    booking.cancelReason = String(reason || "");

    await customer.save();

    (async () => {
      try {
        const pdf = await buildCancellationPdf({
          parentFirst: customer.parent?.firstName,
          parentLast: customer.parent?.lastName,
          childFirst: customer.child?.firstName,
          childLast: customer.child?.lastName,
          cancelled: { date: cancelAt, reason },
        });

        await sendCancellationEmail({
          customer: customer.toObject ? customer.toObject() : customer,
          booking: {
            _id: booking._id,
            offerTitle: booking.offerTitle,
            offerType: booking.offerType,
            date: booking.date,
          },
          pdfBuffer: pdf,
          effectiveDateISO: date,
        });
      } catch (e) {
        console.warn("[cancel] email/pdf failed:", e?.message || e);
      }
    })();

    res.json({ ok: true, booking });
  } catch (err) {
    console.error("[cancel] error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

module.exports = { cancelBookingAction };

// //routes\bookingActions\handlers\cancelBookingAction.js
// const Customer = require("../../../models/Customer");

// const { buildCancellationPdf } = require("../../../utils/pdf");
// const { sendCancellationEmail } = require("../../../utils/mailer");

// const { requireOwner } = require("../helpers/provider");
// const { requireIds } = require("../helpers/ids");

// async function cancelBookingAction(req, res) {
//   try {
//     const owner = requireOwner(req, res);
//     if (!owner) return;
//     const ids = requireIds(req, res);
//     if (!ids) return;

//     const { date, reason } = req.body || {};
//     const cancelAt = date ? new Date(date) : new Date();

//     const customer = await Customer.findOne({ _id: ids.cid, owner });
//     if (!customer) return res.status(404).json({ error: "Customer not found" });

//     const booking = customer.bookings.id(ids.bid);
//     if (!booking) return res.status(404).json({ error: "Booking not found" });

//     booking.status = "cancelled";
//     booking.cancelDate = cancelAt;
//     booking.cancelReason = String(reason || "");

//     await customer.save();

//     (async () => {
//       try {
//         const pdf = await buildCancellationPdf({
//           parentFirst: customer.parent?.firstName,
//           parentLast: customer.parent?.lastName,
//           childFirst: customer.child?.firstName,
//           childLast: customer.child?.lastName,
//           cancelled: { date: cancelAt, reason },
//         });

//         await sendCancellationEmail({
//           customer: customer.toObject ? customer.toObject() : customer,
//           booking: {
//             _id: booking._id,
//             offerTitle: booking.offerTitle,
//             offerType: booking.offerType,
//             date: booking.date,
//           },
//           pdfBuffer: pdf,
//           effectiveDateISO: date,
//         });
//       } catch (e) {
//         console.warn("[cancel] email/pdf failed:", e?.message || e);
//       }
//     })();

//     res.json({ ok: true, booking });
//   } catch (err) {
//     console.error("[cancel] error:", err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// module.exports = { cancelBookingAction };
